(function () {
  'use strict';
  var canvas = document.getElementById('gl');
  // the system setting can change while the page is open, so keep the query
  var MQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var REDUCED = MQ.matches;
  // still: no spin, no drift after a drag, no scan band, time frozen. The Pause motion
  // button sets it; it starts on with reduced motion or the reader's saved choice.
  // The key keeps its name from before the rename (docs/architecture.md, section 2).
  var MOTION_KEY = 'body-scan-motion';
  var saved = null;
  try { saved = localStorage.getItem(MOTION_KEY); } catch (e) { saved = null; }
  var still = saved === 'still' ? true : saved === 'moving' ? false : REDUCED;

  var REGIONS = [
    { id:'move',  zone:'Legs and feet',  name:'Movement',            css:'--move',
      go:'Steps, distance, pace and every tracked walk.' },
    { id:'heart', zone:'Chest and arms', name:'Heart and lungs',     css:'--heart',
      go:'Pulse, variability, blood oxygen, breathing and the ECG.' },
    { id:'sleep', zone:'Head',           name:'Sleep',               css:'--sleep',
      go:'Time asleep, split into core, deep and REM.' },
    { id:'sound', zone:'Ears',           name:'Sound exposure',      css:'--sound',
      go:'Decibels around you and through your headphones.' },
    { id:'fuel',  zone:'Abdomen',        name:'Medication and food', css:'--fuel',
      go:'Doses logged, and whatever food was recorded.' }
  ];
  var css = function (n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  };

  // opened from disk, the browser refuses data/body.json and the vendored scripts
  var FROM_DISK = location.protocol === 'file:';
  var gl = null;
  if (!FROM_DISK) {
    try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); } catch (e) { gl = null; }
  }
  if (!gl || !window.THREE) {
    canvas.remove();
    var msg = document.createElement('div');
    msg.className = 'nogl';
    msg.textContent = FROM_DISK
      ? 'This page does not work opened from disk. Serve the folder with '
        + 'python3 -m http.server 8000 --bind 127.0.0.1 and open http://127.0.0.1:8000/.'
      : 'This view needs WebGL, which this browser is not providing.';
    document.getElementById('stage').prepend(msg);
  }

  var renderer, scene, camera, raycaster, groups = {}, mats = {}, picks = [];
  var anchors = {};                       // region id -> Vector3 on the body
  var rtScene, rtA, rtB, quadScene, quadCam, quadMesh;
  var matBright, matBlur, matComp;
  var W = 1, H = 1, DPR = 1;
  var FIT = 1;                            // camera distance factor that keeps the feet above the chips
  var HOME = { dist: 366, ty: 92 };
  var cam = { az:-0.5, el:0.05, dist:HOME.dist, vaz:0, target:new THREE.Vector3(0,HOME.ty,0) };
  var want = { dist: HOME.dist, target: new THREE.Vector3(0, HOME.ty, 0) };
  var drag = null, idle = 0, active = 'move', clock = 0, paused = false;

  function build() {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setClearColor(0x04060c, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
    raycaster = new THREE.Raycaster();

    var VERT = [
      'varying vec3 vN; varying vec3 vV; varying vec3 vW;',
      'void main() {',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vW = wp.xyz;',
      '  vN = normalize(mat3(modelMatrix) * normal);',
      '  vV = normalize(cameraPosition - wp.xyz);',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '}'
    ].join('\n');
    var FRAG = [
      'uniform vec3 uColor; uniform float uHi; uniform float uTime; uniform float uSweep;',
      'varying vec3 vN; varying vec3 vV; varying vec3 vW;',
      'void main() {',
      '  float ndv = abs(dot(normalize(vN), normalize(vV)));',
      '  float rim = pow(1.0 - ndv, 2.3);',
      '  float scan = 0.5 + 0.5 * sin(vW.y * 2.6 - uTime * 1.5);',
      '  float band = exp(-pow((vW.y - uSweep) * 0.14, 2.0));',
      '  float a = rim * 0.74 + 0.055 + scan * 0.045 + band * 0.26;',
      '  vec3 c = uColor * (0.46 + rim * 1.45 + band * 0.95 + scan * 0.10);',
      '  a *= 0.72 + uHi * 0.28;',
      '  gl_FragColor = vec4(c * (0.80 + uHi * 0.20), clamp(a, 0.0, 1.0));',
      '}'
    ].join('\n');

    REGIONS.forEach(function (r) {
      mats[r.id] = new THREE.ShaderMaterial({
        uniforms: { uColor:{value:new THREE.Color(css(r.css))}, uHi:{value:r.id===active?1:0},
                    uTime:{value:0}, uSweep:{value:0} },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent:true, depthWrite:false, side:THREE.DoubleSide,
        blending:THREE.AdditiveBlending
      });
      groups[r.id] = new THREE.Group();
      scene.add(groups[r.id]);
    });

    var ringGeo = new THREE.BufferGeometry(), rp = [];
    for (var k = 1; k <= 5; k++) {
      var rad = k * 16;
      for (var i = 0; i < 96; i++) {
        var a0 = i/96*Math.PI*2, a1 = (i+1)/96*Math.PI*2;
        rp.push(Math.cos(a0)*rad,0,Math.sin(a0)*rad, Math.cos(a1)*rad,0,Math.sin(a1)*rad);
      }
    }
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    scene.add(new THREE.LineSegments(ringGeo, new THREE.LineBasicMaterial({
      color: new THREE.Color(css('--cy')), transparent:true, opacity:0.09 })));

    var mp = [];
    for (var j = 0; j < 420; j++) {
      var rr = 120 + Math.random()*260, aa = Math.random()*Math.PI*2;
      mp.push(Math.cos(aa)*rr, Math.random()*260-20, Math.sin(aa)*rr);
    }
    var moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    var motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
      color:new THREE.Color(css('--cy')), size:1.5, transparent:true, opacity:0.30,
      blending:THREE.AdditiveBlending, depthWrite:false, sizeAttenuation:true }));
    scene.add(motes); scene.userData.motes = motes;

    var opt = { type:THREE.HalfFloatType, format:THREE.RGBAFormat,
                minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter };
    rtScene = new THREE.WebGLRenderTarget(2,2,opt);
    rtA = new THREE.WebGLRenderTarget(2,2,opt);
    rtB = new THREE.WebGLRenderTarget(2,2,opt);
    var QV = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }';
    matBright = new THREE.ShaderMaterial({
      uniforms:{ tD:{value:null}, uT:{value:0.34} }, vertexShader:QV,
      fragmentShader:[
        'uniform sampler2D tD; uniform float uT; varying vec2 vUv;',
        'void main(){ vec3 c = texture2D(tD, vUv).rgb;',
        '  float l = dot(c, vec3(0.2126,0.7152,0.0722));',
        '  gl_FragColor = vec4(c * smoothstep(uT, uT+0.45, l), 1.0); }'].join('\n') });
    matBlur = new THREE.ShaderMaterial({
      uniforms:{ tD:{value:null}, uDir:{value:new THREE.Vector2(1,0)},
                 uRes:{value:new THREE.Vector2(1,1)} }, vertexShader:QV,
      fragmentShader:[
        'uniform sampler2D tD; uniform vec2 uDir; uniform vec2 uRes; varying vec2 vUv;',
        'void main(){ vec2 s = uDir / uRes;',
        '  vec3 o = texture2D(tD, vUv).rgb * 0.2270270270;',
        '  o += texture2D(tD, vUv + s*1.3846153846).rgb * 0.3162162162;',
        '  o += texture2D(tD, vUv - s*1.3846153846).rgb * 0.3162162162;',
        '  o += texture2D(tD, vUv + s*3.2307692308).rgb * 0.0702702703;',
        '  o += texture2D(tD, vUv - s*3.2307692308).rgb * 0.0702702703;',
        '  gl_FragColor = vec4(o, 1.0); }'].join('\n') });
    matComp = new THREE.ShaderMaterial({
      uniforms:{ tScene:{value:null}, tBloom:{value:null}, uTime:{value:0}, uBand:{value:1},
                 uRes:{value:new THREE.Vector2(1,1)} }, vertexShader:QV,
      fragmentShader:[
        'uniform sampler2D tScene; uniform sampler2D tBloom;',
        'uniform float uTime; uniform float uBand; uniform vec2 uRes; varying vec2 vUv;',
        'void main(){',
        '  vec3 base = texture2D(tScene, vUv).rgb;',
        '  vec3 bl = texture2D(tBloom, vUv).rgb;',
        '  vec3 c = base + bl * 1.05;',
        '  float sl = 0.965 + 0.035 * sin(vUv.y * uRes.y * 1.6);',
        '  c *= sl;',
        '  float sweep = fract(uTime * 0.06);',
        '  c += vec3(0.16,0.52,0.66) * exp(-pow((vUv.y - sweep)*42.0, 2.0)) * 0.30 * uBand;',
        '  vec2 q = vUv - 0.5;',
        '  c *= 1.0 - dot(q,q) * 0.72;',
        '  gl_FragColor = vec4(c, 1.0); }'].join('\n') });
    quadScene = new THREE.Scene();
    quadCam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2), matBright);
    quadScene.add(quadMesh);
  }

  function buildBody(data) {
    if (!data || !data.regions) return;
    Object.keys(data.regions).forEach(function (k) {
      if (!mats[k] || !groups[k]) return;
      var r = data.regions[k];
      if (!r.pos || !r.idx) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(r.pos, 3));
      g.setIndex(r.idx);
      if (data.flat) { g = g.toNonIndexed(); }   // faceted source shades flat
      g.computeVertexNormals();
      var m = new THREE.Mesh(g, mats[k]);
      m.userData.region = k;
      groups[k].add(m); picks.push(m);

      // Where the callout's leader line should point. A plain centroid drifts:
      // with the arms raised, 'heart' lands up by the neck, so torso regions are
      // measured from their central vertices only, and 'sound' points at an ear.
      var n = r.pos.length / 3;
      var lim = (k === 'heart' || k === 'fuel') ? 18 : 1e9;
      var sx = 0, sy = 0, sz = 0, cnt = 0, best = null;
      for (var i = 0; i < n; i++) {
        var x = r.pos[i*3], y = r.pos[i*3+1], z = r.pos[i*3+2];
        if (k === 'sound' && (best === null || x > best)) { best = x; }
        if (Math.abs(x) > lim) continue;
        sx += x; sy += y; sz += z; cnt++;
      }
      if (!cnt) { sx = r.pos[0]; sy = r.pos[1]; sz = r.pos[2]; cnt = 1; }
      var a = new THREE.Vector3(sx/cnt, sy/cnt, sz/cnt);
      if (k === 'sound' && best !== null) { a.x = best * 0.9; }
      anchors[k] = a;
    });
    window.HOLO.ready = true;
  }

  function resize() {
    var r = canvas.getBoundingClientRect();
    W = Math.max(240, Math.round(r.width)); H = Math.max(240, Math.round(r.height));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(DPR); renderer.setSize(W, H, false);
    camera.aspect = W/H;
    // the chip bar covers the bottom of the canvas: shrink the figure about the centre
    // and raise it by the same amount, so the band above the chips holds all of it
    var z = document.getElementById('zones'), bar = document.querySelector('.topbar');
    var lift = z ? Math.max(0, Math.min(H*0.3, r.bottom - z.getBoundingClientRect().top + 8)) : 0;
    // under 700px the title crosses the figure, so the band also starts below the top bar
    var drop = 0;
    if (bar && W < 700) [].forEach.call(bar.children, function (c) {
      drop = Math.max(drop, c.getBoundingClientRect().bottom - r.top + 8);
    });
    drop = Math.max(0, Math.min(H*0.3, drop));
    FIT = H / (H - lift - drop);
    if (lift || drop) camera.setViewOffset(W, H, 0, (lift - drop)/2, W, H);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    var pw = Math.round(W*DPR), ph = Math.round(H*DPR);
    rtScene.setSize(pw, ph);
    rtA.setSize(Math.max(1,pw>>1), Math.max(1,ph>>1));
    rtB.setSize(Math.max(1,pw>>1), Math.max(1,ph>>1));
    matComp.uniforms.uRes.value.set(ph/DPR, ph/DPR);
  }

  function placeCamera() {
    var ce = Math.max(-0.5, Math.min(0.75, cam.el));
    camera.position.set(
      Math.sin(cam.az)*Math.cos(ce)*cam.dist*FIT,
      cam.target.y + Math.sin(ce)*cam.dist*FIT,
      Math.cos(cam.az)*Math.cos(ce)*cam.dist*FIT);
    camera.lookAt(cam.target);
  }

  function pass(material, target) {
    quadMesh.material = material;
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
  }

  function render(dt) {
    // the shaders' stripes, sweep and motes all run on clock, so holding it holds them
    if (!still) clock += dt;
    if (!still && !drag) {
      idle += dt;
      if (idle > 1.1) cam.vaz += (0.16 - cam.vaz) * Math.min(1, dt*2);
    }
    cam.az += cam.vaz * dt;
    if (drag || still) cam.vaz *= Math.pow(0.001, dt);
    // ease toward the wanted framing
    var e = Math.min(1, dt * 3.2);
    cam.dist += (want.dist - cam.dist) * e;
    cam.target.lerp(want.target, e);
    placeCamera();

    var sweep = (clock*34) % 212 - 16;
    REGIONS.forEach(function (r) {
      var u = mats[r.id].uniforms;
      // still, the band is parked far below the feet rather than frozen across the body
      u.uTime.value = clock; u.uSweep.value = still ? -1e4 : sweep;
      var wv = r.id === active ? 1 : 0;
      // the highlight fades in when moving, and switches when still
      u.uHi.value = still ? wv : u.uHi.value + (wv - u.uHi.value) * Math.min(1, dt*7);
    });
    if (scene.userData.motes) scene.userData.motes.rotation.y = clock*0.012;

    renderer.setRenderTarget(rtScene); renderer.clear(); renderer.render(scene, camera);
    matBright.uniforms.tD.value = rtScene.texture; pass(matBright, rtA);
    matBlur.uniforms.uRes.value.set(rtA.width, rtA.height);
    matBlur.uniforms.tD.value = rtA.texture; matBlur.uniforms.uDir.value.set(1.4,0); pass(matBlur, rtB);
    matBlur.uniforms.tD.value = rtB.texture; matBlur.uniforms.uDir.value.set(0,1.4); pass(matBlur, rtA);
    matBlur.uniforms.tD.value = rtA.texture; matBlur.uniforms.uDir.value.set(2.6,0); pass(matBlur, rtB);
    matBlur.uniforms.tD.value = rtB.texture; matBlur.uniforms.uDir.value.set(0,2.6); pass(matBlur, rtA);
    matComp.uniforms.tScene.value = rtScene.texture;
    matComp.uniforms.tBloom.value = rtA.texture;
    matComp.uniforms.uTime.value = clock;
    // a frozen sweep would be a stray line across the screen, so it goes
    matComp.uniforms.uBand.value = still ? 0 : 1;
    pass(matComp, null);

    if (window.HOLOUI && window.HOLOUI.frame) window.HOLOUI.frame();
  }

  var ndc = new THREE.Vector2();
  function hit(ev) {
    var r = canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left)/r.width)*2 - 1;
    ndc.y = -((ev.clientY - r.top)/r.height)*2 + 1;
    raycaster.setFromCamera(ndc, camera);
    var is = raycaster.intersectObjects(picks, false);
    return is.length ? is[0].object.userData.region : null;
  }

  window.HOLO = {
    regions: REGIONS,
    ready: false,
    setActive: function () {},
    // where on screen a region's anchor currently sits
    anchor: function (id) {
      if (!anchors[id] || !camera) return null;
      var v = anchors[id].clone().project(camera);
      if (v.z > 1) return null;
      return { x: (v.x*0.5+0.5)*W, y: (-v.y*0.5+0.5)*H };
    },
    open: function (id) { if (window.HOLOUI && window.HOLOUI.open) window.HOLOUI.open(id); },
    // stops drawing altogether, while the stage is hidden behind a region page
    setPaused: function (v) { paused = !!v; },
    // stops the motion and keeps drawing, so hover, drag and the callout still work
    setStill: function (v, keep) { setStill(v, keep); },
    // what the tests read to see that time and rotation stand still
    motion: function () {
      return { still: still, reduced: REDUCED, clock: clock, az: cam.az, vaz: cam.vaz,
               sweep: mats.move ? mats.move.uniforms.uSweep.value : null };
    },
    hover: function (id) {
      if (id === active) return;
      active = id || 'move';
      window.HOLO.setActive(active, false);
    }
  };

  var pauseBtn = document.getElementById('pause');
  // keep: remember the choice for the next visit (a press of the button does; a change
  // of the system setting does not)
  function setStill(v, keep) {
    still = !!v;
    if (still) cam.vaz = 0;
    if (pauseBtn) pauseBtn.setAttribute('aria-pressed', still ? 'true' : 'false');
    if (keep) {
      try { localStorage.setItem(MOTION_KEY, still ? 'still' : 'moving'); } catch (e) { /* private mode */ }
    }
  }
  // a change of the system setting is followed unless the reader has pressed the button
  function onMotionSetting(e) {
    REDUCED = e.matches;
    var chosen = null;
    try { chosen = localStorage.getItem(MOTION_KEY); } catch (err) { chosen = null; }
    if (chosen === null) setStill(REDUCED);
  }
  if (MQ.addEventListener) MQ.addEventListener('change', onMotionSetting);
  else if (MQ.addListener) MQ.addListener(onMotionSetting);

  function wire() {
    if (pauseBtn) {
      pauseBtn.hidden = false;
      pauseBtn.addEventListener('click', function () { setStill(!still, true); });
      setStill(still);
    }
    canvas.addEventListener('pointerdown', function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('dragging');
      drag = { x:ev.clientX, y:ev.clientY, az:cam.az, el:cam.el, moved:0 };
      idle = 0;
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (drag) {
        var dx = ev.clientX-drag.x, dy = ev.clientY-drag.y;
        drag.moved = Math.max(drag.moved, Math.abs(dx)+Math.abs(dy));
        cam.az = drag.az - dx*0.008; cam.el = drag.el + dy*0.004;
        cam.vaz = -dx*0.0004;
        return;
      }
      var r = hit(ev);
      canvas.style.cursor = r ? 'pointer' : 'grab';
      window.HOLO.hover(r);
    });
    canvas.addEventListener('pointerup', function (ev) {
      if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      canvas.classList.remove('dragging');
      var wasDrag = drag && drag.moved > 5;
      drag = null;
      // a fling keeps turning the figure only while motion is on
      if (still) cam.vaz = 0;
      if (wasDrag) return;
      var r = hit(ev);
      if (r) window.HOLO.open(r);
    });
    canvas.addEventListener('pointerleave', function () {
      if (!drag) window.HOLO.hover(null);
    });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      want.dist = Math.max(150, Math.min(700, want.dist + ev.deltaY*0.42));
    }, { passive:false });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(resize);
      ro.observe(canvas);
      // the chips wrap onto more rows as the window narrows
      if (document.getElementById('zones')) ro.observe(document.getElementById('zones'));
      if (document.querySelector('.topbar')) ro.observe(document.querySelector('.topbar'));
    } else window.addEventListener('resize', resize);
  }

  if (gl && window.THREE) {
    build(); resize(); wire();
    fetch('data/body.json').then(function (r) { return r.json(); })
      .then(buildBody).catch(function () {});
    var last = performance.now();
    (function loop(now) {
      var dt = Math.min(0.05, (now-last)/1000); last = now;
      if (!paused) render(dt);
      requestAnimationFrame(loop);
    })(last);
  }
})();
