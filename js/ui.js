
(function () {
  'use strict';
  var REGIONS = window.HOLO.regions;
  var BY = Object.create(null); REGIONS.forEach(function (r) { BY[r.id] = r; });
  var el = function (id) { return document.getElementById(id); };
  var css = function (n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  };

  var DATA = null;
  var RANGE = 7;                 // days SHOWN; the store always keeps everything
  var hovered = null;
  var route = null;              // null = the hologram, otherwise a region id
  var picked = null;             // selected walk on the movement page

  // ---------------------------------------------------------------- data
  var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  function cutoff() {
    if (!RANGE || !DATA) return '0000-00-00';
    // a store with walks or doses but no daily rows has no end; show everything
    var end = DATA.meta && DATA.meta.end;
    if (!ISO_DAY.test(end || '') || isNaN(Date.parse(end))) return '0000-00-00';
    var e = new Date(end + 'T00:00:00Z');
    e.setUTCDate(e.getUTCDate() - (RANGE - 1));
    return e.toISOString().slice(0, 10);
  }
  function within(rows) {
    var c = cutoff();
    return (rows || []).filter(function (r) {
      return String(r.date || '').slice(0, 10) >= c;
    });
  }
  function col(rows, k) {
    return rows.map(function (r) { return r[k]; })
      .filter(function (v) { return v !== null && v !== undefined && v !== ''; })
      .map(Number).filter(function (v) { return isFinite(v); });
  }
  function pairs(rows, k) {
    return rows.map(function (r) { return { d: day(r.date), v: num(r[k]) }; })
      .filter(function (r) { return r.v !== null; });
  }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v); return isFinite(n) ? n : null;
  }
  var day = function (s) { return new Date(String(s).slice(0,10) + 'T00:00:00Z'); };
  var mean = function (a) {
    return a.length ? a.reduce(function (s,v){return s+v;},0)/a.length : null;
  };
  var sum = function (a) { return a.reduce(function (s,v){return s+v;},0); };
  // a missing reading is a dash; Math.round(null) would print it as 0
  var nf = function (v) { v = num(v); return v === null ? '—' : Math.round(v).toLocaleString('en-US'); };
  var f1 = function (v) { v = num(v); return v === null ? '—' : (Math.round(v*10)/10).toFixed(1); };
  var f2 = function (v) { v = num(v); return v === null ? '—' : (Math.round(v*100)/100).toFixed(2); };
  // the one way hours are written: "7h 8m", or "54m" under an hour; rounding to whole
  // minutes first keeps 7.992 from printing as "7h 60m"
  var hrs = function (v) {
    var m = Math.round(num(v) * 60), h = Math.floor(m / 60);
    return h ? h + 'h ' + (m % 60) + 'm' : (m % 60) + 'm';
  };
  // hour ticks on chart axes
  // two decimals at most, trailing zeros dropped, so 0.05 steps stay apart
  var hTick = function (v) { return (+v.toFixed(2)) + 'h'; };
  // a number with its unit, or null (a dash in tables) when the reading is missing
  var withUnit = function (v, f, u) { return num(v) === null ? null : f(v) + ' ' + u; };
  var count = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
  var or = function (v, f) { return v === null || v === undefined ? '—' : f(v); };
  var fmtDay = function (d) {
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', timeZone:'UTC' });
  };
  var fmtDate = function (s) { return fmtDay(day(s)); };
  // "2026-10-23 22:43" as "Oct 23 22:43"
  var fmtWhen = function (s) { s = String(s || ''); return fmtDate(s) + ' ' + s.slice(11, 16); };

  // ---------------------------------------------------------------- charts
  // ids for the card headings and chart summaries that aria attributes point at
  var uid = 0;
  var idOf = function (e) { return e.id || (e.id = 'u' + (++uid)); };
  // a chart is an image named by its card's heading and described by one sentence,
  // since the per-day values otherwise live only in hover tooltips
  function describe(f, text) {
    var p = document.createElement('p');
    p.className = 'vh'; p.textContent = text;
    f.svg.node().after(p);
    f.svg.attr('aria-describedby', idOf(p));
  }
  var span = function (data) {
    return data.length === 1 ? fmtDay(data[0].d)
      : fmtDay(data[0].d) + ' to ' + fmtDay(data[data.length-1].d);
  };
  // "7 days, Oct 20 to Oct 26: lowest 3,912 steps, highest 12,950 steps, average 8,254 steps."
  function rangeText(data, what, show) {
    var v = data.map(function (r) { return r.v; }), avg = mean(v);
    // whole-number readings (steps, minutes) get a whole-number average
    if (v.every(Number.isInteger)) avg = Math.round(avg);
    return count(data.length, what, what + 's') + ', ' + span(data) + ': lowest '
      + show(d3.min(v)) + ', highest ' + show(d3.max(v)) + ', average ' + show(avg) + '.';
  }
  function plot(host, h, m) {
    host.replaceChildren();
    // drawn at the card's real width, so 12px labels stay 12px on a phone
    var w = Math.max(160, host.clientWidth || 360);
    var svg = d3.select(host).append('svg')
      .attr('width', '100%').attr('height', h)
      .attr('viewBox', '0 0 ' + w + ' ' + h)
      .attr('preserveAspectRatio', 'xMidYMid meet').attr('role', 'img');
    var head = host.closest('.card') && host.closest('.card').querySelector('h2');
    if (head) svg.attr('aria-labelledby', idOf(head));
    return { svg:svg, w:w, h:h, m:m, iw:w-m.l-m.r, ih:h-m.t-m.b,
             g: svg.append('g').attr('transform','translate('+m.l+','+m.t+')') };
  }
  function yAxis(f, y, ticks, fmt) {
    var g = f.g.append('g').attr('class','grid')
      .call(d3.axisLeft(y).ticks(ticks).tickFormat(fmt).tickSize(-f.iw).tickPadding(8))
      .attr('font-size',null).attr('font-family',null);
    g.select('.domain').remove();
    return g;
  }
  function xAxisBand(f, x, vals, fmt) {
    var g = f.g.append('g').attr('class','axis')
      .attr('transform','translate(0,'+f.ih+')')
      .call(d3.axisBottom(x).tickValues(vals).tickFormat(fmt).tickSize(0).tickPadding(8))
      .attr('font-size',null).attr('font-family',null);
    return g;
  }
  function emptyNote(host, text) {
    host.replaceChildren();
    var d = document.createElement('div');
    d.className = 'empty'; d.textContent = text;
    host.append(d);
  }
  function tickEvery(data, n) {
    var step = Math.max(1, Math.ceil(data.length / n));
    return data.filter(function (_, i) { return i % step === 0; });
  }
  // how many day labels fit across a chart, about 56px apart ("Oct 20" is about 42px)
  var dayFit = function (f) { return Math.max(2, Math.min(10, Math.floor(f.iw / 56))); };

  // tip, when given, writes the whole tooltip value in place of fmt and unit
  function barChart(host, rows, key, color, fmt, unit, tip) {
    var data = pairs(rows, key);
    if (data.length < 1) return emptyNote(host, 'No readings in this range.');
    var f = plot(host, 210, {t:10,r:10,b:26,l:54});
    var x = d3.scaleBand(data.map(function (r){return +r.d;}), [0, f.iw]).padding(0.24);
    var y = d3.scaleLinear([0, (d3.max(data, function(r){return r.v;})||1)*1.1], [f.ih,0]).nice(4);
    yAxis(f, y, 4, fmt);
    xAxisBand(f, x, tickEvery(data, dayFit(f)).map(function(r){return +r.d;}),
              function (v) { return fmtDay(new Date(v)); });
    var avg = mean(data.map(function(r){return r.v;}));
    f.g.selectAll('rect').data(data).join('rect')
      .attr('x', function(r){return x(+r.d);}).attr('width', x.bandwidth())
      .attr('y', function(r){return y(r.v);})
      .attr('height', function(r){return Math.max(1, f.ih - y(r.v));})
      .attr('rx', 2).attr('fill', color)
      .append('title').text(function (r) {
        return fmtDay(r.d)+' · '+(tip ? tip(r.v) : fmt(r.v)+' '+unit); });
    f.g.append('line').attr('x1',0).attr('x2',f.iw).attr('y1',y(avg)).attr('y2',y(avg))
      .attr('stroke',css('--mark')).attr('stroke-dasharray','4 3');
    describe(f, rangeText(data, 'day', function (v) { return tip ? tip(v) : fmt(v)+' '+unit; }));
  }

  function lineChart(host, rows, key, color, fmt, unit) {
    var data = pairs(rows, key);
    if (data.length < 2) return emptyNote(host, 'Not enough readings in this range.');
    var f = plot(host, 210, {t:10,r:12,b:26,l:54});
    // the first point starts 6px in, clear of the y labels
    var x = d3.scaleUtc(d3.extent(data, function(r){return r.d;}), [6, f.iw]);
    var ext = d3.extent(data, function(r){return r.v;});
    var pad = (ext[1]-ext[0] || 1) * 0.16;
    // readings that are never negative keep the axis at or above zero
    var y = d3.scaleLinear([ext[0] >= 0 ? Math.max(0, ext[0]-pad) : ext[0]-pad, ext[1]+pad], [f.ih, 0]).nice(4);
    yAxis(f, y, 4, fmt);
    // explicit days, because d3 treats a tick count as a hint and rounds to whole weeks
    f.g.append('g').attr('class','axis').attr('transform','translate(0,'+f.ih+')')
      .call(d3.axisBottom(x).tickValues(tickEvery(data, Math.min(6, dayFit(f))).map(function(r){return r.d;}))
        .tickFormat(fmtDay).tickSize(0).tickPadding(8))
      .attr('font-size',null).attr('font-family',null);
    var gid = 'g'+Math.random().toString(36).slice(2,7);
    var grad = f.svg.append('defs').append('linearGradient')
      .attr('id',gid).attr('x1',0).attr('x2',0).attr('y1',0).attr('y2',1);
    [[0,.30],[.5,.10],[1,0]].forEach(function (p) {
      grad.append('stop').attr('offset',p[0]).attr('stop-opacity',p[1])
        .attr('style','stop-color: '+color);
    });
    f.g.append('path').datum(data).attr('fill','url(#'+gid+')')
      .attr('d', d3.area().x(function(r){return x(r.d);}).y0(f.ih).y1(function(r){return y(r.v);}));
    f.g.append('path').datum(data).attr('fill','none').attr('stroke',color)
      .attr('stroke-width',2).attr('stroke-linecap','round').attr('stroke-linejoin','round')
      .attr('d', d3.line().x(function(r){return x(r.d);}).y(function(r){return y(r.v);}));
    f.g.selectAll('circle').data(data).join('circle')
      .attr('cx',function(r){return x(r.d);}).attr('cy',function(r){return y(r.v);})
      .attr('r',2.4).attr('fill',color)
      .append('title').text(function (r) { return fmtDay(r.d)+' · '+fmt(r.v)+' '+unit; });
    describe(f, rangeText(data, 'day', function (v) { return fmt(v)+' '+unit; }));
  }

  var STAGES = [['sleepDeep','Deep'], ['sleepCore','Core'], ['sleepRem','REM'],
                ['sleepAwake','Awake']];
  var STAGE_C = ['#6f5bd4','#a78bff','#d6c6ff', css('--mark')];
  function sleepChart(host, rows) {
    var data = rows.filter(function (r) { return num(r.sleepTotal); })
      .map(function (r) {
        var o = { d: day(r.date), total: num(r.sleepTotal)||0 };
        STAGES.forEach(function (s) { o[s[0]] = num(r[s[0]]) || 0; });
        return o;
      });
    if (!data.length) return emptyNote(host, 'No nights recorded in this range.');
    var f = plot(host, 230, {t:10,r:10,b:26,l:44});
    var x = d3.scaleBand(data.map(function(r){return +r.d;}), [0,f.iw]).padding(0.24);
    var y = d3.scaleLinear([0, (d3.max(data,function(r){
      return STAGES.reduce(function(s,k){return s+r[k[0]];},0);})||1)*1.1], [f.ih,0]).nice(4);
    yAxis(f, y, 4, hTick);
    xAxisBand(f, x, tickEvery(data, dayFit(f)).map(function(r){return +r.d;}),
              function (v) { return fmtDay(new Date(v)); });
    f.g.selectAll('g.st').data(d3.stack().keys(STAGES.map(function(s){return s[0];}))(data))
      .join('g').attr('class','st').attr('fill', function (_, i) { return STAGE_C[i]; })
      // a dark edge between stages; Deep, Core and REM are under 2:1 against each other
      .attr('stroke', css('--bg2')).attr('stroke-width', 1)
      .selectAll('rect').data(function (s, i) {
        return s.map(function (p) { return { p:p, stage:STAGES[i][1] }; }); }).join('rect')
      .attr('x', function(o){return x(+o.p.data.d);}).attr('width', x.bandwidth())
      .attr('y', function(o){return y(o.p[1]);})
      .attr('height', function(o){return Math.max(0, y(o.p[0])-y(o.p[1]));})
      .attr('rx',1)
      .append('title').text(function (o) {
        return fmtDay(o.p.data.d) + ' · ' + o.stage + ' ' + hrs(o.p[1]-o.p[0]);
      });
    describe(f, count(data.length, 'night', 'nights') + ', ' + span(data) + '. Average per night: '
      + STAGES.map(function (s) {
        return s[1] + ' ' + hrs(mean(data.map(function (r) { return r[s[0]]; })));
      }).join(', ') + '.');
  }

  function medChart(host, meds) {
    // names come from the user's file, so '__proto__' must stay an ordinary key
    var by = Object.create(null);
    meds.forEach(function (m) {
      var o = by[m.name] || (by[m.name] = { name:m.name, Taken:0, Skipped:0, Other:0 });
      if (m.status === 'Taken') o.Taken++;
      else if (m.status === 'Skipped') o.Skipped++;
      else o.Other++;
    });
    var data = Object.keys(by).map(function (k) { return by[k]; });
    if (!data.length) return emptyNote(host, 'No doses logged in this range.');
    var f = plot(host, Math.max(120, 44*data.length+46), {t:8,r:12,b:26,l:132});
    var keys = ['Taken','Skipped','Other'];
    // Skipped is hatched, so it does not rest on red against green alone
    var pid = 'h'+Math.random().toString(36).slice(2,7);
    var cols = [css('--fuel'), 'url(#'+pid+')', css('--mark')];
    var swatch = [cols[0], 'repeating-linear-gradient(45deg,'+css('--heart')+' 0 2px,transparent 2px 4px)', cols[2]];
    f.svg.append('defs').append('pattern').attr('id', pid)
      .attr('patternUnits','userSpaceOnUse').attr('width',5).attr('height',5)
      .attr('patternTransform','rotate(45)')
      .append('rect').attr('width',2.5).attr('height',5).attr('fill', css('--heart'));
    var y = d3.scaleBand(data.map(function(r){return r.name;}), [0,f.ih]).padding(0.3);
    var x = d3.scaleLinear([0, d3.max(data, function (r) {
      return keys.reduce(function(s,k){return s+r[k];},0); }) || 1], [0,f.iw]).nice();
    // dose counts are whole numbers, so ticks fall on integers only
    var top = x.domain()[1], step = Math.max(1, Math.ceil(top / 5));
    f.g.append('g').attr('class','grid').attr('transform','translate(0,'+f.ih+')')
      .call(d3.axisBottom(x).tickValues(d3.range(0, top + 1, step)).tickFormat(d3.format('d'))
        .tickSize(-f.ih).tickPadding(8))
      .attr('font-size',null).attr('font-family',null).select('.domain').remove();
    f.g.append('g').attr('class','axis')
      .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
      .attr('font-size',null).attr('font-family',null).select('.domain').remove();
    f.g.selectAll('g.md').data(d3.stack().keys(keys)(data)).join('g').attr('class','md')
      .attr('fill', function (_, i) { return cols[i]; })
      .attr('stroke', function (s) { return s.key === 'Skipped' ? css('--heart') : null; })
      .selectAll('rect').data(function (s) {
        return s.map(function (p) { return { p:p, key:s.key }; }); }).join('rect')
      .attr('y', function(o){return y(o.p.data.name);}).attr('height', y.bandwidth())
      .attr('x', function(o){return x(o.p[0]);})
      .attr('width', function(o){return Math.max(0, x(o.p[1])-x(o.p[0]));})
      .attr('rx',2)
      .append('title').text(function (o) {
        return o.p.data.name + ' · ' + o.key + ' ' + (o.p[1]-o.p[0]); });
    describe(f, data.map(function (r) {
      return r.name + ': ' + r.Taken + ' taken, ' + r.Skipped + ' skipped, '
        + r.Other + ' not interacted.';
    }).join(' '));
    var lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = keys.map(function (k, i) {
      return '<span><i style="background:'+swatch[i]+'"></i>'
        + (k === 'Other' ? 'Not interacted' : k) + '</span>';
    }).join('');
    host.append(lg);
  }

  function routePath(pts, w, h, pad) {
    var lat = pts.map(function(p){return p[0];}), lon = pts.map(function(p){return p[1];});
    var k = Math.cos((d3.mean(lat)||0) * Math.PI/180);
    var xs = lon.map(function(v){return v*k;}), ys = lat;
    var xe = d3.extent(xs), ye = d3.extent(ys);
    var sx = (xe[1]-xe[0]) || 1e-6, sy = (ye[1]-ye[0]) || 1e-6;
    var s = Math.min((w-2*pad)/sx, (h-2*pad)/sy);
    var ox = (w-sx*s)/2, oy = (h-sy*s)/2;
    return pts.map(function (p, i) {
      return [ox + (xs[i]-xe[0])*s, h - (oy + (ys[i]-ye[0])*s)];
    });
  }
  function hrChart(host, walk, color) {
    if (!walk || !walk.hr || walk.hr.length < 2) {
      return emptyNote(host, 'No heart rate recorded for this walk.');
    }
    var data = walk.hr.map(function (v, i) { return { m:i, v:v }; });
    var f = plot(host, 210, {t:10,r:12,b:26,l:46});
    var x = d3.scaleLinear(d3.extent(data,function(r){return r.m;}), [0,f.iw]);
    var ext = d3.extent(data, function(r){return r.v;});
    var pad = (ext[1]-ext[0] || 1)*0.16;
    var y = d3.scaleLinear([ext[0]-pad, ext[1]+pad], [f.ih,0]).nice(4);
    yAxis(f, y, 4, function(v){return Math.round(v);});
    f.g.append('g').attr('class','axis').attr('transform','translate(0,'+f.ih+')')
      .call(d3.axisBottom(x).ticks(5).tickFormat(function(v){return v+'m';}).tickSize(0).tickPadding(8))
      .attr('font-size',null).attr('font-family',null);
    f.g.append('path').datum(data).attr('fill','none').attr('stroke',color)
      .attr('stroke-width',2).attr('stroke-linecap','round').attr('stroke-linejoin','round')
      .attr('d', d3.line().x(function(r){return x(r.m);}).y(function(r){return y(r.v);}));
    describe(f, count(data.length, 'minute', 'minutes') + ': lowest ' + Math.round(ext[0])
      + ' bpm, highest ' + Math.round(ext[1]) + ' bpm, average '
      + Math.round(mean(walk.hr)) + ' bpm.');
  }
  // ---------------------------------------------------------------- hover callout
  var callout = document.createElement('div');
  callout.className = 'callout'; callout.hidden = true;
  // each chip is described by the callout, so a screen reader hears its numbers on focus
  callout.id = 'callout';
  el('stage').appendChild(callout);
  var leader = el('leader');
  var shown = null;
  // how the reader last reached for the page: 'key', 'touch' or 'pointer'; the callout's
  // last line names the matching way to open the region
  var via = 'pointer';
  var OPEN = { key:'Press Enter to open', touch:'Tap to open', pointer:'Click to open' };
  document.addEventListener('keydown', function () { via = 'key'; }, true);
  document.addEventListener('pointerdown', function (ev) {
    via = ev.pointerType === 'touch' ? 'touch' : 'pointer'; }, true);
  document.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'mouse') via = 'pointer'; }, true);

  function summary(id) {
    if (!DATA) return null;
    var d = within(DATA.daily), w = within(DATA.walks);
    if (id === 'move') {
      var st = col(d,'steps'), mi = col(d,'miles');
      return { stats:[['Steps per day', or(mean(st), nf)],
                      ['Miles walked', mi.length ? f1(sum(mi))+' mi' : '—'],
                      ['Walks with GPS', String(w.length)]],
               series: st, label:'Steps per day' };
    }
    if (id === 'heart') {
      var rh = col(d,'restingHr'), hv = col(d,'hrv');
      return { stats:[['Resting heart rate', or(mean(rh), function(v){return Math.round(v)+' bpm';})],
                      ['Variability', or(mean(hv), function(v){return Math.round(v)+' ms';})],
                      ['High rate alerts', String(within(DATA.alerts).length)]],
               series: rh, label:'Resting heart rate' };
    }
    if (id === 'sleep') {
      var sl = col(d,'sleepTotal'), dp = col(d,'sleepDeep');
      return { stats:[['Hours per night', or(mean(sl), hrs)],
                      ['Nights recorded', String(sl.length)],
                      ['Deep per night', or(mean(dp), hrs)]],
               series: sl, label:'Hours asleep' };
    }
    if (id === 'sound') {
      var en = col(d,'envAudio'), hp = col(d,'headphoneAudio');
      return { stats:[['Around you', or(mean(en), function(v){return Math.round(v)+' dB';})],
                      ['Loudest day', en.length ? Math.round(Math.max.apply(null,en))+' dB' : '—'],
                      ['Headphone days', String(hp.length)]],
               series: en, label:'Sound around you' };
    }
    var md = within(DATA.meds);
    var taken = md.filter(function(m){return m.status==='Taken';}).length;
    var days = {}; md.forEach(function(m){ days[m.date]=1; });
    return { stats:[['Doses taken', md.length ? taken+' of '+md.length : '—'],
                    ['Days logged', String(Object.keys(days).length)],
                    ['Days of food', String(within(DATA.nutrition).length)]],
             series:null, label:'' };
  }

  function spark(values, color) {
    if (!values || values.length < 2) return '';
    var w = 222, h = 30;
    var lo = Math.min.apply(null,values), hi = Math.max.apply(null,values);
    var rng = (hi-lo) || 1;
    var pts = values.map(function (v,i) {
      return [(i/(values.length-1))*w, h-((v-lo)/rng)*(h-6)-3];
    });
    var d = pts.map(function (p,i) {
      return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1); }).join(' ');
    var last = pts[pts.length-1];
    var gid = 'g'+Math.random().toString(36).slice(2,7);
    return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><linearGradient id="'+gid+'" x1="0" x2="0" y1="0" y2="1">'
      + '<stop offset="0" stop-color="'+color+'" stop-opacity=".34"/>'
      + '<stop offset="1" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>'
      + '<path d="'+d+' L'+w+' '+h+' L0 '+h+' Z" fill="url(#'+gid+')"/>'
      + '<path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6" '
      + 'stroke-linecap="round" stroke-linejoin="round"/>'
      + '<circle cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="2.3" fill="'+color+'"/></svg>';
  }

  function paintCallout(id) {
    var r = BY[id]; if (!r) return;
    var color = css(r.css);
    callout.style.setProperty('--accent', color);
    leader.style.setProperty('--accent', color);
    var s = summary(id);
    var rows = (s ? s.stats : []).map(function (p) {
      return '<dt>'+p[0]+'</dt><dd>'+p[1]+'</dd>'; }).join('');
    var n = s && s.series ? s.series.length : 0;
    callout.innerHTML =
      '<div class="co-zone">'+r.zone+'</div>'
      + '<div class="co-name">'+r.name+'</div>'
      + '<dl class="co-dl">'+rows+'</dl>'
      + (s && s.series ? '<div class="co-spark">'+spark(s.series,color)+'</div>'
          + '<div class="co-sl">'+s.label+' · '+n+(n===1?' day':' days')+'</div>' : '')
      + '<div class="co-go">'+OPEN[via]+'</div>';
    shown = id + via;
  }

  // keeps the box and its tether on the body part as the figure turns
  function frame() {
    var id = hovered;
    if (!id || !window.HOLO.ready || route) {
      callout.hidden = true; leader.replaceChildren(); return;
    }
    if (id + via !== shown) paintCallout(id);
    var a = window.HOLO.anchor(id);
    if (!a) { callout.hidden = true; leader.replaceChildren(); return; }
    callout.hidden = false;
    var st = el('stage').getBoundingClientRect();
    // the band the box may use: below the top bar, above the chips, and on screen
    var hi = 0;
    [].forEach.call(document.querySelector('.topbar').children, function (c) {
      hi = Math.max(hi, c.getBoundingClientRect().bottom - st.top);
    });
    hi = Math.max(hi + 10, -st.top + 10);
    var lo = Math.min(el('zones').getBoundingClientRect().top - st.top,
                      window.innerHeight - st.top) - 10;
    // under 1000px there is no room beside the figure, so the box docks full width
    var docked = st.width < 1000;
    callout.classList.toggle('docked', docked);
    callout.classList.remove('tight');
    var bw = callout.offsetWidth || 252, bh = callout.offsetHeight || 150;
    var left, top, points;
    if (docked) {
      // on the side of the region with more room; drop the sparkline if even that is short
      var above = a.y - hi, below = lo - a.y;
      if (bh + 10 > Math.max(above, below)) {
        callout.classList.add('tight'); bh = callout.offsetHeight || bh;
      }
      left = 16;
      top = below >= above ? Math.max(hi, lo - bh) : hi;
      var edge = top > a.y ? top : top + bh;
      points = a.x+','+a.y+' '+a.x+','+edge;
    } else {
      // parked well clear of the figure, so rotation never runs under it
      left = Math.max(24, Math.min(st.width/2 + 268, st.width - bw - 24));
      top  = Math.max(hi, Math.min(a.y - bh/2, lo - bh));
      var cy = Math.max(top+20, Math.min(a.y, top+bh-20));
      points = a.x+','+a.y+' '+(a.x+46)+','+a.y+' '+(left-30)+','+cy+' '+left+','+cy;
    }
    callout.style.left = left+'px'; callout.style.top = top+'px';
    leader.replaceChildren();
    var NS = 'http://www.w3.org/2000/svg';
    var pl = document.createElementNS(NS,'polyline');
    pl.setAttribute('points', points);
    leader.appendChild(pl);
    var dot = document.createElementNS(NS,'circle');
    dot.setAttribute('cx',a.x); dot.setAttribute('cy',a.y); dot.setAttribute('r',2.6);
    leader.appendChild(dot);
  }
  window.HOLOUI = { frame: frame, open: function (id) { location.hash = id; } };
  window.HOLO.setActive = function (id) { if (id) paintCallout(id); };

  // ---------------------------------------------------------------- chips
  var zones = el('zones');
  REGIONS.forEach(function (r) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'zone'; b.dataset.id = r.id;
    b.style.setProperty('--c', css(r.css));
    b.setAttribute('aria-describedby', 'callout');
    var s = document.createElement('s'); s.setAttribute('aria-hidden','true');
    // the data first, then the body part that holds it: "Sleep · head"
    var label = document.createElement('span');
    var zn = document.createElement('span'); zn.className = 'zn';
    zn.textContent = ' · ' + r.zone.toLowerCase();
    label.append(r.name, zn);
    b.append(s, label);
    // painted now, not on the next frame, so the description is current when focus lands
    var enter = function () { hovered = r.id; window.HOLO.hover(r.id); paintCallout(r.id); };
    var leave = function () { hovered = null; window.HOLO.hover(null); };
    b.addEventListener('pointerenter', enter);
    b.addEventListener('pointerleave', leave);
    b.addEventListener('focus', enter);
    b.addEventListener('blur', leave);
    b.addEventListener('click', function () { location.hash = r.id; });
    zones.append(b);
  });
  // the core reports what the pointer is over; mirror it into `hovered`
  var baseHover = window.HOLO.hover;
  window.HOLO.hover = function (id) { hovered = id || null; baseHover(id); };

  // ---------------------------------------------------------------- range
  var RANGES = [[7,'7 days'],[30,'30 days'],[0,'All']];
  var range = el('range');
  // held here, since a re-render detaches it with the old page before it moves to the new one
  var tools = el('tools');
  RANGES.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = p[1];
    b.setAttribute('aria-pressed', p[0]===RANGE ? 'true':'false');
    b.addEventListener('click', function () {
      RANGE = p[0];
      range.querySelectorAll('button').forEach(function (x) {
        x.setAttribute('aria-pressed', x===b ? 'true':'false'); });
      shown = null;
      if (route) renderPage(route);
    });
    range.append(b);
  });

  // ---------------------------------------------------------------- pages
  var pages = el('pages');
  function card(title, note, wide) {
    var c = document.createElement('div');
    c.className = 'card' + (wide ? ' wide' : '');
    // h2 under the page's h1, so heading levels run in order
    var h = document.createElement('h2'); h.textContent = title; c.append(h);
    if (note) { var n = document.createElement('p'); n.className='note'; n.textContent=note; c.append(n); }
    var p = document.createElement('div'); p.className='plot'; c.append(p);
    c.plot = p;
    return c;
  }
  function table(cols, rows, opts) {
    // .tblbox fades the right edge while more columns sit off to the side
    var box = document.createElement('div'); box.className='tblbox';
    var wrap = document.createElement('div'); wrap.className='tbl';
    var more = function () {
      box.classList.toggle('more', wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
    };
    wrap.addEventListener('scroll', more);
    requestAnimationFrame(more);
    var t = document.createElement('table');
    var th = document.createElement('thead'); var tr = document.createElement('tr');
    // numbers right-aligned, words left-aligned, per column
    cols.forEach(function (c) {
      var e = document.createElement('th'); e.textContent = c.label;
      if (c.num) e.className = 'n';
      tr.append(e); });
    th.append(tr); t.append(th);
    var tb = document.createElement('tbody');
    rows.forEach(function (r) {
      var row = document.createElement('tr');
      var on = opts && opts.pick && opts.isOn && opts.isOn(r);
      if (opts && opts.pick) {
        row.className = 'pick' + (on ? ' on' : '');
        if (on) row.setAttribute('aria-current', 'true');
        row.addEventListener('click', function () { opts.pick(r); });
      }
      cols.forEach(function (c, i) {
        var td = document.createElement('td');
        if (c.num) td.className = 'n';
        var v = c.get(r);
        v = (v === null || v === undefined || v === '') ? '—' : v;
        // the first cell holds a real button, so a row can be picked from the keyboard
        if (i === 0 && opts && opts.pick) {
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'rowpick'; b.textContent = v;
          b.dataset.key = opts.key(r);
          if (opts.label) b.setAttribute('aria-label', opts.label(r));
          td.append(b);
        } else td.textContent = v;
        row.append(td);
      });
      tb.append(row);
    });
    t.append(tb); wrap.append(t); box.append(wrap);
    return box;
  }
  // a list of name and value pairs, so each figure is read with its name
  function kpiRow(items, color) {
    var w = document.createElement('dl'); w.className='kpis';
    items.forEach(function (it) {
      var k = document.createElement('div'); k.className='kpi';
      k.style.setProperty('--accent', color);
      k.innerHTML = '<dt class="k"></dt><dd class="v"></dd>';
      k.querySelector('.k').textContent = it[0];
      k.querySelector('.v').textContent = it[1];
      w.append(k);
    });
    return w;
  }

  // the grid holds two columns at most; a card that would sit alone in its row
  // (before a wide card or at the end) takes the whole row instead
  function fillRows(body) {
    var cards = [].slice.call(body.children), slot = 0;
    cards.forEach(function (c, i) {
      if (c.classList.contains('wide')) { slot = 0; return; }
      var next = cards[i+1];
      if (slot === 0 && (!next || next.classList.contains('wide'))) c.classList.add('wide');
      else slot = 1 - slot;
    });
  }

  function renderPage(id) {
    var r = BY[id]; if (!r || !DATA) return;
    var color = css(r.css);
    // a re-render (range, walk pick, resize) replaces every node; note what had focus
    // so the same control has it afterwards
    var had = document.activeElement, again = route === id && pages.contains(had) || tools.contains(had);
    var key = had && had.dataset && had.dataset.key;
    pages.replaceChildren();
    var draws = [];
    var page = document.createElement('section');
    page.className = 'page on';
    page.style.setProperty('--accent', color);

    var head = document.createElement('div'); head.className='pagehead';
    var left = document.createElement('div');
    var back = document.createElement('a');
    back.className='backlink'; back.href='#'; back.textContent='← Glassbody';
    // the page's own h1; the hologram's is hidden with the stage. tabindex lets the
    // router move focus here when the page opens
    var h1 = document.createElement('h1'); h1.textContent = r.name; h1.tabIndex = -1;
    var sub = document.createElement('p'); sub.className='sub';
    sub.textContent = r.zone + ' · ' + (RANGE ? 'last '+RANGE+' days' : 'everything recorded');
    left.append(back, h1, sub);
    // the range group and the Data button move here from the top bar while a page is open
    head.append(left, tools);
    page.append(head);

    var d = within(DATA.daily), walks = within(DATA.walks);
    var body = document.createElement('div'); body.className='cards';

    function add(c) { body.append(c); return c; }

    if (id === 'move') {
      var st = col(d,'steps'), mi = col(d,'miles'), fl = col(d,'flights');
      page.append(kpiRow([
        ['Steps per day', or(mean(st), nf)],
        ['Miles walked', mi.length ? f1(sum(mi))+' mi' : '—'],
        ['Tracked walks', String(walks.length)],
        ['Flights climbed', fl.length ? nf(sum(fl)) : '—']], color));
      var c1 = add(card('Steps per day','Daily totals; the dashed line is the average for this range.',true));
      draws.push(function () { barChart(c1.plot, d, 'steps', color, d3.format(','), 'steps'); });
      var c2 = add(card('Walking pace','Average walking speed each day, in miles per hour.'));
      draws.push(function () { lineChart(c2.plot, d, 'walkMph', color, f2, 'mph'); });
      var c3 = add(card('Time in daylight','Minutes outdoors per day, from the light sensor.'));
      draws.push(function () { barChart(c3.plot, d, 'daylightMin', color, function(v){return Math.round(v);}, 'min'); });
      var c4 = add(card('Step length','Inches per step, averaged over each day.'));
      draws.push(function () { lineChart(c4.plot, d, 'stepLenIn', color, f1, 'in'); });
      var c5 = add(card('Walking asymmetry','Percent of walking time that is uneven between sides.'));
      draws.push(function () { lineChart(c5.plot, d, 'walkAsym', color, f1, '%'); });

      var tw = add(card('Every tracked walk','Pick a walk to see its route and heart rate.',true));
      tw.plot.remove();
      if (!walks.length) {
        var e = document.createElement('div'); e.className='empty';
        e.textContent = 'No walks in this range.'; tw.append(e);
      } else {
        if (!picked || !walks.some(function(w){return w.id===picked;})) {
          picked = walks.reduce(function (a,b) { return b.miles>a.miles?b:a; }).id;
        }
        tw.append(table([
          {label:'Date', get:function(w){return fmtDate(w.date);}},
          {label:'Start', get:function(w){return w.time;}},
          {label:'Min', num:true, get:function(w){return f1(w.durMin);}},
          {label:'Miles', num:true, get:function(w){return f2(w.miles);}},
          {label:'mph', num:true, get:function(w){return f2(w.mphAvg);}},
          {label:'Steps', num:true, get:function(w){return nf(w.steps);}},
          {label:'Cadence', num:true, get:function(w){return nf(w.cadence);}},
          {label:'kcal', num:true, get:function(w){return nf(w.kcal);}},
          {label:'Avg HR', num:true, get:function(w){return nf(w.hrAvg);}},
          {label:'Max HR', num:true, get:function(w){return nf(w.hrMax);}},
          {label:'Ascent ft', num:true, get:function(w){return nf(w.ascentFt);}},
          {label:'°F', num:true, get:function(w){return nf(w.tempF);}}
        ], walks.slice().sort(function(a,b){return a.id<b.id?1:-1;}), {
          pick: function (w) { picked = w.id; renderPage(id); },
          isOn: function (w) { return w.id === picked; },
          key: function (w) { return 'walk ' + w.id; },
          label: function (w) { return 'Walk on ' + fmtDate(w.date) + ' at ' + w.time; }
        }));

        var cr = add(card('Routes','Each shape is one walk’s GPS track, drawn to its own scale.',true));
        cr.plot.remove();
        var grid = document.createElement('div'); grid.className='routes';
        walks.slice().sort(function(a,b){return a.id<b.id?-1:1;}).forEach(function (w) {
          if (!w.route || w.route.length < 2) return;
          var b = document.createElement('button');
          b.type='button'; b.className='rt'+(w.id===picked?' on':'');
          b.setAttribute('aria-label','Route of the walk on '+fmtDate(w.date)+' at '+w.time);
          b.setAttribute('aria-pressed', w.id===picked ? 'true' : 'false');
          b.dataset.key = 'route ' + w.id;
          var box = document.createElement('div');
          var xy = routePath(w.route, 100, 80, 8);
          box.innerHTML = '<svg viewBox="0 0 100 80" preserveAspectRatio="xMidYMid meet">'
            + '<path d="'+xy.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ')
            + '" fill="none" stroke="'+(w.id===picked?color:css('--mark'))+'" stroke-width="1.6" '
            + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
          var cap = document.createElement('div'); cap.className='cap';
          cap.textContent = fmtDate(w.date)+' · '+f2(w.miles)+' mi';
          b.append(box, cap);
          b.addEventListener('click', function () { picked = w.id; renderPage(id); });
          grid.append(b);
        });
        cr.append(grid);

        var sel = walks.filter(function(w){return w.id===picked;})[0];
        var cs = add(card('Selected route', sel ? fmtDate(sel.date)+' at '+sel.time+' · '
          +f2(sel.miles)+' mi in '+f1(sel.durMin)+' min'
          +(num(sel.ascentFt) === null ? '' : ' · '+nf(sel.ascentFt)+' ft of ascent') : ''));
        if (sel && sel.route && sel.route.length > 1) {
          var xy2 = routePath(sel.route, 320, 210, 16);
          // the card's note already says when, how far and how long, in words
          cs.plot.innerHTML = '<svg viewBox="0 0 320 210" preserveAspectRatio="xMidYMid meet" aria-hidden="true">'
            + '<path d="'+xy2.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1);}).join(' ')
            + '" fill="none" stroke="'+color+'" stroke-width="2.4" stroke-linecap="round" '
            + 'stroke-linejoin="round"/>'
            + '<circle cx="'+xy2[0][0].toFixed(1)+'" cy="'+xy2[0][1].toFixed(1)+'" r="4" fill="#080d18" stroke="'+color+'" stroke-width="2"/>'
            + '<circle cx="'+xy2[xy2.length-1][0].toFixed(1)+'" cy="'+xy2[xy2.length-1][1].toFixed(1)+'" r="4" fill="'+color+'"/></svg>';
        } else { emptyNote(cs.plot, 'No route recorded.'); }
        var ch = add(card('Heart rate during the walk','Beats per minute, minute by minute.'));
        draws.push(function () { hrChart(ch.plot, sel, css('--heart')); });
      }
    }

    if (id === 'heart') {
      var rh = col(d,'restingHr'), hv = col(d,'hrv'), sp = col(d,'spo2'), rr = col(d,'respRate');
      var alerts = within(DATA.alerts);
      page.append(kpiRow([
        ['Resting heart rate', or(mean(rh), function(v){return Math.round(v)+' bpm';})],
        ['Variability', or(mean(hv), function(v){return Math.round(v)+' ms';})],
        ['Blood oxygen', or(mean(sp), function(v){return f1(v)+'%';})],
        ['High rate alerts', String(alerts.length)]], color));
      var a1 = add(card('Resting heart rate','Beats per minute, one reading per day.'));
      draws.push(function () { lineChart(a1.plot, d, 'restingHr', color, function(v){return Math.round(v);}, 'bpm'); });
      var a2 = add(card('Heart rate variability','Milliseconds. Higher means more variation between beats.'));
      draws.push(function () { lineChart(a2.plot, d, 'hrv', color, f1, 'ms'); });
      var a3 = add(card('Blood oxygen','Percent saturation, daily average from the watch sensor.'));
      draws.push(function () { lineChart(a3.plot, d, 'spo2', color, f1, '%'); });
      var a4 = add(card('Respiratory rate','Breaths per minute, measured while asleep.'));
      draws.push(function () { lineChart(a4.plot, d, 'respRate', color, f1, 'breaths/min'); });
      var a5 = add(card('Walking heart rate','Average pulse while walking, per day.'));
      draws.push(function () { lineChart(a5.plot, d, 'walkingHr', color, function(v){return Math.round(v);}, 'bpm'); });

      var ca = add(card('High heart rate alerts',
        'The watch’s own notifications, not a clinical finding.'));
      ca.plot.remove();
      if (!alerts.length) {
        var ae = document.createElement('div'); ae.className='empty';
        ae.textContent = 'No alerts in this range.'; ca.append(ae);
      } else {
        ca.append(table([
          {label:'When', get:function(a){return fmtWhen(a.when);}},
          {label:'Peak', num:true, get:function(a){return withUnit(a.peak, nf, 'bpm');}},
          {label:'Threshold', num:true, get:function(a){return withUnit(a.threshold, nf, 'bpm');}}
        ], alerts.slice().sort(function(a,b){return a.when<b.when?1:-1;})));
      }
      var ecgs = within(DATA.ecgs || []);
      var ce = add(card('ECG', ecgs.length === 1 ? 'One reading taken with the watch.'
        : ecgs.length ? ecgs.length + ' readings taken with the watch.' : '', true));
      ce.plot.remove();
      if (!ecgs.length) {
        var ee = document.createElement('div'); ee.className = 'empty';
        ee.textContent = 'No ECG in this range.'; ce.append(ee);
      } else {
        ce.append(table([
          {label:'Taken', get:function(e){return fmtWhen(e.when);}},
          {label:'Classification', get:function(e){return e['class'];}},
          {label:'Avg rate', num:true, get:function(e){return withUnit(e.bpm, nf, 'bpm');}},
          {label:'Samples', num:true, get:function(e){
            return num(e.samples) === null ? null : nf(e.samples) + ' @ ' + nf(e.hz) + ' Hz'; }}
        ], ecgs.slice().sort(function(a,b){return a.when<b.when?1:-1;})));
      }
      var cf = add(card('Fitness measures','Recorded on some days only.'));
      cf.plot.remove();
      var vo = col(d,'vo2max'), rc = col(d,'cardioRecovery'), wt = col(d,'weightLb'), bm = col(d,'bmi');
      var dl2 = document.createElement('dl'); dl2.className='dl2';
      dl2.innerHTML =
        '<dt>VO₂ max</dt><dd>'+(vo.length?f1(mean(vo))+' ml/kg/min over '+count(vo.length,'reading','readings'):'—')+'</dd>'
        + '<dt>Cardio recovery</dt><dd>'+(rc.length?Math.round(mean(rc))+' bpm drop over '+count(rc.length,'reading','readings'):'—')+'</dd>'
        + '<dt>Weight</dt><dd>'+(wt.length?f1(Math.min.apply(null,wt))+'–'+f1(Math.max.apply(null,wt))+' lb':'—')+'</dd>'
        + '<dt>Body mass index</dt><dd>'+(bm.length?f1(Math.min.apply(null,bm))+'–'+f1(Math.max.apply(null,bm)):'—')+'</dd>';
      cf.append(dl2);
    }

    if (id === 'sleep') {
      var sl = col(d,'sleepTotal'), dp = col(d,'sleepDeep'),
          rm = col(d,'sleepRem'), aw = col(d,'sleepAwake');
      page.append(kpiRow([
        ['Hours per night', or(mean(sl), hrs)],
        ['Nights recorded', String(sl.length)],
        ['Deep per night', or(mean(dp), hrs)],
        ['REM per night', or(mean(rm), hrs)]], color));
      var s1 = add(card('Hours by stage, per night',
        'Stacked by stage and labelled by the morning you woke up.', true));
      draws.push(function () { sleepChart(s1.plot, d); });
      var lg = document.createElement('div'); lg.className='legend';
      lg.innerHTML = STAGES.map(function (s,i) {
        return '<span><i style="background:'+STAGE_C[i]+'"></i>'+s[1]+'</span>'; }).join('');
      s1.append(lg);
      var s2 = add(card('Time asleep','Total hours per night.'));
      draws.push(function () { barChart(s2.plot, d, 'sleepTotal', color, hTick, '', hrs); });
      var s3 = add(card('Awake during the night','Hours awake between falling asleep and getting up.'));
      draws.push(function () { barChart(s3.plot, d, 'sleepAwake', color, hTick, '', hrs); });
    }

    if (id === 'sound') {
      var en = col(d,'envAudio'), hp = col(d,'headphoneAudio');
      page.append(kpiRow([
        ['Around you', or(mean(en), function(v){return Math.round(v)+' dB';})],
        ['Loudest day', en.length ? Math.round(Math.max.apply(null,en))+' dB' : '—'],
        ['Headphone days', String(hp.length)],
        ['Headphone average', or(mean(hp), function(v){return Math.round(v)+' dB';})]], color));
      var o1 = add(card('Sound around you','Decibels from the watch microphone, averaged per day.', true));
      draws.push(function () { lineChart(o1.plot, d, 'envAudio', color, function(v){return Math.round(v);}, 'dB'); });
      var o2 = add(card('Headphone volume','Decibels through your headphones, on days you used them.'));
      draws.push(function () { lineChart(o2.plot, d, 'headphoneAudio', color, function(v){return Math.round(v);}, 'dB'); });
      var o3 = add(card('About the threshold','Apple treats sustained exposure above 80 decibels as worth watching. These are daily averages, so a short loud moment can hide inside a quiet day.'));
      o3.plot.remove();
    }

    if (id === 'fuel') {
      var md = within(DATA.meds), nut = within(DATA.nutrition);
      var taken = md.filter(function(m){return m.status==='Taken';}).length;
      var skipped = md.filter(function(m){return m.status==='Skipped';}).length;
      var dys = {}; md.forEach(function(m){ dys[m.date]=1; });
      page.append(kpiRow([
        ['Doses taken', md.length ? taken+' of '+md.length : '—'],
        ['Doses skipped', String(skipped)],
        ['Days logged', String(Object.keys(dys).length)],
        ['Days of food', String(nut.length)]], color));
      var m1 = add(card('Doses by medication','Taken, skipped, and left unanswered.', true));
      draws.push(function () { medChart(m1.plot, md); });
      var m2 = add(card('Every logged dose',
        '“Not interacted” means the reminder was neither confirmed nor dismissed.', true));
      m2.plot.remove();
      if (!md.length) {
        var me2 = document.createElement('div'); me2.className='empty';
        me2.textContent='No doses logged in this range.'; m2.append(me2);
      } else {
        m2.append(table([
          {label:'Date', get:function(m){return fmtDate(m.date);}},
          {label:'Time', get:function(m){return m.time;}},
          {label:'Name', get:function(m){return m.name;}},
          {label:'Medication', get:function(m){return m.med;}},
          {label:'Dose', get:function(m){return m.dose;}},
          {label:'Status', get:function(m){return m.status;}}
        ], md.slice().sort(function(a,b){return (a.date+a.time)<(b.date+b.time)?1:-1;})));
      }
      var m3 = add(card('Food logged', nut.length
        ? 'Only what was recorded in Health. Keep logging and this becomes a trend.'
        : 'Nothing was logged in this range.', true));
      m3.plot.remove();
      if (nut.length) {
        m3.append(table([
          {label:'Date', get:function(n){return fmtDate(n.date);}},
          {label:'kcal', num:true, get:function(n){return nf(n.energyKcal);}},
          {label:'Carbs g', num:true, get:function(n){return f1(n.carbsG);}},
          {label:'Protein g', num:true, get:function(n){return f1(n.proteinG);}},
          {label:'Fat g', num:true, get:function(n){return f1(n.fatG);}},
          {label:'Fiber g', num:true, get:function(n){return f1(n.fiberG);}},
          {label:'Sugar g', num:true, get:function(n){return f1(n.sugarG);}},
          {label:'Sodium mg', num:true, get:function(n){return nf(n.sodiumMg);}},
          {label:'Water ml', num:true, get:function(n){return nf(n.waterMl);}}
        ], nut.slice().sort(function(a,b){return a.date<b.date?1:-1;})));
      }
    }

    fillRows(body);
    page.append(body);
    pages.append(page);
    // now that the cards have a width, draw into them
    draws.forEach(function (f) { f(); });
    back.addEventListener('click', function (ev) {
      ev.preventDefault(); location.hash = '';
    });
    if (again) {
      var same = key ? page.querySelector('[data-key="' + key + '"]')
        : had.tagName === 'H1' ? h1 : had;
      (same && same.isConnected ? same : h1).focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------------------- router
  var topbar = document.querySelector('.topbar');
  function show(id) {
    var was = route;
    var onPage = !!id;
    if (!onPage && was) topbar.append(tools);
    route = id;
    el('stage').style.display = onPage ? 'none' : '';
    el('below').style.display = onPage ? 'none' : '';
    window.HOLO.setPaused(onPage);
    document.title = onPage ? BY[id].name + ' · Glassbody' : 'Glassbody';
    if (onPage) { renderPage(id); window.scrollTo(0, 0); }
    else { pages.replaceChildren(); }
    if (id === was) return;
    // a new route moves focus: to the page heading on the way in, and back to the
    // region's chip on the way out, so keyboard and screen reader users keep their place
    if (onPage) pages.querySelector('h1').focus({ preventScroll: true });
    else if (was) zones.querySelector('[data-id="' + was + '"]').focus({ preventScroll: true });
  }
  function readHash() {
    var h = (location.hash || '').replace('#','');
    show(BY[h] && DATA ? h : null);
  }
  window.addEventListener('hashchange', readHash);
  var resizeT = null;
  window.addEventListener('resize', function () {
    if (!route) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { renderPage(route); }, 180);
  });

  // ---------------------------------------------------------------- data in
  // the Data panel calls this after every import, restore, sample or erase
  function setData(store) {
    DATA = store || null;
    var m = DATA && DATA.meta;
    el('d0').textContent = m && m.start ? fmtDate(m.start) : '\u2014';
    el('dn').textContent = m ? m.days : '\u2014';
    // meta.updated is a UTC instant, "2026-10-29 01:00Z"; show the reader's own calendar day
    var upd = m && m.updated ? new Date(String(m.updated).replace(' ', 'T')) : null;
    el('upd').textContent = upd && !isNaN(upd) ? ' \u00b7 last import '
      + upd.toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
    shown = null;
    readHash();
  }
  window.Glassbody = { setData: setData };

  // data-panel.js loads after this file, so wait for it if the store answers first
  function openPanel(note) {
    if (window.GlassbodyPanel) window.GlassbodyPanel.open(note);
    else window.addEventListener('DOMContentLoaded', function () { openPanel(note); });
  }
  window.HealthStore.load().then(function (store) {
    if (store) setData(store);
    else openPanel();
  }).catch(function (e) {
    openPanel('Stored data could not be read: ' + (e && e.message || e));
  });
})();
