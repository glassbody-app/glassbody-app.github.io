#!/usr/bin/env python3
"""Fold a Health Auto Export zip into the dashboard's stored history.

    python3 ingest.py NEW_EXPORT.zip [MORE.zip ...] [--out PATH]
                      [--store OTHER.json] [--fresh]

New exports are merged into the --out file when it exists, or into --store
when given; --fresh starts from an empty store. --out defaults to
~/glassbody/health.json, outside the repo, because a static server run in
the repo folder publishes every file in it.

Each export is a rolling window that overlaps the last, so records are merged by
key and the newer file wins on a collision. Nothing is ever dropped.

It also checks for the aggregation bug that ruined the first export: if the app
is set to Average rather than Sum, cumulative metrics come through ~1000x too
small (0.058 steps for a day). That is caught here rather than discovered on
the page, and the export is refused: nothing is written.
"""
import argparse, csv, io, json, math, os, re, sys, zipfile, zlib
from datetime import datetime, timezone

DEFAULT_OUT = os.path.join("~", "glassbody", "health.json")
KJ = 4.184
KM_MI = 0.621371
AVERAGED = ("Cumulative metrics look averaged, not summed (most days under 100 "
            "steps). Set the export's aggregation to Sum and export again.")


# Size limits, checked before anything is read, the same in js/ingest.js. Real
# exports are far smaller: the daily file is one row per day.
MB = 1000000
LIMITS = {"zip": 500 * MB, "file": 50 * MB, "total": 200 * MB}
# the files either parser reads; their summed size is what LIMITS["total"] caps
READ = [re.compile(p) for p in (
    r"^HealthAutoExport-.*\.csv$", r"^Workouts-.*\.csv$", r"^.*-(Heart Rate|Route)-.*\.csv$",
    r"^Medications-.*\.csv$", r"^HeartRateNotifications-.*\.csv$", r"^ECG-.*\.csv$")]
# One field-size rule for both parsers: a cell may be as long as its file. The
# csv module's own default (131072 characters) refused cells the browser read.
csv.field_size_limit(LIMITS["file"])


class AggregationError(ValueError):
    """The export was made with aggregation set to Average, not Sum."""


class TooLargeError(ValueError):
    """The zip, one file read from it, or all of those together are over LIMITS."""


class UnreadableError(ValueError):
    """A member is encrypted or packed with a method other than stored or deflate."""


# JSZip refuses the whole zip when any member is like that, so this does too
UNREADABLE = "The zip uses compression or encryption this page cannot read."


def mb(n):
    """Format a byte count as whole megabytes, rounded up, as js/ingest.js does."""
    return "%d MB" % math.ceil(n / MB)


def index_zip(zf):
    """Map each file's basename to its entry name and check the sizes it declares.

    The first entry with a basename wins, in zip order, as in js/ingest.js.
    Folders, __MACOSX and macOS resource forks (._name) are skipped. When one
    path appears twice, zf.open() and JSZip both give the last copy, so that
    is the copy whose size is checked.

    Args:
        zf: an open zipfile.ZipFile.

    Returns:
        A dict of basename to entry name.

    Raises:
        UnreadableError: when any member is encrypted or not stored or deflated.
        TooLargeError: when a file that would be read, or all of them, is over LIMITS.
    """
    if any(i.flag_bits & 0x1 or i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
           for i in zf.infolist()):
        raise UnreadableError(UNREADABLE)
    files, total, seen = {}, 0, set()
    for info in zf.infolist():
        if info.filename in seen:
            continue
        seen.add(info.filename)
        info = zf.getinfo(info.filename)
        parts = info.filename.split("/")
        if info.is_dir() or "__MACOSX" in parts[:-1]:
            continue
        name = parts[-1]
        if name.startswith("._") or name in files:
            continue
        files[name] = info.filename
        if not any(rx.match(name) for rx in READ):
            continue
        if info.file_size > LIMITS["file"]:
            raise TooLargeError("%s unpacks to %s; the limit for one file is %s."
                                % (name, mb(info.file_size), mb(LIMITS["file"])))
        total += info.file_size
    if total > LIMITS["total"]:
        raise TooLargeError("The CSV files in the zip unpack to %s; the limit is %s. "
                            "Export a shorter date range." % (mb(total), mb(LIMITS["total"])))
    return files


