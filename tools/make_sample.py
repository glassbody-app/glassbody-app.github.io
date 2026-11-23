#!/usr/bin/env python3
"""Write invented demo data and synthetic Health Auto Export zips.

    python3 tools/make_sample.py

Every value comes from a seeded random generator, so the output is the same on
every run and describes nobody. Medication names are invented and every GPS
track circles a point in the open Atlantic.

Outputs, relative to the repo root:

    data/sample.json                   45 days in store shape, for "Load sample"
    test/fixtures/sample-summed.zip    31 days exported with aggregation = Sum
    test/fixtures/sample-averaged.zip  the same 31 days with aggregation = Average,
                                       which both ingesters must refuse

The zips use the manual-export layout in docs/architecture.md §3: a daily CSV
in km and kJ, a workouts CSV in miles and degrees F, per-workout heart rate and route
files named with the start stamp, and key/value files for heart rate
notifications and ECG. sample.json is built by running the summed form of its
45 days through tools/ingest.py, so it has exactly the shape an import gives.
"""
import csv
import io
import json
import math
import os
import random
import sys
import zipfile
from datetime import date, datetime, timedelta

import ingest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE_PATH = os.path.join(ROOT, "data", "sample.json")
FIXTURE_DIR = os.path.join(ROOT, "test", "fixtures")

# fixed so the zips are byte-identical between runs
ZIP_TIME = (2026, 10, 2, 0, 0, 0)
SAMPLE_UPDATED = "2026-10-26 21:00Z"

# open water, about 400 km from the nearest rock
ORIGIN = (4.3172, -27.6240)

# name, nickname, dosage, scheduled time
MEDS = [
    ("Examplamine", "Morning", "1 tablet, 10 mg", "08:00"),
    ("Placebocin", "", "250 mg", "20:00"),
    ("Fictivol", "Lunch drops", "2 drops", "12:30"),
]
STATUSES = ["Taken"] * 8 + ["Skipped", "Not Interacted"]

SAMPLE = {"seed": 45045, "start": date(2026, 9, 12), "days": 45,
          "walks": 14, "doses": 60, "alerts": 5, "ecgs": 2}
FIXTURE = {"seed": 31031, "start": date(2026, 8, 1), "days": 31,
           "walks": 12, "doses": 25, "alerts": 4, "ecgs": 1}

