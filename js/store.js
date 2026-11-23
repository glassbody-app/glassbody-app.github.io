/* HealthStore: the whole history, kept in this browser's IndexedDB.

   Exports are rolling windows that overlap, so records are merged by key and
   the newer file wins on a collision. Re-importing an export adds nothing.
   The merge mirrors to_store() in tools/ingest.py; change both or neither. */
(function (root) {
  'use strict';
  // DB keeps its name from before the rename (docs/architecture.md, section 2)
  var DB = 'body-scan', OS = 'store', KEY = 'current';
  // a second record beside KEY: { at: stamp } of the last Download backup
  var BACKUP_KEY = 'backup';
  var COLLECTIONS = ['daily', 'walks', 'meds', 'nutrition', 'alerts', 'ecgs'];
  var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  var STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z$/;   // what stamp() writes
  // merge key and sort key for each collection (docs/architecture.md)
  var KEYS = {
    daily:     { key: function (d) { return d.date; }, sort: function (d) { return d.date; } },
    walks:     { key: function (w) { return w.id; },   sort: function (w) { return w.id; } },
    // seq tells apart doses of one medicine logged in the same minute
    meds:      { key: function (m) {
                   var seq = m.seq || 1;
                   return m.date + ' ' + m.time + '|' + (m.med || '') + (seq > 1 ? '#' + seq : '');
                 },
                 sort: function (m) { return m.date + m.time; } },
    nutrition: { key: function (n) { return n.date; }, sort: function (n) { return n.date; } },
    alerts:    { key: function (a) { return a.when; }, sort: function (a) { return a.when; } },
    ecgs:      { key: function (e) { return e.when; }, sort: function (e) { return e.when; } }
  };

  function stamp() {
    var s = new Date().toISOString();
    return s.slice(0, 10) + ' ' + s.slice(11, 16) + 'Z';
  }
  function meta(store, updated) {
    var d = store.daily;
    return { start: d.length ? d[0].date : null, end: d.length ? d[d.length - 1].date : null,
             days: d.length, updated: updated };
  }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function isPoint(p) { return Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]); }
  function isEmpty(store) {
    return !store || COLLECTIONS.every(function (k) { return !(store[k] || []).length; });
  }

  // pure: fold parsed collections into a store; neither argument is changed
  function fold(store, parsed) {
    store = store || {};
    var out = {}, added = {};
    COLLECTIONS.forEach(function (c) {
      var k = KEYS[c], idx = new Map();
      (store[c] || []).forEach(function (r) { idx.set(k.key(r), r); });
      var before = idx.size;
      (parsed[c] || []).forEach(function (r) { idx.set(k.key(r), r); });
      added[c] = idx.size - before;
      // Array.prototype.sort is stable, so ties keep insertion order as in Python
      out[c] = Array.from(idx.values()).sort(function (a, b) {
        var x = k.sort(a), y = k.sort(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    });
    out.meta = meta(out, stamp());
    return { store: out, added: added };
  }

  // a restored backup: every collection present, meta recomputed
  function normalise(store) {
    if (!store || typeof store !== 'object' || !Array.isArray(store.daily)) {
      throw new Error('This file is not a Glassbody backup.');
    }
    var out = {};
    COLLECTIONS.forEach(function (c) {
      var k = KEYS[c], rows = Array.isArray(store[c]) ? store[c] : [], idx = new Map();
      // a hand-edited backup may hold junk rows or come unsorted; meta reads the ends,
      // and the pages parse every date, so a row without a real one is dropped
      rows.filter(function (r) {
        return r && typeof r === 'object' && typeof k.key(r) === 'string' && k.key(r) !== ''
          && typeof r.date === 'string' && ISO_DAY.test(r.date);
      }).forEach(function (r) {
        if (c === 'walks') {
          // the Movement page draws every point; one null or string blanks it
          r = Object.assign({}, r);
          r.hr = Array.isArray(r.hr) ? r.hr.filter(finite) : [];
          r.route = Array.isArray(r.route) ? r.route.filter(isPoint) : [];
        }
        // a repeated key keeps the last row, as fold() does
        idx.set(k.key(r), r);
      });
      out[c] = Array.from(idx.values()).sort(function (a, b) {
        var x = k.sort(a), y = k.sort(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
    });
    var updated = store.meta && store.meta.updated;
    out.meta = meta(out, typeof updated === 'string' && STAMP.test(updated) ? updated : stamp());
    // the sample says so, and the first real import replaces it rather than mixing
    if (store.meta && store.meta.sample === true) out.meta.sample = true;
    return out;
  }

  // ---- IndexedDB, one record holding the whole store
  var dbp = null, MISSING = {};
  // only a write creates the database, so a read after Erase leaves none behind
  function open(create) {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
      var rq = root.indexedDB.open(DB, 1), missing = false;
      rq.onupgradeneeded = function (ev) {
        // aborting the first upgrade leaves no database
        if (!create && ev.oldVersion === 0) { missing = true; rq.transaction.abort(); return; }
        rq.result.createObjectStore(OS);
      };
      rq.onsuccess = function () {
        var db = rq.result;
        // another tab erasing: let go, so its deleteDatabase is not blocked
        db.onversionchange = function () { db.close(); dbp = null; };
        resolve(db);
      };
      rq.onerror = function (ev) {
        if (missing) ev.preventDefault();
        reject(missing ? MISSING : rq.error);
      };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  // a write creates the database unless create is false
  function tx(mode, fn, create) {
    return open(create === undefined ? mode === 'readwrite' : create).then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(OS, mode), os = t.objectStore(OS), result;
        var rq = fn(os);
        rq.onsuccess = function () { result = rq.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error || rq.error); };
      });
    });
  }
  function put(store) {
    return tx('readwrite', function (os) { return os.put(store, KEY); })
      .then(function () { return store; });
  }
  // no database: nothing to read, and markBackup() has no records to mark
  function nullIfMissing(e) {
    if (e === MISSING) return null;
    throw e;
  }

  root.HealthStore = {
    collections: COLLECTIONS,
    fold: fold,
    medKey: KEYS.meds.key,
    // resolves to the store, or null when nothing is stored
    load: function () {
      return tx('readonly', function (os) { return os.get(KEY); })
        .then(function (s) { return isEmpty(s) ? null : s; }, nullIfMissing);
    },
    merge: function (parsed) {
      return this.load().then(function (cur) {
        var r = fold(cur, parsed);
        return put(r.store).then(function () { return r; });
      });
    },
    replace: function (store) {
      var s;
      try { s = normalise(store); } catch (e) { return Promise.reject(e); }
      return put(s);
    },
    // records that a backup was downloaded now; resolves to the stamp it wrote, or null
    // when there is no database: a tab whose records another tab erased must not create it again
    markBackup: function () {
      var at = stamp();
      return tx('readwrite', function (os) { return os.put({ at: at }, BACKUP_KEY); }, false)
        .then(function () { return at; }, nullIfMissing);
    },
    // resolves to the stamp of the last backup, or null; like load(), never creates the database
    lastBackup: function () {
      return tx('readonly', function (os) { return os.get(BACKUP_KEY); })
        .then(function (r) { return r && typeof r.at === 'string' && STAMP.test(r.at) ? r.at : null; },
              nullIfMissing);
    },
    // deletes the whole database, not only the record, so nothing is left behind.
    // While another tab holds it open, onBlocked is called and the promise waits.
    clear: function (onBlocked) {
      var was = dbp;
      dbp = null;
      return (was ? was.then(function (db) { db.close(); }, function () {}) : Promise.resolve())
        .then(function () {
          return new Promise(function (resolve, reject) {
            if (!root.indexedDB) { reject(new Error('This browser has no IndexedDB.')); return; }
            var rq = root.indexedDB.deleteDatabase(DB);
            rq.onsuccess = function () { resolve(); };
            rq.onerror = function () { reject(rq.error); };
            // rejecting here would leave the delete queued and every later open stuck behind it
            rq.onblocked = function () { if (onBlocked) onBlocked(); };
          });
        });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