def open_text(zf, entry):
    """Open one zip entry as text without unpacking it to disk.

    A BOM is dropped. Bytes that are not UTF-8 become U+FFFD, which is what the
    browser's TextDecoder does, so both parsers read the same text.

    Args:
        zf: an open zipfile.ZipFile.
        entry: the entry name.

    Returns:
        A text stream with newlines left as they are, for the csv module.
    """
    return io.TextIOWrapper(zf.open(entry), encoding="utf-8-sig", errors="replace", newline="")


def read_csv(zf, entry):
    """Yield each row of a CSV with a header row as a dict, one at a time."""
    with open_text(zf, entry) as f:
        yield from csv.DictReader(f)


def read_rows(zf, entry):
    """Yield each row of a key/value CSV (no header) as a list, one at a time."""
    with open_text(zf, entry) as f:
        yield from csv.reader(f)


def num(v):
    """Parse a cell as a finite float; blank or unparseable is None, never 0."""
    if v in (None, ""):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def minutes(dur):
    """Turn an H:MM:SS duration into minutes; blank or any other shape is None."""
    p = (dur or "").split(":")
    if len(p) != 3 or not all(v.strip().isdigit() for v in p):
        return None
    h, m, s = (int(v) for v in p)
    return round(h * 60 + m + s / 60, 1)


def r(v, n=2):
    """Round v to n places, passing None through."""
    return None if v is None else round(v, n)