DAILY_COLUMNS = [
    "Date/Time", "Active Energy (kJ)", "Apple Exercise Time (min)",
    "Apple Stand Hour (count)", "Apple Stand Time (min)",
    "Blood Oxygen Saturation (%)", "Body Mass Index (count)",
    "Calcium (mg)", "Carbohydrates (g)", "Cardio Recovery (count/min)",
    "Cholesterol (mg)", "Dietary Energy (kJ)", "Environmental Audio Exposure (dBASPL)",
    "Fiber (g)", "Flights Climbed (count)", "Handwashing (s)",
    "Headphone Audio Exposure (dBASPL)", "Heart Rate [Min] (count/min)",
    "Heart Rate [Max] (count/min)", "Heart Rate [Avg] (count/min)",
    "Heart Rate Variability (ms)", "Iron (mg)", "Mindful Minutes (min)",
    "Potassium (mg)", "Protein (g)", "Recovery HRV (ms)", "Resting Energy (kJ)",
    "Resting Heart Rate (count/min)", "Respiratory Rate (count/min)",
    "Saturated Fat (g)", "Sleep Analysis [Total] (hr)", "Sleep Analysis [Asleep] (hr)",
    "Sleep Analysis [In Bed] (hr)", "Sleep Analysis [Core] (hr)",
    "Sleep Analysis [Deep] (hr)", "Sleep Analysis [REM] (hr)",
    "Sleep Analysis [Awake] (hr)", "Sodium (mg)", "Step Count (count)", "Sugar (g)",
    "Time in Daylight (min)", "Total Fat (g)", "VO2 Max (ml/(kg·min))",
    "Walking + Running Distance (km)", "Walking Asymmetry Percentage (%)",
    "Walking Double Support Percentage (%)", "Walking Heart Rate Average (count/min)",
    "Walking Speed (km/hr)", "Walking Step Length (cm)", "Water (mL)", "Weight (kg)",
]
# cumulative metrics; Average aggregation shrinks these by roughly a thousand
CUMULATIVE = {
    "Active Energy (kJ)", "Apple Exercise Time (min)", "Apple Stand Hour (count)",
    "Flights Climbed (count)", "Resting Energy (kJ)", "Step Count (count)",
    "Time in Daylight (min)", "Walking + Running Distance (km)",
    "Dietary Energy (kJ)", "Carbohydrates (g)", "Protein (g)", "Total Fat (g)",
    "Saturated Fat (g)", "Fiber (g)", "Sugar (g)", "Sodium (mg)", "Potassium (mg)",
    "Calcium (mg)", "Cholesterol (mg)", "Iron (mg)", "Water (mL)",
}
WORKOUT_COLUMNS = [
    "Workout Type", "Start", "End", "Duration", "Total Energy (kJ)",
    "Active Energy (kJ)", "Max. Heart Rate (count/min)", "Avg. Heart Rate (count/min)",
    "Distance (mi)", "Avg. Speed (mi/hr)", "Max. Speed (mi/hr)", "Step Count",
    "Step Cadence (spm)", "Flights Climbed", "Elevation Ascended (m)",
    "Elevation Descended (m)", "Temperature (degF)", "Humidity (%)",
    "Intensity (kcal/hr·kg)",
]
ROUTE_COLUMNS = ["Date/Time", "Latitude", "Longitude", "Altitude (m)", "Course (°)",
                 "Horizontal Accuracy (m)", "Vertical Accuracy (m)", "Speed (m/s)"]


def fmt(v, digits):
    """Format a number for a CSV cell.

    Args:
        v: the value, or None for a blank cell.
        digits: decimal places.

    Returns:
        The formatted string, or '' when v is None.
    """
    return "" if v is None else "%.*f" % (digits, v)


def to_csv(header, rows):
    """Render rows as CSV text with LF line endings (docs/architecture.md §4.3).

    Args:
        header: the header row, or None for key/value files.
        rows: a list of lists of cell strings.

    Returns:
        The CSV text.
    """
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    if header:
        w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def stamp(t):
    """Return the detail-file stamp for a start time, as in 20261027_110942.

    Args:
        t: the workout start as a datetime.

    Returns:
        The stamp string.
    """
    return t.strftime("%Y%m%d_%H%M%S")


