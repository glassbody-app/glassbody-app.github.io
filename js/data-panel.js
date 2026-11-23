/* GlassbodyPanel: the Data sheet. Import, backup, restore, sample, erase.

   Everything imported ends up in the DOM through textContent only; medication
   names and the like come from the user's file. */
(function () {
  'use strict';
  var Store = window.HealthStore, Ingest = window.HealthIngest;
  var current = null, busy = false, lastFocus = null, pending = null;
  // the stamp of the last Download backup, or null: read with current when the panel
  // opens, then kept in step by download() and clear()
  var backupAt = null;
  // a real backup is a few MB; JSON.parse of a much larger one can stall the tab
  var BACKUP_LIMIT = 100e6;

  var PANEL =
    '<div class="sh-head"><h2 id="sh-title" tabindex="-1">Your data</h2>'
    + '<button type="button" class="sh-x" aria-label="Close">&times;</button></div>'
    + '<p class="sh-status"></p>'
    + '<p class="sh-note sh-keep" hidden></p>'
    + '<p class="sh-msg" role="status" aria-live="polite"></p>'
    + '<section><h3>Import an export</h3>'
    + '<label class="drop"><input type="file" accept=".zip,application/zip" class="sh-zip">'
    + '<span>Drop a Health Auto Export zip here, or <u>choose a file</u>.</span></label>'
    + '<p class="sh-note">Use Export All in Health Auto Export, with aggregation set to Sum. '
    + 'The zip is read in this browser and the records are kept here. Nothing is uploaded. '
    + 'Importing an overlapping export adds only the new records.</p></section>'
    + '<section><h3>Backup</h3><div class="sh-row">'
    + '<button type="button" class="sh-btn sh-down">Download backup</button>'
    + '<label class="sh-btn"><input type="file" accept=".json,application/json" class="sh-json">'
    + 'Restore backup</label></div>'
    + '<p class="sh-note sh-last" hidden></p>'
    + '<div class="sh-rconfirm" hidden><p class="sh-note sh-rconfirm-text"></p><div class="sh-row">'
    + '<button type="button" class="sh-btn sh-warn sh-ryes">Restore</button>'
    + '<button type="button" class="sh-btn sh-rno">Cancel</button></div></div>'
    + '<p class="sh-note">A backup is one JSON file. It contains every record, including '
    + 'medication and the GPS route of each walk. Keep it somewhere private. Restoring it '
    + 'replaces what is stored.</p></section>'
    + '<section><h3>Sample</h3><div class="sh-row">'
    + '<button type="button" class="sh-btn sh-sample">Load sample data</button></div>'
    + '<p class="sh-note sh-sample-note"></p></section>'
    + '<section><h3>Erase</h3><div class="sh-row">'
    + '<button type="button" class="sh-btn sh-warn sh-erase">Erase everything</button></div>'
    + '<div class="sh-confirm" hidden><p class="sh-note">This deletes every stored record and '
    + 'the database that held them from this browser. Download a backup first if you want to '
    + 'keep one.</p><div class="sh-row">'
    + '<button type="button" class="sh-btn sh-warn sh-yes">Erase</button>'
    + '<button type="button" class="sh-btn sh-no">Cancel</button></div></div></section>';

  var back = document.createElement('div');
  back.className = 'sh-back'; back.hidden = true;
  var sheet = document.createElement('aside');
  sheet.className = 'sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'sh-title');
  sheet.innerHTML = PANEL;
  document.body.append(back, sheet);

  var opener = document.createElement('button');
  opener.type = 'button'; opener.className = 'datab'; opener.textContent = 'Data';
  opener.setAttribute('aria-haspopup', 'dialog');
  // in the top bar's flow, beside the range control, so the two never overlap
  document.getElementById('tools').append(opener);

  var $ = function (s) { return sheet.querySelector(s); };
  var status = $('.sh-status'), msg = $('.sh-msg'), drop = $('.drop'), backupLine = $('.sh-last');
  var buttons = sheet.querySelectorAll('button, input');
  var safariText = safariNote();
  $('.sh-keep').textContent = safariText;
  $('.sh-keep').hidden = !safariText;

  // ---- wording
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function list(parts) {
    return parts.length < 2 ? parts.join('')
      : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }
  function counts(c) {
    return [plural(c.daily, 'day', 'days'), plural(c.walks, 'walk', 'walks'),
            plural(c.meds, 'dose', 'doses'), plural(c.nutrition, 'day of food', 'days of food'),
            plural(c.alerts, 'alert', 'alerts'), plural(c.ecgs, 'ECG', 'ECGs')];
  }
  function sizes(s) {
    var o = {};
    Store.collections.forEach(function (k) { o[k] = (s[k] || []).length; });
    return o;
  }
  // "2026-09-12" as "Sep 12, 2026", the way the page writes dates, with the year
  function day(s) {
    var d = new Date(String(s).slice(0, 10) + 'T00:00:00Z');
    return isNaN(d) ? String(s) : d.toLocaleDateString('en-US',
      { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
  }
  // a UTC stamp, "2026-10-29 01:00Z", as the reader's own calendar day, "Oct 28, 2026"
  function localDay(stamp) {
    return new Date(stamp.replace(' ', 'T')).toLocaleDateString('en-US',
      { month:'short', day:'numeric', year:'numeric' });
  }
  // today's date as "2026-11-10" in the reader's own calendar, the day the last
  // backup line shows; toISOString() would give the UTC date
  function formatToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  // Safari deletes what a site stores after 7 days of use without a visit; a Home
  // Screen web app keeps its own count (docs/specs/glassbody-v1.md, section 3.2)
  function safariNote() {
    var ua = navigator.userAgent;
    if (navigator.standalone === true
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) return '';
    var lead = 'Safari deletes what this page stores after 7 days of use without a visit. ';
    // every browser on iPhone and iPad is WebKit; iPadOS asks for desktop pages as a Mac
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
      return lead + 'Add Glassbody to your Home Screen (Share, then Add to Home Screen), '
        + 'open it from there, and import your export there.';
    }
    // neither WebKit post says whether web apps added to the Dock are spared
    if (/Macintosh/.test(ua) && /Version\//.test(ua) && /Safari\//.test(ua)
        && !/Chrome|Chromium|Edg|Firefox/.test(ua)) {
      return lead + 'Download a backup after each import.';
    }
    return '';
  }

  function paintStatus() {
    if (!current) {
      status.textContent = 'Nothing is stored in this browser yet. Import an export, '
        + 'or load the sample to look around.';
    } else {
      var m = current.meta;
      status.textContent = 'Stored here: ' + list(counts(sizes(current)))
        + (m.start ? ', from ' + day(m.start) + ' to ' + day(m.end) : '') + '.';
    }
    // paintStatus also runs while a file is read (open() during a drop), so busy counts
    $('.sh-down').disabled = busy || !current;
    $('.sh-erase').disabled = busy || !current;
    $('.sh-sample').disabled = busy || !!current;
    $('.sh-sample-note').textContent = current
      ? (current.meta.sample ? 'The sample is loaded. Importing your own export replaces it.'
        : 'Erase first. The sample never mixes with your own records.')
      : '45 invented days, to look around before importing your own.';
    backupLine.hidden = !current;
    backupLine.textContent = backupAt ? 'Last backup downloaded ' + localDay(backupAt) + '.'
      : 'No backup downloaded from this browser yet.';
  }
  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = 'sh-msg' + (kind ? ' ' + kind : '');
  }

  // ---- state
  function refresh() {
    return Promise.all([Store.load(), Store.lastBackup()]).then(function (r) {
      current = r[0]; backupAt = r[1]; paintStatus(); return current;
    });
  }
  // the backup record is deleted with the database
  function clear(onBlocked) {
    return Store.clear(onBlocked).then(function () { backupAt = null; });
  }
  // persistent storage, asked for only once there is something worth keeping:
  // Firefox answers with a prompt (docs/specs/glassbody-v1.md, section 3.1)
  function keep() {
    var s = navigator.storage;
    if (!s || !s.persist || !s.persisted) return;
    // the answer is not shown on the page, so a refusal or an error changes nothing
    s.persisted().then(function (p) { return p || s.persist(); }).catch(function () {});
  }
  function show(store) {
    current = store;
    paintStatus();
    if (window.Glassbody) window.Glassbody.setData(store);
  }
  function work(label, fn) {
    if (busy) { say('Still working on the last file. Try again when it finishes.'); return Promise.resolve(); }
    busy = true;
    $('#sh-title').focus();
    sheet.setAttribute('aria-busy', 'true');
    buttons.forEach(function (b) { b.disabled = true; });
    say(label);
    return Promise.resolve().then(fn).catch(function (e) {
      say(e && e.message ? e.message : String(e), 'bad');
    }).then(function () {
      busy = false;
      sheet.removeAttribute('aria-busy');
      buttons.forEach(function (b) { b.disabled = false; });
      paintStatus();
      // the button that had focus may now be disabled or hidden
      if (!sheet.contains(document.activeElement) || document.activeElement.disabled) {
        $('#sh-title').focus();
      }
    });
  }

  // ---- actions
  function importZip(file) {
    if (!file) return Promise.resolve();
    return work('Reading ' + file.name + '…', function () {
      return Ingest.parseZip(file).catch(function (e) {
        if (e instanceof Ingest.AggregationError || e instanceof Ingest.TooLargeError
            || e instanceof Ingest.UnreadableError) {
          throw new Error(e.message + ' Nothing was stored.');
        }
        if (e instanceof Ingest.NotZipError) {
          throw new Error(file.name + ' is not a zip file. Export again from Health Auto Export.');
        }
        console.debug(e);
        throw new Error('Could not read ' + file.name + ' as a Health Auto Export zip. '
          + 'Nothing was stored.');
      }).then(function (parsed) {
        var found = Store.collections.some(function (k) { return parsed[k].length; });
        if (!found) throw new Error('Found no Health Auto Export records in ' + file.name + '.');
        var wasSample = !!(current && current.meta.sample);
        return (wasSample ? clear() : Promise.resolve()).then(function () {
          return Store.merge(parsed);
        }).then(function (r) {
          show(r.store);
          var n = Store.collections.reduce(function (s, k) { return s + r.added[k]; }, 0);
          var text = n
            ? 'Added ' + list(counts(r.added).filter(function (_, i) {
                return r.added[Store.collections[i]];
              })) + '.'
            : 'Nothing new. Every record in ' + file.name + ' was already stored.';
          if (wasSample) text = 'Replaced the sample. ' + text;
          if (parsed.warnings.length) text += ' ' + parsed.warnings.join(' ');
          if (n) text += ' Download a backup to keep a copy outside this browser.';
          say(text, n ? 'good' : '');
          if (n) keep();
        });
      });
    });
  }
  function restore(file) {
    if (!file) return Promise.resolve();
    return work('Reading ' + file.name + '…', function () {
      if (file.size > BACKUP_LIMIT) {
        throw new Error(file.name + ' is ' + Math.ceil(file.size / 1e6) + ' MB; a backup over '
          + BACKUP_LIMIT / 1e6 + ' MB is refused. Nothing was changed.');
      }
      return file.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { throw new Error(file.name + ' is not a JSON file.'); }
        return Store.replace(j);
      }).then(function (s) {
        show(s);
        say('Restored ' + plural(s.meta.days, 'day', 'days') + ' from ' + file.name + '.', 'good');
        keep();
      });
    });
  }
  function download() {
    if (busy || !current) return;
    var blob = new Blob([JSON.stringify(current)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'glassbody-backup-' + formatToday() + '.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    say('Backup downloaded.');
    // the page cannot tell whether the file was saved, so the line says "downloaded"
    Store.markBackup().then(function (at) { backupAt = at; paintStatus(); }, function (e) {
      say('Backup downloaded, but its date could not be saved: ' + (e && e.message || e), 'bad');
    });
  }
  function sample() {
    return work('Loading the sample…', function () {
      return fetch('data/sample.json').then(function (r) {
        if (!r.ok) throw new Error('The sample file did not load (' + r.status + ').');
        return r.json();
      }).then(Store.replace).then(function (s) {
        show(s);
        say('Loaded the sample: ' + plural(s.meta.days, 'invented day', 'invented days') + '.', 'good');
      });
    });
  }
  function erase() {
    $('.sh-confirm').hidden = true;
    return work('Erasing…', function () {
      return clear(function () {
        say('Glassbody is open in another tab. Close it to finish erasing.', 'bad');
      }).then(function () {
        show(null);
        say('Erased. Nothing is stored in this browser.');
      });
    });
  }

  // ---- wiring
  $('.sh-x').addEventListener('click', close);
  back.addEventListener('click', close);
  opener.addEventListener('click', function () { open(); });
  $('.sh-zip').addEventListener('change', function (ev) {
    var f = ev.target.files[0]; ev.target.value = ''; importZip(f);
  });
  // restoring over stored records asks first, as Erase does
  $('.sh-json').addEventListener('change', function (ev) {
    var f = ev.target.files[0]; ev.target.value = '';
    if (!f || busy) return;
    if (!current) { restore(f); return; }
    pending = f;
    // a store can hold walks or doses with no daily rows
    $('.sh-rconfirm-text').textContent = 'This replaces the '
      + (current.meta.days ? plural(current.meta.days, 'day', 'days') : 'records')
      + ' stored here with ' + f.name + '. Download a backup first if you want to keep them.';
    $('.sh-rconfirm').hidden = false; $('.sh-rno').focus();
  });
  $('.sh-ryes').addEventListener('click', function () {
    var f = pending; pending = null;
    $('.sh-rconfirm').hidden = true;
    restore(f);
  });
  $('.sh-rno').addEventListener('click', function () {
    pending = null;
    $('.sh-rconfirm').hidden = true; $('.sh-json').focus();
  });
  $('.sh-down').addEventListener('click', download);
  $('.sh-sample').addEventListener('click', sample);
  $('.sh-erase').addEventListener('click', function () {
    if (busy) return;
    $('.sh-confirm').hidden = false; $('.sh-no').focus();
  });
  $('.sh-no').addEventListener('click', function () {
    $('.sh-confirm').hidden = true; $('.sh-erase').focus();
  });
  $('.sh-yes').addEventListener('click', erase);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !sheet.hidden) close();
  });

  // a zip dropped anywhere on the page is imported; the browser would otherwise open it
  function hasFiles(ev) {
    return ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') >= 0;
  }
  document.addEventListener('dragover', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    drop.classList.add('over');
  });
  document.addEventListener('dragleave', function (ev) {
    if (!ev.relatedTarget) drop.classList.remove('over');
  });
  document.addEventListener('drop', function (ev) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    drop.classList.remove('over');
    open();
    importZip(ev.dataTransfer.files[0]);
  });

  // aria-modal alone does not stop Tab reaching the page behind the sheet
  function setInert(on) {
    Array.prototype.forEach.call(document.body.children, function (n) {
      if (n !== sheet && n !== back && n.tagName !== 'SCRIPT') n.inert = on;
    });
  }

  function open(note) {
    if (!sheet.hidden) { if (note) say(note, 'bad'); return; }
    lastFocus = document.activeElement;
    back.hidden = false; sheet.hidden = false;
    setInert(true);
    $('.sh-confirm').hidden = true;
    $('.sh-rconfirm').hidden = true; pending = null;
    say(note || '', note ? 'bad' : '');
    paintStatus();
    refresh().catch(function (e) { say(e.message, 'bad'); });
    $('.sh-x').focus();
  }
  function close() {
    if (busy) return;
    back.hidden = true; sheet.hidden = true;
    setInert(false);
    // opened on first visit, focus came from <body>; send it to the Data button instead
    if (!lastFocus || lastFocus === document.body || !lastFocus.isConnected) lastFocus = opener;
    lastFocus.focus();
  }

  // importZip and close are also for the Playwright regression tests (slice 3)
  window.GlassbodyPanel = { open: open, close: close, importZip: importZip };
})();