# ---------------------------------------------------------------- one export
def parse_export(zf):
    """Pull everything we use out of one export zip.

    Args:
        zf: an open zipfile.ZipFile.

    Returns:
        A dict of collections keyed by merge key, plus a list of warnings.

    Raises:
        UnreadableError: when a member is encrypted or uses another method.
        TooLargeError: when the zip's files are over LIMITS; nothing is read then.
        AggregationError: when the export was made with Average, not Sum.
        zipfile.BadZipFile: when a member fails its checksum.
        zlib.error: when a member's deflate stream is corrupt.
        csv.Error: when a CSV cannot be parsed.
    """
    files = index_zip(zf)

    def find(pattern):
        """Return paths of files whose name matches pattern."""
        rx = re.compile(pattern)
        return [p for n, p in files.items() if rx.match(n)]

    out = {"daily": {}, "walks": {}, "meds": {}, "nutrition": {},
           "alerts": {}, "ecgs": {}, "warnings": []}
    NUT = [("Dietary Energy (kJ)", "energyKcal", lambda v: round(v / KJ)),
           ("Carbohydrates (g)", "carbsG", lambda v: round(v, 1)),
           ("Protein (g)", "proteinG", lambda v: round(v, 1)),
           ("Total Fat (g)", "fatG", lambda v: round(v, 1)),
           ("Saturated Fat (g)", "satFatG", lambda v: round(v, 1)),
           ("Fiber (g)", "fiberG", lambda v: round(v, 1)),
           ("Sugar (g)", "sugarG", lambda v: round(v, 1)),
           ("Sodium (mg)", "sodiumMg", lambda v: round(v)),
           ("Potassium (mg)", "potassiumMg", lambda v: round(v)),
           ("Calcium (mg)", "calciumMg", lambda v: round(v)),
           ("Cholesterol (mg)", "cholesterolMg", lambda v: round(v)),
           ("Iron (mg)", "ironMg", lambda v: round(v, 1)),
           ("Water (mL)", "waterMl", lambda v: round(v))]

    # ---- daily metrics -------------------------------------------------
    main = find(r"^HealthAutoExport-.*\.csv$")
    if not main:
        out["warnings"].append("No HealthAutoExport-*.csv found; daily metrics skipped.")
    else:
        COLS = {
            "steps": "Step Count (count)",
            "miles": "Walking + Running Distance (km)",
            "activeKcal": "Active Energy (kJ)",
            "restingKcal": "Resting Energy (kJ)",
            "exerciseMin": "Apple Exercise Time (min)",
            "standHours": "Apple Stand Hour (count)",
            "flights": "Flights Climbed (count)",
            "daylightMin": "Time in Daylight (min)",
            "restingHr": "Resting Heart Rate (count/min)",
            "walkingHr": "Walking Heart Rate Average (count/min)",
            "hrv": "Heart Rate Variability (ms)",
            "recoveryHrv": "Recovery HRV (ms)",
            "cardioRecovery": "Cardio Recovery (count/min)",
            "spo2": "Blood Oxygen Saturation (%)",
            "respRate": "Respiratory Rate (count/min)",
            "vo2max": "VO2 Max (ml/(kg·min))",
            "weightKg": "Weight (kg)",
            "bmi": "Body Mass Index (count)",
            "walkKmh": "Walking Speed (km/hr)",
            "stepLenCm": "Walking Step Length (cm)",
            "walkAsym": "Walking Asymmetry Percentage (%)",
            "walkDbl": "Walking Double Support Percentage (%)",
            "envAudio": "Environmental Audio Exposure (dBASPL)",
            "headphoneAudio": "Headphone Audio Exposure (dBASPL)",
            "sleepTotal": "Sleep Analysis [Total] (hr)",
            "sleepCore": "Sleep Analysis [Core] (hr)",
            "sleepDeep": "Sleep Analysis [Deep] (hr)",
            "sleepRem": "Sleep Analysis [REM] (hr)",
            "sleepAwake": "Sleep Analysis [Awake] (hr)",
        }
        # one pass over the daily file gives both daily metrics and food
        for row in read_csv(zf, sorted(main)[-1]):
            date = (row.get("Date/Time") or "")[:10]
            if not date:
                continue
            vals = {k: fn(num(row.get(c))) for c, k, fn in NUT if num(row.get(c)) is not None}
            if vals:
                vals["date"] = date
                out["nutrition"][date] = vals
            g = lambda k: num(row.get(COLS[k]))
            km, ws, sl = g("miles"), g("walkKmh"), g("stepLenCm")
            ae, re_, wt = g("activeKcal"), g("restingKcal"), g("weightKg")
            out["daily"][date] = {
                "date": date,
                "steps": r(g("steps"), 0),
                "miles": r(km * KM_MI, 3) if km is not None else None,
                "activeKcal": r(ae / KJ, 0) if ae is not None else None,
                "restingKcal": r(re_ / KJ, 0) if re_ is not None else None,
                "exerciseMin": r(g("exerciseMin")),
                "standHours": r(g("standHours"), 0),
                "flights": r(g("flights")),
                "daylightMin": r(g("daylightMin")),
                "restingHr": r(g("restingHr")),
                "walkingHr": r(g("walkingHr")),
                "hrv": r(g("hrv")),
                "recoveryHrv": r(g("recoveryHrv")),
                "cardioRecovery": r(g("cardioRecovery")),
                "spo2": r(g("spo2")),
                "respRate": r(g("respRate")),
                "vo2max": r(g("vo2max")),
                "weightLb": r(wt * 2.20462, 1) if wt is not None else None,
                "bmi": r(g("bmi")),
                "walkMph": r(ws * KM_MI, 2) if ws is not None else None,
                "stepLenIn": r(sl / 2.54, 1) if sl is not None else None,
                "walkAsym": r(g("walkAsym")),
                "walkDbl": r(g("walkDbl")),
                "envAudio": r(g("envAudio")),
                "headphoneAudio": r(g("headphoneAudio")),
                "sleepTotal": r(g("sleepTotal")),
                "sleepCore": r(g("sleepCore")),
                "sleepDeep": r(g("sleepDeep")),
                "sleepRem": r(g("sleepRem")),
                "sleepAwake": r(g("sleepAwake")),
            }

        # the Average-instead-of-Sum trap; a day that rounds to 0 steps counts too
        steps = [v["steps"] for v in out["daily"].values() if v["steps"] is not None]
        if steps and sum(1 for s in steps if s < 100) > len(steps) * 0.6:
            raise AggregationError(AVERAGED)

    # ---- workouts ------------------------------------------------------
    wf = find(r"^Workouts-.*\.csv$")
    if wf:
        for x in read_csv(zf, sorted(wf)[-1]):
            start = x.get("Start") or ""
            if not start:
                continue
            dist_mi = num(x.get("Distance (mi)"))
            if dist_mi is None:
                km = num(x.get("Distance (km)"))
                dist_mi = km * KM_MI if km is not None else None
            mph = num(x.get("Avg. Speed (mi/hr)"))
            if mph is None:
                kmh = num(x.get("Avg. Speed (km/hr)"))
                mph = kmh * KM_MI if kmh is not None else None
            mphmax = num(x.get("Max. Speed (mi/hr)"))
            if mphmax is None:
                kmh = num(x.get("Max. Speed (km/hr)"))
                mphmax = kmh * KM_MI if kmh is not None else None
            tf = num(x.get("Temperature (degF)"))
            if tf is None:
                tc = num(x.get("Temperature (degC)"))
                tf = tc * 9 / 5 + 32 if tc is not None else None
            ae = num(x.get("Active Energy (kJ)"))
            asc = num(x.get("Elevation Ascended (m)"))
            out["walks"][start] = {
                "id": start, "date": start[:10], "time": start[11:16],
                "type": x.get("Workout Type") or "Workout",
                "durMin": minutes(x.get("Duration")),
                "miles": r(dist_mi, 2), "mphAvg": r(mph, 2), "mphMax": r(mphmax, 2),
                "steps": r(num(x.get("Step Count")), 0),
                "cadence": r(num(x.get("Step Cadence (spm)")), 0),
                "kcal": r(ae / KJ, 0) if ae is not None else None,
                "hrAvg": r(num(x.get("Avg. Heart Rate (count/min)")), 0),
                "hrMax": r(num(x.get("Max. Heart Rate (count/min)")), 0),
                "flights": r(num(x.get("Flights Climbed")), 0),
                "ascentFt": round(asc * 3.28084) if asc is not None else None,
                "tempF": r(tf, 0),
                "humidity": r(num(x.get("Humidity (%)")), 0),
                "hr": [], "route": [],
            }

        def detail(kind, start):
            """Return the paths of one workout's detail files of this kind.

            The stamp with seconds tells apart two workouts started in the
            same minute; the 13-character minute stamp is the fallback.
            """
            full = start.replace("-", "").replace(":", "").replace(" ", "_")
            for st in (full[:15], full[:13]):
                hit = [p for n, p in files.items()
                       if re.match(r"^.*-" + kind + "-" + re.escape(st) + r".*\.csv$", n)]
                if hit:
                    return hit
            return []

        for start, w in out["walks"].items():
            hr = detail("Heart Rate", start)
            if hr:
                w["hr"] = [round(v) for v in
                           (num(x.get("Avg (count/min)")) for x in read_csv(zf, hr[0]))
                           if v is not None]
            rt = detail("Route", start)
            if rt:
                # thinning needs the count first, so keep only the two cells per point
                pts = [(p.get("Latitude"), p.get("Longitude")) for p in read_csv(zf, rt[0])]
                step = max(1, len(pts) // 70)
                keep = pts[::step] + ([pts[-1]] if pts and len(pts) % step else [])
                w["route"] = [[round(num(lat), 5), round(num(lon), 5)]
                              for lat, lon in keep
                              if num(lat) is not None and num(lon) is not None]

    # ---- medication ----------------------------------------------------
    # The store keys a dose by minute, so two doses of one medicine logged in the
    # same minute get seq 1, 2, ... in file order. A dose is the same dose when
    # its logged time, scheduled time, medicine and dosage all match; its status
    # may differ between overlapping files. Files go newest name first so the
    # newer status wins, in the same order js/ingest.js uses.
    seen, per_minute = set(), {}
    meds_files = sorted(find(r"^Medications-.*\.csv$"),
                        key=os.path.basename, reverse=True)
    for p in meds_files:
        for m in read_csv(zf, p):
            when = m.get("Date") or ""
            exact = "|".join([when, m.get("Scheduled Date") or "",
                              m.get("Medication") or "", m.get("Dosage") or ""])
            if exact in seen:
                continue
            seen.add(exact)
            dose = {"date": when[:10], "time": when[11:16],
                    "name": m.get("Nickname") or m.get("Medication"),
                    "med": m.get("Medication"), "dose": m.get("Dosage"),
                    "status": m.get("Status")}
            minute = med_key(dose)
            per_minute[minute] = per_minute.get(minute, 0) + 1
            if per_minute[minute] > 1:
                dose["seq"] = per_minute[minute]
            out["meds"][med_key(dose)] = dose

    # ---- heart alerts and ECG -------------------------------------------
    for p in find(r"^HeartRateNotifications-.*\.csv$"):
        cur = None
        for row in read_rows(zf, p):
            if not row or not row[0]:
                continue
            k = row[0]
            if k == "Type":
                cur = {"kind": row[1], "peak": None, "threshold": None}
            elif cur is None:
                continue
            elif k == "Start" and "when" not in cur:
                cur["when"] = row[1][:16]
                cur["date"] = row[1][:10]
            elif k == "Heart Rate Threshold count/min":
                t = num(row[1])
                cur["threshold"] = int(t) if t is not None else None
            elif k == "Heart Rate (count/min)":
                vs = [num(v) for v in row[1:]]
                vs = [v for v in vs if v is not None]
                cur["peak"] = round(max(vs)) if vs else None
                if cur.get("when"):
                    out["alerts"][cur["when"]] = cur

    for p in find(r"^ECG-.*\.csv$"):
        kv = {}
        for row in read_rows(zf, p):
            if len(row) >= 2 and row[0]:
                kv[row[0]] = row[1]
        if kv.get("Start"):
            out["ecgs"][kv["Start"][:16]] = {
                "when": kv["Start"][:16], "date": kv["Start"][:10],
                "class": kv.get("Classification"),
                "bpm": r(num(kv.get("Avg. Heart Rate (count/min)")), 0),
                "hz": num(kv.get("Sampling Frequency (Hz)")),
                "samples": kv.get("Number of Voltage Measurements")}
    return out


def parse_zip(path):
    """Open one export zip and parse it, refusing a zip over the size limit.

    Args:
        path: the zip's path.

    Returns:
        What parse_export returns.

    Raises:
        TooLargeError: when the zip or its files are over LIMITS.
        zipfile.BadZipFile: when the file is not a zip (its message is replaced
            with the one js/ingest.js shows), when a member name flagged as
            UTF-8 is not, or when a member fails its checksum.
        OSError: when the file cannot be read.
        Everything parse_export raises.
    """
    size = os.path.getsize(path)
    if size > LIMITS["zip"]:
        raise TooLargeError("The zip is %s; the limit is %s. Export a shorter date range."
                            % (mb(size), mb(LIMITS["zip"])))
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise zipfile.BadZipFile("This is not a zip file.") from None
    except UnicodeDecodeError:
        # zipfile cannot open such a zip at all; JSZip reads it, so the two differ here
        raise zipfile.BadZipFile("A file name in the zip is marked UTF-8 but is not.") from None
    with zf:
        return parse_export(zf)


# ---------------------------------------------------------------- merge
def med_key(m):
    """Return a dose's merge key: minute, medicine, and its seq when above 1.

    Doses stored before seq existed have none and keep the key they had. A
    later export that lacks the first of two same-minute doses numbers the
    other as seq 1, so it would replace the stored first dose; no export seen
    so far drops a dose that way.

    Args:
        m: a dose record with "date", "time", "med" and optionally "seq".

    Returns:
        The key string, e.g. "2026-08-02 12:30|Fictivol#2".
    """
    seq = m.get("seq") or 1
    return (m["date"] + " " + m["time"] + "|" + (m.get("med") or "")
            + ("#%d" % seq if seq > 1 else ""))


def to_store(parsed_list, store):
    """Fold parsed exports into the store. Later files win on a collision."""
    idx = {
        "daily": {d["date"]: d for d in store.get("daily", [])},
        "walks": {w["id"]: w for w in store.get("walks", [])},
        "meds": {med_key(m): m for m in store.get("meds", [])},
        "nutrition": {n["date"]: n for n in store.get("nutrition", [])},
        "alerts": {a["when"]: a for a in store.get("alerts", [])},
        "ecgs": {e["when"]: e for e in store.get("ecgs", [])},
    }
    before = {k: len(v) for k, v in idx.items()}
    for p in parsed_list:
        idx["daily"].update(p["daily"])
        idx["walks"].update(p["walks"])
        idx["nutrition"].update(p["nutrition"])
        idx["alerts"].update(p["alerts"])
        idx["ecgs"].update(p["ecgs"])
        for m in p["meds"].values():
            idx["meds"][med_key(m)] = m

    daily = sorted(idx["daily"].values(), key=lambda d: d["date"])
    out = {
        "meta": {"start": daily[0]["date"] if daily else None,
                 "end": daily[-1]["date"] if daily else None,
                 "days": len(daily),
                 "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M") + "Z"},
        "daily": daily,
        "walks": sorted(idx["walks"].values(), key=lambda w: w["id"]),
        "meds": sorted(idx["meds"].values(), key=lambda m: m["date"] + m["time"]),
        "nutrition": sorted(idx["nutrition"].values(), key=lambda n: n["date"]),
        "alerts": sorted(idx["alerts"].values(), key=lambda a: a["when"]),
        "ecgs": sorted(idx["ecgs"].values(), key=lambda e: e["when"]),
    }
    added = {k: len(idx[k]) - before.get(k, 0) for k in idx}
    return out, before, added