def make_daily(rng, days, averaged):
    """Invent one daily row per day, in the export's units (km, kJ, kg, cm).

    Args:
        rng: the seeded random.Random.
        days: the list of dates.
        averaged: True to shrink cumulative metrics as Average aggregation does.

    Returns:
        (header, rows, nutrition_days) where nutrition_days counts days with food.
    """
    rows, food_days = [], 0
    # its own generator, so both versions of an export share every other value
    shrink = random.Random(len(days))
    for d in days:
        steps = rng.randint(3800, 14500)
        sleep_deep = rng.uniform(0.6, 1.4)
        sleep_rem = rng.uniform(1.1, 2.1)
        sleep_total = rng.uniform(5.6, 8.3)
        weighed = rng.random() < 0.3
        v = {
            "Step Count (count)": (steps, 0),
            "Walking + Running Distance (km)": (steps * rng.uniform(0.00072, 0.00080), 3),
            "Active Energy (kJ)": (rng.uniform(260, 720) * ingest.KJ, 3),
            "Resting Energy (kJ)": (rng.uniform(1560, 1720) * ingest.KJ, 3),
            "Apple Exercise Time (min)": (rng.randint(8, 75), 0),
            "Apple Stand Hour (count)": (rng.randint(8, 14), 0),
            "Flights Climbed (count)": (rng.randint(2, 22), 0),
            "Time in Daylight (min)": (rng.randint(12, 140), 0),
            "Resting Heart Rate (count/min)": (rng.uniform(53, 64), 0),
            "Walking Heart Rate Average (count/min)": (rng.uniform(94, 116), 1),
            "Heart Rate Variability (ms)": (rng.uniform(28, 62), 3),
            "Recovery HRV (ms)": (rng.uniform(30, 70), 2) if rng.random() < 0.4 else None,
            "Cardio Recovery (count/min)": (rng.uniform(22, 34), 2) if rng.random() < 0.3 else None,
            "Blood Oxygen Saturation (%)": (rng.uniform(94.5, 99), 2),
            "Respiratory Rate (count/min)": (rng.uniform(13, 16.5), 2),
            "VO2 Max (ml/(kg·min))": (rng.uniform(38, 42.5), 2) if rng.random() < 0.2 else None,
            "Weight (kg)": (rng.uniform(77.5, 80.5), 2) if weighed else None,
            "Body Mass Index (count)": (rng.uniform(24.1, 24.9), 2) if weighed else None,
            "Walking Speed (km/hr)": (rng.uniform(4.5, 5.5), 3),
            "Walking Step Length (cm)": (rng.uniform(67, 77), 1),
            "Walking Asymmetry Percentage (%)": (rng.uniform(0, 4.5), 1) if rng.random() < 0.7 else None,
            "Walking Double Support Percentage (%)": (rng.uniform(25.5, 31), 1),
            "Environmental Audio Exposure (dBASPL)": (rng.uniform(64, 79), 3),
            "Headphone Audio Exposure (dBASPL)": (rng.uniform(58, 76), 3) if rng.random() < 0.55 else None,
            "Sleep Analysis [Total] (hr)": (sleep_total, 3),
            "Sleep Analysis [Asleep] (hr)": (sleep_total, 3),
            "Sleep Analysis [Deep] (hr)": (sleep_deep, 3),
            "Sleep Analysis [REM] (hr)": (sleep_rem, 3),
            "Sleep Analysis [Core] (hr)": (sleep_total - sleep_deep - sleep_rem, 3),
            "Sleep Analysis [Awake] (hr)": (rng.uniform(0.15, 0.85), 3),
            "Heart Rate [Avg] (count/min)": (rng.uniform(68, 80), 2),
        }
        if rng.random() < 0.35:
            food_days += 1
            v.update({
                "Dietary Energy (kJ)": (rng.uniform(1600, 2700) * ingest.KJ, 3),
                "Carbohydrates (g)": (rng.uniform(150, 320), 2),
                "Protein (g)": (rng.uniform(60, 150), 2),
                "Total Fat (g)": (rng.uniform(45, 110), 2),
                "Saturated Fat (g)": (rng.uniform(12, 38), 2),
                "Fiber (g)": (rng.uniform(14, 40), 2),
                "Sugar (g)": (rng.uniform(25, 95), 2),
                "Sodium (mg)": (rng.uniform(1500, 3800), 1),
                "Potassium (mg)": (rng.uniform(1800, 3900), 1) if rng.random() < 0.6 else None,
                "Calcium (mg)": (rng.uniform(500, 1300), 1) if rng.random() < 0.6 else None,
                "Cholesterol (mg)": (rng.uniform(120, 420), 1) if rng.random() < 0.5 else None,
                "Iron (mg)": (rng.uniform(8, 20), 2) if rng.random() < 0.5 else None,
                "Water (mL)": (rng.uniform(900, 2800), 0) if rng.random() < 0.7 else None,
            })
        row = []
        for c in DAILY_COLUMNS:
            if c == "Date/Time":
                row.append(d.isoformat() + " 00:00:00")
                continue
            cell = v.get(c)
            if cell is None:
                row.append("")
            elif averaged and c in CUMULATIVE:
                # what Average does to a sum: a per-sample mean, roughly 1/1000
                row.append(fmt(cell[0] / shrink.uniform(700, 1600), 3))
            else:
                row.append(fmt(cell[0], cell[1]))
        rows.append(row)
    return DAILY_COLUMNS, rows, food_days


