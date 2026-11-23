/* HealthIngest: reads a Health Auto Export zip in the browser.

   A port of parse_export() in tools/ingest.py, kept deliberately identical so
   both give the same store from the same zip. Change both or neither.
   Units out: miles, kcal, lb, in, °F. A blank cell is missing, never zero. */
(function (root) {
  'use strict';
  var KJ = 4.184, KM_MI = 0.621371;
  var AVERAGED = 'Cumulative metrics look averaged, not summed (most days under 100 ' +
    'steps). Set the export\'s aggregation to Sum and export again.';

  // Size limits, checked before anything is inflated, the same in tools/ingest.py.
  // Real exports are far smaller: the daily file is one row per day. A zip
  // reports each file's size itself, so one that lies about it gets through.
  var MB = 1e6;
  var LIMITS = { zipBytes: 500 * MB, fileBytes: 50 * MB, totalBytes: 200 * MB };
  // the files either parser reads; their summed size is what LIMITS.totalBytes caps
  var READ = [/^HealthAutoExport-.*\.csv$/, /^Workouts-.*\.csv$/, /^.*-(Heart Rate|Route)-.*\.csv$/,
              /^Medications-.*\.csv$/, /^HeartRateNotifications-.*\.csv$/, /^ECG-.*\.csv$/];

  function errorType(name) {
    function E(message) {
      this.name = name;
      this.message = message;
      this.stack = new Error(message).stack;
    }
    E.prototype = Object.create(Error.prototype);
    E.prototype.constructor = E;
    return E;
  }
  // the export was made with aggregation set to Average, not Sum
  var AggregationError = errorType('AggregationError');
  // the zip, one file in it, or all of them together are over LIMITS
  var TooLargeError = errorType('TooLargeError');
  // JSZip could not open the file; the library's own text goes to the console
  var NotZipError = errorType('NotZipError');
  // a member is encrypted or uses a method other than stored or deflate; JSZip
  // refuses the whole zip then, so tools/ingest.py refuses it too
  var UnreadableError = errorType('UnreadableError');
  var UNREADABLE = 'The zip uses compression or encryption this page cannot read.';
  function mb(bytes) { return Math.ceil(bytes / MB) + ' MB'; }

  // ---- numbers
  function num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '') return null;
    var f = Number(s);
    return isFinite(f) ? f : null;
  }
  // Python's round(): ties go to the even digit, decided on the exact binary value
  function pyRound(v, n) {
    if (!isFinite(v)) return null;
    n = n || 0;
    var s = Math.abs(v).toFixed(n + 20);
    var tail = s.slice(-20), k = Number(s.slice(0, -20).replace('.', ''));
    if (tail === '50000000000000000000') k += k % 2;
    else if (tail[0] >= '5') k += 1;
    var out = k / Math.pow(10, n);
    return v < 0 ? -out : out;
  }
  // H:MM:SS to minutes; blank or any other shape is missing
  function minutes(dur) {
    var p = (dur || '').split(':');
    if (p.length !== 3 || !p.every(function (v) { return /^\s*\d+\s*$/.test(v); })) return null;
    p = p.map(function (v) { return parseInt(v, 10); });
    return pyRound(p[0] * 60 + p[1] + p[2] / 60, 1);
  }
  function r(v, n) { return v === null ? null : pyRound(v, n === undefined ? 2 : n); }

  // ---- CSV, as Python's csv module reads it: quotes, CRLF, blank lines
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [], row = [], cell = '', q = false, any = false, fresh = false, i = 0, n = text.length;
    function endRow() {
      if (any || row.length) { row.push(cell); rows.push(row); } else rows.push([]);
      row = []; cell = ''; any = false; fresh = false;
    }
    for (; i < n; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"' && cell === '' && !fresh) { q = true; any = true; fresh = true; }
      else if (ch === ',') { row.push(cell); cell = ''; any = true; fresh = false; }
      else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
      else if (ch === '\n') endRow();
      else { cell += ch; any = true; }
    }
    if (any || row.length) endRow();
    return rows;
  }
  // csv.DictReader: header row, blank rows skipped, a short row's missing cells are null
  function dictRows(text) {
    var rows = parseCSV(text), head = rows[0] || [];
    return rows.slice(1).filter(function (r) { return r.length; }).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { o[h] = i < r.length ? r[i] : null; });
      return o;
    });
  }
  function get(o, k) { return o[k] === undefined ? null : o[k]; }

  var COLS = {
    steps: 'Step Count (count)',
    miles: 'Walking + Running Distance (km)',
    activeKcal: 'Active Energy (kJ)',
    restingKcal: 'Resting Energy (kJ)',
    exerciseMin: 'Apple Exercise Time (min)',
    standHours: 'Apple Stand Hour (count)',
    flights: 'Flights Climbed (count)',
    daylightMin: 'Time in Daylight (min)',
    restingHr: 'Resting Heart Rate (count/min)',
    walkingHr: 'Walking Heart Rate Average (count/min)',
    hrv: 'Heart Rate Variability (ms)',
    recoveryHrv: 'Recovery HRV (ms)',
    cardioRecovery: 'Cardio Recovery (count/min)',
    spo2: 'Blood Oxygen Saturation (%)',
    respRate: 'Respiratory Rate (count/min)',
    vo2max: 'VO2 Max (ml/(kg·min))',
    weightKg: 'Weight (kg)',
    bmi: 'Body Mass Index (count)',
    walkKmh: 'Walking Speed (km/hr)',
    stepLenCm: 'Walking Step Length (cm)',
    walkAsym: 'Walking Asymmetry Percentage (%)',
    walkDbl: 'Walking Double Support Percentage (%)',
    envAudio: 'Environmental Audio Exposure (dBASPL)',
    headphoneAudio: 'Headphone Audio Exposure (dBASPL)',
    sleepTotal: 'Sleep Analysis [Total] (hr)',
    sleepCore: 'Sleep Analysis [Core] (hr)',
    sleepDeep: 'Sleep Analysis [Deep] (hr)',
    sleepRem: 'Sleep Analysis [REM] (hr)',
    sleepAwake: 'Sleep Analysis [Awake] (hr)'
  };
  var NUT = [['Dietary Energy (kJ)', 'energyKcal', function (v) { return pyRound(v / KJ); }],
             ['Carbohydrates (g)', 'carbsG', function (v) { return pyRound(v, 1); }],
             ['Protein (g)', 'proteinG', function (v) { return pyRound(v, 1); }],
             ['Total Fat (g)', 'fatG', function (v) { return pyRound(v, 1); }],
             ['Saturated Fat (g)', 'satFatG', function (v) { return pyRound(v, 1); }],
             ['Fiber (g)', 'fiberG', function (v) { return pyRound(v, 1); }],
             ['Sugar (g)', 'sugarG', function (v) { return pyRound(v, 1); }],
             ['Sodium (mg)', 'sodiumMg', function (v) { return pyRound(v); }],
             ['Potassium (mg)', 'potassiumMg', function (v) { return pyRound(v); }],
             ['Calcium (mg)', 'calciumMg', function (v) { return pyRound(v); }],
             ['Cholesterol (mg)', 'cholesterolMg', function (v) { return pyRound(v); }],
             ['Iron (mg)', 'ironMg', function (v) { return pyRound(v, 1); }],
             ['Water (mL)', 'waterMl', function (v) { return pyRound(v); }]];

  function daily(row) {
    var date = (get(row, 'Date/Time') || '').slice(0, 10);
    if (!date) return null;
    var g = function (k) { return num(get(row, COLS[k])); };
    var km = g('miles'), ws = g('walkKmh'), sl = g('stepLenCm');
    var ae = g('activeKcal'), re = g('restingKcal'), wt = g('weightKg');
    return {
      date: date,
      steps: r(g('steps'), 0),
      miles: km !== null ? r(km * KM_MI, 3) : null,
      activeKcal: ae !== null ? r(ae / KJ, 0) : null,
      restingKcal: re !== null ? r(re / KJ, 0) : null,
      exerciseMin: r(g('exerciseMin')),
      standHours: r(g('standHours'), 0),
      flights: r(g('flights')),
      daylightMin: r(g('daylightMin')),
      restingHr: r(g('restingHr')),
      walkingHr: r(g('walkingHr')),
      hrv: r(g('hrv')),
      recoveryHrv: r(g('recoveryHrv')),
      cardioRecovery: r(g('cardioRecovery')),
      spo2: r(g('spo2')),
      respRate: r(g('respRate')),
      vo2max: r(g('vo2max')),
      weightLb: wt !== null ? r(wt * 2.20462, 1) : null,
      bmi: r(g('bmi')),
      walkMph: ws !== null ? r(ws * KM_MI, 2) : null,
      stepLenIn: sl !== null ? r(sl / 2.54, 1) : null,
      walkAsym: r(g('walkAsym')),
      walkDbl: r(g('walkDbl')),
      envAudio: r(g('envAudio')),
      headphoneAudio: r(g('headphoneAudio')),
      sleepTotal: r(g('sleepTotal')),
      sleepCore: r(g('sleepCore')),
      sleepDeep: r(g('sleepDeep')),
      sleepRem: r(g('sleepRem')),
      sleepAwake: r(g('sleepAwake'))
    };
  }

  // the first value in a mi/km (or degF/degC) pair of columns, in miles (or °F)
  function either(x, a, b, conv) {
    var v = num(get(x, a));
    if (v !== null) return v;
    v = num(get(x, b));
    return v !== null ? conv(v) : null;
  }
  function toMi(v) { return v * KM_MI; }

  function walk(x) {
    var start = get(x, 'Start') || '';
    if (!start) return null;
    var tf = either(x, 'Temperature (degF)', 'Temperature (degC)',
                    function (c) { return c * 9 / 5 + 32; });
    var ae = num(get(x, 'Active Energy (kJ)'));
    var asc = num(get(x, 'Elevation Ascended (m)'));
    return {
      id: start, date: start.slice(0, 10), time: start.slice(11, 16),
      type: get(x, 'Workout Type') || 'Workout',
      durMin: minutes(get(x, 'Duration')),
      miles: r(either(x, 'Distance (mi)', 'Distance (km)', toMi), 2),
      mphAvg: r(either(x, 'Avg. Speed (mi/hr)', 'Avg. Speed (km/hr)', toMi), 2),
      mphMax: r(either(x, 'Max. Speed (mi/hr)', 'Max. Speed (km/hr)', toMi), 2),
      steps: r(num(get(x, 'Step Count')), 0),
      cadence: r(num(get(x, 'Step Cadence (spm)')), 0),
      kcal: ae !== null ? r(ae / KJ, 0) : null,
      hrAvg: r(num(get(x, 'Avg. Heart Rate (count/min)')), 0),
      hrMax: r(num(get(x, 'Max. Heart Rate (count/min)')), 0),
      flights: r(num(get(x, 'Flights Climbed')), 0),
      ascentFt: asc !== null ? pyRound(asc * 3.28084) : null,
      tempF: r(tf, 0),
      humidity: r(num(get(x, 'Humidity (%)')), 0),
      hr: [], route: []
    };
  }

  // GPS at about one point a second, thinned to roughly 70 the way ingest.py does
  function thinRoute(pts) {
    var step = Math.max(1, Math.floor(pts.length / 70)), keep = [];
    for (var i = 0; i < pts.length; i += step) keep.push(pts[i]);
    if (pts.length && pts.length % step) keep.push(pts[pts.length - 1]);
    return keep.filter(function (p) {
      return num(get(p, 'Latitude')) !== null && num(get(p, 'Longitude')) !== null;
    }).map(function (p) {
      return [pyRound(num(p.Latitude), 5), pyRound(num(p.Longitude), 5)];
    });
  }

  function alerts(rows, out) {
    var cur = null;
    rows.forEach(function (row) {
      if (!row.length || !row[0]) return;
      var k = row[0];
      if (k === 'Type') cur = { kind: get(row, 1), peak: null, threshold: null };
      else if (cur === null) return;
      else if (k === 'Start' && !('when' in cur)) {
        cur.when = (row[1] || '').slice(0, 16);
        cur.date = (row[1] || '').slice(0, 10);
      } else if (k === 'Heart Rate Threshold count/min') {
        var t = num(row[1]);
        cur.threshold = t !== null ? Math.trunc(t) : null;
      } else if (k === 'Heart Rate (count/min)') {
        var vs = row.slice(1).map(num).filter(function (v) { return v !== null; });
        cur.peak = vs.length ? pyRound(Math.max.apply(null, vs)) : null;
        if (cur.when) out.set(cur.when, cur);
      }
    });
  }

  function ecg(rows, out) {
    var kv = {};
    rows.forEach(function (row) { if (row.length >= 2 && row[0]) kv[row[0]] = row[1]; });
    if (!kv.Start) return;
    out.set(kv.Start.slice(0, 16), {
      when: kv.Start.slice(0, 16), date: kv.Start.slice(0, 10),
      'class': get(kv, 'Classification'),
      bpm: r(num(get(kv, 'Avg. Heart Rate (count/min)')), 0),
      hz: num(get(kv, 'Sampling Frequency (Hz)')),
      samples: get(kv, 'Number of Voltage Measurements')
    });
  }

  function values(m) { return Array.from(m.values()); }

  function parseZip(input) {
    if (!root.JSZip) return Promise.reject(new Error('JSZip did not load.'));
    var size = input && (typeof input.size === 'number' ? input.size : input.byteLength);
    if (size > LIMITS.zipBytes) {
      return Promise.reject(new TooLargeError('The zip is ' + mb(size) + '; the limit is '
        + mb(LIMITS.zipBytes) + '. Export a shorter date range.'));
    }
    return root.JSZip.loadAsync(input).catch(function (e) {
      if (root.console) root.console.debug('JSZip:', e);
      var said = e && e.message ? e.message : '';
      if (/^Encrypted zip|^Corrupted zip : compression /.test(said)) throw new UnreadableError(UNREADABLE);
      throw new NotZipError('This is not a zip file.');
    }).then(function (zip) {
      // basename -> path, first one wins, in zip order as in ingest.py
      var files = new Map(), total = 0;
      zip.forEach(function (path, entry) {
        if (entry.dir || /(^|\/)__MACOSX\//.test(path)) return;
        var name = path.split('/').pop();
        if (name.indexOf('._') === 0 || files.has(name)) return;
        files.set(name, path);
        if (!READ.some(function (rx) { return rx.test(name); })) return;
        // JSZip 3 keeps the size from the zip's directory here; it has no public getter
        var n = entry._data && entry._data.uncompressedSize;
        if (typeof n !== 'number') return;
        if (n > LIMITS.fileBytes) {
          throw new TooLargeError(name + ' unpacks to ' + mb(n) + '; the limit for one file is '
            + mb(LIMITS.fileBytes) + '.');
        }
        total += n;
      });
      if (total > LIMITS.totalBytes) {
        throw new TooLargeError('The CSV files in the zip unpack to ' + mb(total) + '; the limit is '
          + mb(LIMITS.totalBytes) + '. Export a shorter date range.');
      }
      function find(rx) {
        var hits = [];
        files.forEach(function (path, name) { if (rx.test(name)) hits.push(path); });
        return hits;
      }
      // JSZip's own decoder swallows the bytes after a bad one; TextDecoder writes
      // U+FFFD as Python's errors="replace" does. parseCSV drops the BOM.
      var utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
      function text(path) {
        return zip.file(path).async('uint8array').then(function (b) { return utf8.decode(b); });
      }
      function last(paths) { return paths.slice().sort().pop(); }
      function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

      var out = { daily: new Map(), walks: new Map(), meds: new Map(), nutrition: new Map(),
                  alerts: new Map(), ecgs: new Map(), warnings: [] };
      var main = find(/^HealthAutoExport-.*\.csv$/);
      var wf = find(/^Workouts-.*\.csv$/);
      var chain = Promise.resolve();

      // ---- daily metrics and food, from the same file
      if (!main.length) {
        out.warnings.push('No HealthAutoExport-*.csv found; daily metrics skipped.');
      } else {
        chain = chain.then(function () { return text(last(main)); }).then(function (t) {
          var rows = dictRows(t);
          rows.forEach(function (row) {
            var d = daily(row);
            if (d) out.daily.set(d.date, d);
          });
          var steps = values(out.daily).map(function (d) { return d.steps; })
            .filter(function (s) { return s !== null; });
          var low = steps.filter(function (s) { return s < 100; }).length;
          if (steps.length && low > steps.length * 0.6) throw new AggregationError(AVERAGED);
          rows.forEach(function (row) {
            var date = (get(row, 'Date/Time') || '').slice(0, 10), vals = {}, any = false;
            NUT.forEach(function (c) {
              var v = num(get(row, c[0]));
              if (v !== null) { vals[c[1]] = c[2](v); any = true; }
            });
            if (date && any) { vals.date = date; out.nutrition.set(date, vals); }
          });
        });
      }

      // ---- workouts, then each one's heart rate and route by start stamp
      if (wf.length) {
        chain = chain.then(function () { return text(last(wf)); }).then(function (t) {
          dictRows(t).forEach(function (x) {
            var w = walk(x);
            if (w) out.walks.set(w.id, w);
          });
          return Promise.all(values(out.walks).map(function (w) {
            // the stamp with seconds tells apart two workouts started in the same
            // minute; the 13-character minute stamp is the fallback
            var full = w.id.replace(/-/g, '').replace(/:/g, '').replace(/ /g, '_');
            var detail = function (kind) {
              var hit = find(new RegExp('^.*-' + kind + '-' + esc(full.slice(0, 15)) + '.*\\.csv$'));
              return hit.length ? hit
                : find(new RegExp('^.*-' + kind + '-' + esc(full.slice(0, 13)) + '.*\\.csv$'));
            };
            var hr = detail('Heart Rate'), rt = detail('Route');
            return Promise.all([
              hr.length ? text(hr[0]).then(function (t2) {
                w.hr = dictRows(t2).map(function (x) { return num(get(x, 'Avg (count/min)')); })
                  .filter(function (v) { return v !== null; })
                  .map(function (v) { return pyRound(v); });
              }) : null,
              rt.length ? text(rt[0]).then(function (t2) { w.route = thinRoute(dictRows(t2)); })
                : null
            ]);
          }));
        });
      }

      // ---- medication
      // two doses of one medicine in the same minute get seq 1, 2, ... in file
      // order. A dose is the same dose when logged time, scheduled time, medicine
      // and dosage match. Files go newest name first so the newer status wins,
      // in the same order as tools/ingest.py.
      var seenDose = new Set(), perMinute = new Map();
      var base = function (p) { return p.slice(p.lastIndexOf('/') + 1); };
      find(/^Medications-.*\.csv$/).sort(function (a, b) {
        var x = base(a), y = base(b);
        return x < y ? 1 : x > y ? -1 : 0;
      }).forEach(function (path) {
        chain = chain.then(function () { return text(path); }).then(function (t) {
          dictRows(t).forEach(function (m) {
            var when = get(m, 'Date') || '';
            var exact = [when, get(m, 'Scheduled Date') || '', get(m, 'Medication') || '',
                         get(m, 'Dosage') || ''].join('|');
            if (seenDose.has(exact)) return;
            seenDose.add(exact);
            var dose = {
              date: when.slice(0, 10), time: when.slice(11, 16),
              name: get(m, 'Nickname') || get(m, 'Medication'),
              med: get(m, 'Medication'), dose: get(m, 'Dosage'), status: get(m, 'Status')
            };
            var minute = HealthStore.medKey(dose);
            var n = (perMinute.get(minute) || 0) + 1;
            perMinute.set(minute, n);
            if (n > 1) dose.seq = n;
            out.meds.set(HealthStore.medKey(dose), dose);
          });
        });
      });

      // ---- heart alerts and ECG, both key/value files
      find(/^HeartRateNotifications-.*\.csv$/).forEach(function (path) {
        chain = chain.then(function () { return text(path); })
          .then(function (t) { alerts(parseCSV(t), out.alerts); });
      });
      find(/^ECG-.*\.csv$/).forEach(function (path) {
        chain = chain.then(function () { return text(path); })
          .then(function (t) { ecg(parseCSV(t), out.ecgs); });
      });

      return chain.then(function () {
        return { daily: values(out.daily), walks: values(out.walks), meds: values(out.meds),
                 nutrition: values(out.nutrition), alerts: values(out.alerts),
                 ecgs: values(out.ecgs), warnings: out.warnings };
      });
    });
  }

  // parseCSV and pyRound are exposed for tests of the parity with tools/ingest.py
  // LIMITS can be lowered by a test to reach the checks without a huge file
  root.HealthIngest = { parseZip: parseZip, AggregationError: AggregationError,
                        TooLargeError: TooLargeError, NotZipError: NotZipError,
                        UnreadableError: UnreadableError,
                        limits: LIMITS, parseCSV: parseCSV, pyRound: pyRound };
})(typeof window !== 'undefined' ? window : globalThis);