def main():
    """Parse each zip, refuse on an averaged export, else merge and write the store."""
    ap = argparse.ArgumentParser()
    ap.add_argument("zips", nargs="+")
    ap.add_argument("--store", default=None,
                    help="store to merge into (default: the --out file, if it exists)")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="store to write (default: %(default)s)")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore any existing store and write only these exports")
    a = ap.parse_args()
    a.out = os.path.expanduser(a.out)
    if a.store:
        a.store = os.path.expanduser(a.store)

    store = {}
    source = None if a.fresh else (a.store or a.out)
    if source and os.path.exists(source):
        try:
            with open(source) as f:
                store = json.load(f)
        except json.JSONDecodeError:
            print("%s is not a readable store. Pass --fresh to replace it, or --store "
                  "to merge from another file. Nothing was written." % source)
            return 1

    parsed, warnings = [], []
    for z in a.zips:
        try:
            p = parse_zip(z)
        except (AggregationError, TooLargeError, UnreadableError, zipfile.BadZipFile,
                zlib.error, csv.Error, OSError, EOFError) as e:
            # library messages carry no full stop of their own
            reason = str(e).rstrip()
            if not reason.endswith("."):
                reason += "."
            print("refused %s: %s Nothing was written." % (os.path.basename(z), reason))
            return 2
        warnings += [os.path.basename(z) + ": " + w for w in p["warnings"]]
        parsed.append(p)
        print("read %-42s days=%-4d walks=%-3d meds=%-3d alerts=%d"
              % (os.path.basename(z), len(p["daily"]), len(p["walks"]),
                 len(p["meds"]), len(p["alerts"])))

    merged, before, added = to_store(parsed, store)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(merged, f, separators=(",", ":"))

    print("\nstore: %s -> %s  (%s)"
          % (before.get("daily", 0), merged["meta"]["days"], merged["meta"]["updated"]))
    print("wrote: %s" % a.out)
    print("range: %s -> %s" % (merged["meta"]["start"], merged["meta"]["end"]))
    for k in ("daily", "walks", "meds", "nutrition", "alerts", "ecgs"):
        print("  %-10s %4d total  (+%d new)" % (k, len(merged[k]), added.get(k, 0)))
    print("  %-10s %4d KB" % ("file", os.path.getsize(a.out) // 1024))
    if warnings:
        print("\nWARNINGS")
        for w in warnings:
            print("  ! " + w)
    return 1 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