def make_route(rng, start, dur_s, miles):
    """Invent a GPS loop around ORIGIN, one point every three seconds.

    Args:
        rng: the seeded random.Random.
        start: the workout start as a datetime.
        dur_s: duration in seconds.
        miles: the loop length.

    Returns:
        The route CSV text.
    """
    r_mi = miles / (2 * math.pi)
    k = math.cos(math.radians(ORIGIN[0]))
    clat = ORIGIN[0] + rng.uniform(-0.02, 0.02)
    clon = ORIGIN[1] + rng.uniform(-0.02, 0.02)
    lobes, phase = rng.randint(2, 4), rng.uniform(0, math.pi)
    rows = []
    n = max(2, dur_s // 3)
    for i in range(n + 1):
        th = 2 * math.pi * i / n
        rr = r_mi * (1 + 0.22 * math.sin(lobes * th + phase)) / 69.0
        t = start + timedelta(seconds=3 * i)
        rows.append([t.strftime("%Y-%m-%d %H:%M:%S"),
                     fmt(clat + rr * math.sin(th), 6),
                     fmt(clon + rr * math.cos(th) / k, 6),
                     fmt(rng.uniform(1, 9), 2), fmt(rng.uniform(0, 359), 1),
                     fmt(rng.uniform(2, 6), 2), fmt(rng.uniform(2, 5), 2),
                     fmt(rng.uniform(1.2, 1.7), 2)])
    return to_csv(ROUTE_COLUMNS, rows)


def make_gpx(start, route_csv):
    """Render a route as GPX, the second format the export writes beside the CSV.

    Args:
        start: the workout start as a datetime.
        route_csv: the route CSV text from make_route.

    Returns:
        The GPX text.
    """
    pts = list(csv.DictReader(io.StringIO(route_csv)))
    seg = "".join('<trkpt lat="%s" lon="%s"><time>%s</time></trkpt>'
                  % (p["Latitude"], p["Longitude"], p["Date/Time"].replace(" ", "T") + "Z")
                  for p in pts)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="sample">'
            "<trk><name>%s</name><trkseg>%s</trkseg></trk></gpx>\n"
            % (start.isoformat(), seg))


def make_hr(rng, start, minutes, avg):
    """Invent a per-minute heart rate file for one workout.

    Args:
        rng: the seeded random.Random.
        start: the workout start as a datetime.
        minutes: the number of rows.
        avg: the rough average pulse.

    Returns:
        The heart rate CSV text.
    """
    rows = []
    for i in range(minutes):
        a = avg - 14 + 14 * min(1, i / 6) + rng.uniform(-4, 4)
        t = start + timedelta(minutes=i)
        rows.append([t.strftime("%Y-%m-%d %H:%M:%S"), fmt(a - rng.uniform(2, 6), 0),
                     fmt(a + rng.uniform(2, 6), 0), fmt(a, 1)])
    return to_csv(["Date/Time", "Min (count/min)", "Max (count/min)", "Avg (count/min)"], rows)


def make_workouts(rng, days, n):
    """Invent n walks on distinct days, with their detail files.

    The third walk has no route file, the sixth has no heart rate file and the
    first also gets a GPX copy of its route, so the ingesters meet each case.

    Args:
        rng: the seeded random.Random.
        days: the list of dates.
        n: the number of walks.

    Returns:
        (workouts_csv_text, detail_files) where detail_files maps name to text.
    """
    picks = sorted(rng.sample(range(len(days)), n))
    rows, files = [], {}
    for i, di in enumerate(picks):
        start = datetime.combine(days[di], datetime.min.time()) + timedelta(
            hours=rng.randint(7, 18), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
        dur_s = rng.randint(20 * 60, 75 * 60)
        mph = rng.uniform(2.8, 3.7)
        miles = mph * dur_s / 3600
        steps = miles * rng.uniform(2050, 2250)
        kcal = miles * rng.uniform(85, 105)
        hr_avg = rng.uniform(99, 122)
        kind = "Hiking" if i == 4 else "Outdoor Walk"
        rows.append([
            kind, start.strftime("%Y-%m-%d %H:%M:%S"),
            (start + timedelta(seconds=dur_s)).strftime("%Y-%m-%d %H:%M:%S"),
            "%d:%02d:%02d" % (dur_s // 3600, dur_s % 3600 // 60, dur_s % 60),
            fmt((kcal + dur_s / 60 * 1.2) * ingest.KJ, 3), fmt(kcal * ingest.KJ, 3),
            fmt(hr_avg + rng.uniform(18, 32), 0), fmt(hr_avg, 3),
            fmt(miles, 3), fmt(mph, 3), fmt(mph * rng.uniform(1.2, 1.45), 3),
            fmt(steps, 0), fmt(steps / (dur_s / 60), 3), fmt(rng.randint(0, 7), 0),
            fmt(rng.uniform(4, 65), 2), fmt(rng.uniform(4, 65), 2),
            fmt(rng.uniform(52, 84), 1),
            "" if i == 7 else fmt(rng.uniform(42, 92), 0),
            fmt(rng.uniform(3.5, 5.5), 2),
        ])
        st = stamp(start)
        if i != 2:
            route = make_route(rng, start, dur_s, miles)
            files["%s-Route-%s.csv" % (kind, st)] = route
            if i == 0:
                files["%s-Route-%s.gpx" % (kind, st)] = make_gpx(start, route)
        if i != 5:
            files["%s-Heart Rate-%s.csv" % (kind, st)] = make_hr(
                rng, start, dur_s // 60, hr_avg)
    return to_csv(WORKOUT_COLUMNS, rows), files


def make_meds(rng, days, n):
    """Invent n logged doses of the invented medications.

    Args:
        rng: the seeded random.Random.
        days: the list of dates.
        n: the number of doses.

    Returns:
        The medications CSV text.
    """
    slots = [(d, m) for d in days for m in MEDS]
    rows = []
    for d, (name, nick, dose, hhmm) in sorted(rng.sample(slots, n),
                                              key=lambda s: (s[0], s[1][3])):
        when = "%s %s:%02d" % (d.isoformat(), hhmm, rng.randint(0, 59))
        rows.append([when, d.isoformat() + " " + hhmm + ":00", name, nick, dose,
                     dose, "", rng.choice(STATUSES), "No", ""])
    return to_csv(["Date", "Scheduled Date", "Medication", "Nickname", "Dosage",
                   "Scheduled Dosage", "Unit", "Status", "Archived", "Codings"], rows)


def make_alerts(rng, days, n):
    """Invent n high heart rate notifications as key/value blocks.

    Args:
        rng: the seeded random.Random.
        days: the list of dates.
        n: the number of notifications.

    Returns:
        The notifications CSV text.
    """
    rows = []
    for di in sorted(rng.sample(range(len(days)), n)):
        start = datetime.combine(days[di], datetime.min.time()) + timedelta(
            hours=rng.randint(9, 22), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
        vals = [fmt(rng.uniform(112, 138), 0) for _ in range(rng.randint(4, 9))]
        rows += [["Type", "High Heart Rate"],
                 ["Start", start.strftime("%Y-%m-%d %H:%M:%S")],
                 ["End", (start + timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S")],
                 ["Heart Rate Threshold count/min", "120"],
                 ["Heart Rate (count/min)"] + vals,
                 []]
    return to_csv(None, rows)


def make_ecgs(rng, days, n):
    """Invent n ECG recordings, one key/value file each.

    Args:
        rng: the seeded random.Random.
        days: the list of dates.
        n: the number of recordings.

    Returns:
        A dict mapping file name to CSV text.
    """
    files = {}
    for di in sorted(rng.sample(range(len(days)), n)):
        start = datetime.combine(days[di], datetime.min.time()) + timedelta(
            hours=rng.randint(8, 21), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))
        files["ECG-%s.csv" % start.strftime("%Y-%m-%d_%H%M%S")] = to_csv(None, [
            ["Start", start.strftime("%Y-%m-%d %H:%M:%S")],
            ["End", (start + timedelta(seconds=30)).strftime("%Y-%m-%d %H:%M:%S")],
            ["Classification", "Sinus Rhythm"],
            ["Avg. Heart Rate (count/min)", fmt(rng.uniform(62, 78), 0)],
            ["Sampling Frequency (Hz)", "512"],
            ["Number of Voltage Measurements", "15360"],
            ["Device", "Watch"],
        ])
    return files


def make_export(spec, averaged=False):
    """Build every file of one invented manual export.

    Args:
        spec: SAMPLE or FIXTURE: seed, start date and how many of each record.
        averaged: True for the Average-aggregation version.

    Returns:
        (files, counts) where files maps zip entry name to text and counts
        holds the record counts an ingester should find.
    """
    rng = random.Random(spec["seed"])
    days = [spec["start"] + timedelta(days=i) for i in range(spec["days"])]
    span = "%s-%s" % (days[0].isoformat(), days[-1].isoformat())
    header, rows, food_days = make_daily(rng, days, averaged)
    workouts, details = make_workouts(rng, days, spec["walks"])
    files = {
        "HealthAutoExport-%s.csv" % span: to_csv(header, rows),
        "Workouts-%s.csv" % span: workouts,
        "Medications-%s.csv" % span: make_meds(rng, days, spec["doses"]),
        "HeartRateNotifications-%s.csv" % span: make_alerts(rng, days, spec["alerts"]),
    }
    files.update(details)
    files.update(make_ecgs(rng, days, spec["ecgs"]))
    counts = {"daily": spec["days"], "walks": spec["walks"], "meds": spec["doses"],
              "nutrition": food_days, "alerts": spec["alerts"], "ecgs": spec["ecgs"]}
    return files, counts


def write_zip(path, files):
    """Write files into a zip with fixed timestamps so reruns are identical.

    Args:
        path: the zip to write.
        files: a dict mapping entry name to text.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, files[name].encode("utf-8"))


def ingest_files(files):
    """Run files through tools/ingest.py as if they had been zipped.

    Args:
        files: a dict mapping entry name to text.

    Returns:
        The parsed export from ingest.parse_export.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text.encode("utf-8"))
    with zipfile.ZipFile(buf) as zf:
        return ingest.parse_export(zf)


def check_counts(parsed, counts, label):
    """Stop if the ingester found other counts than the generator made.

    Args:
        parsed: the result of ingest.parse_export.
        counts: the counts make_export returned.
        label: a name for the error message.

    Raises:
        SystemExit: when any count differs.
    """
    got = {k: len(parsed[k]) for k in counts}
    if got != counts:
        sys.exit("%s: ingest found %s, expected %s" % (label, got, counts))


def main():
    """Write sample.json and both fixtures, then print the expected counts."""
    files, counts = make_export(SAMPLE)
    parsed = ingest_files(files)
    check_counts(parsed, counts, "sample")
    store, _, _ = ingest.to_store([parsed], {})
    store["meta"]["updated"] = SAMPLE_UPDATED
    store["meta"]["sample"] = True  # an import replaces it instead of merging
    os.makedirs(os.path.dirname(SAMPLE_PATH), exist_ok=True)
    with open(SAMPLE_PATH, "w", encoding="utf-8") as f:
        json.dump(store, f, separators=(",", ":"), ensure_ascii=False)
        f.write("\n")
    print("data/sample.json                   %s" % counts)

    files, counts = make_export(FIXTURE)
    check_counts(ingest_files(files), counts, "summed fixture")
    write_zip(os.path.join(FIXTURE_DIR, "sample-summed.zip"), files)
    print("test/fixtures/sample-summed.zip    %s" % counts)

    files, _ = make_export(FIXTURE, averaged=True)
    try:
        ingest_files(files)
    except ingest.AggregationError:
        pass
    else:
        sys.exit("averaged fixture: ingest accepted it, expected AggregationError")
    write_zip(os.path.join(FIXTURE_DIR, "sample-averaged.zip"), files)
    print("test/fixtures/sample-averaged.zip  refused: aggregation set to Average")


if __name__ == "__main__":
    main()
