// interior-scenes.js — mdeloviewer: point-and-click interior scenes (Sub-scope 2)
// Static file (mdeloviewer/js/interior-scenes.js), loaded via <script src> from
// index.html, AFTER runtime.js — uses SUPA_URL / SUPA_KEY / _MAP_ID / _mdeloLang /
// openHsPopup / closeHsPopup, all plain top-level bindings in runtime.js that are
// shared across classic <script> tags on the same page (no ES modules, per
// INSTRUCTION.md rule #1).
//
// Scope covered here (per interior-scenes architecture + DB-schema scope docs):
//   - Entry trigger: terminal command "/<name> შესვლა" (added in terminal.js),
//     matched by interior_scenes.title_ka === <name> — NOT objects.interior_scene_id
//     (that FK link is a separate, not-yet-built sub-scope; this name-match is the
//     v1 stand-in the user confirmed).
//   - Render: background image, default "cover" fit (fills the screen,
//     crops overflow) with pinch-to-zoom and drag-to-pan (Pointer Events).
//   - Hit-testing: manual point-in-polygon (ray casting) against interior_hotspots
//     .polygon_points, no visible outlines drawn during normal browsing —
//     smallest-polygon-wins when two hotspots overlap (per user decision).
//   - Item popup: reuses the EXISTING #hsPopup via openHsPopup(null, title, body,
//     null) / closeHsPopup() — "one design line" per user request, no new popup UI.
//   - Hotspot placement (Sub-scope 4/5, merged): "/წერტილი დადება ..." arms
//     placement, then a single-finger freehand stroke on the stage draws the
//     hotspot's exact polygon (closed automatically start-to-end); a dashed
//     preview of existing hotspots plus the live stroke render via an SVG
//     overlay (_refreshPlaceOverlay) while armed. Delete-picking stays a
//     plain tap (point-in-polygon).
//
// Explicitly OUT of scope here (left for later sub-scopes, not decided yet):
//   - interior_hotspots.node_id nesting vs. inventory_nodes.parent_id (open question
//     #4 in the architecture doc) — a kind='item' hotspot just shows its target
//     inventory_nodes row directly; no tree drill-down / breadcrumb UI.
//   - Any polygon-drawing tool — polygon_points is a JSON array of [x, y] pixel
//     pairs in the background image's own natural pixel space, produced now by
//     the freehand stroke above (see _drawPath/_onPointerUp).
//   - Realtime sync while a visitor is inside a scene (DB publication exists per the
//     schema scope, but no subscribe/rebuild wiring here yet).

(function (global) {
  'use strict';

  var _scene = null;      // current interior_scenes row
  var _nodes = new Map(); // id -> inventory_nodes row (current scene only)
  var _hots = [];         // [{ row, points:[[x,y],...], area }]
  var _dom = null;
  var _placeMode = null;    // null | {kind,target_id} (placing) | {del:true} (delete-picking)
  var _drawing = false;      // true while a freehand placement stroke is in progress
  var _drawPath = [];        // [[x,y],...] accumulated stroke points, natural pixel space

  // ── zoom/pan state ──
  // _zoom is a multiplier ON TOP OF the default "cover" fit (which already
  // fills the screen, cropping overflow, per user request) — 1 = default.
  var _zoom = 1, _stageX = 0, _stageY = 0;
  var MIN_ZOOM = 1, MAX_ZOOM = 4;
  var _pointers = new Map(); // pointerId -> {x,y} (live)
  var _pinch = null;         // {dist, zoom, midX, midY} while 2 fingers are down
  var _drag = null;          // {x,y,stageX,stageY,moved} while 1 finger/pointer is down

  // ── DOM (built once, lazily, on first scene entry — never touches index.html) ──
  function _build() {
    if (_dom) return _dom;

    var style = document.createElement('style');
    style.textContent =
      // z-index 6: above outdoor hotspots/areas (5/4, doesn't matter — opaque
      // anyway) but BELOW #topbar (10, has the "~" terminal toggle) and
      // #menuBtn (30, ☰) — both must stay reachable while a scene is open, or
      // there's no way back into the terminal/menu once inside. (Bug found
      // 2026-09-27: z-index:45 hid both.) No header/close button of our own —
      // fully fullscreen; #topbar's "~" label doubles as the breadcrumb
      // (see _setBreadcrumb) and exit is the "/გასვლა" terminal command.
      '#interiorScene{display:none;position:fixed;inset:0;z-index:6;background:#0d1117;overflow:hidden;}' +
      '#interiorScene.show{display:flex;}' +
      '#isStage{position:absolute;left:0;top:0;touch-action:none;}' +
      '#isImg{display:block;width:100%;height:100%;cursor:pointer;user-select:none;' +
        '-webkit-user-drag:none;image-rendering:auto;pointer-events:none;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'interiorScene';
    wrap.innerHTML = '<div id="isStage"><img id="isImg" draggable="false" alt=""></div>';
    document.body.appendChild(wrap);

    var stage = document.getElementById('isStage');
    stage.addEventListener('pointerdown', _onPointerDown);
    stage.addEventListener('pointermove', _onPointerMove);
    stage.addEventListener('pointerup', _onPointerUp);
    stage.addEventListener('pointercancel', _onPointerUp);
    window.addEventListener('resize', _layout);

    _dom = wrap;
    return wrap;
  }

  // #topbar's "~" button (index.html) doubles as the breadcrumb while inside
  // a scene: "~მდელო" becomes "~მდელო/<სცენა>". Reset to plain "მდელო" on exit.
  function _setBreadcrumb(sceneTitle) {
    var base = (typeof _MAP_ID !== 'undefined' && _MAP_ID) ? _MAP_ID : 'მდელო';
    var btn = document.getElementById('termBtn');
    if (btn) {
      var tilde = btn.querySelector('.tm-tilde');
      while (btn.lastChild) btn.removeChild(btn.lastChild);
      if (tilde) btn.appendChild(tilde);
      btn.appendChild(document.createTextNode(sceneTitle ? (base + '/' + sceneTitle) : base));
    }
    // #mapTitle is the visible label outside standalone-PWA mode (no click
    // handler either way) — mirror the same text there so the breadcrumb
    // shows regardless of which of the two is actually on screen.
    var mt = document.getElementById('mapTitle');
    if (mt) mt.textContent = sceneTitle ? (base + '/' + sceneTitle) : base;
  }

  // Default fit is "cover" (fills the screen, crops overflow) per user
  // request — was "contain" (letterboxed) before. _zoom multiplies on top of
  // that; _stageX/_stageY are the stage's top-left in viewport px, clamped so
  // the image never leaves a gap at the edges.
  function _baseSize() {
    var img = document.getElementById('isImg');
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return null;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cover = Math.max(vw / nw, vh / nh);
    return { nw: nw, nh: nh, w: nw * cover * _zoom, h: nh * cover * _zoom };
  }
  function _clampStage(w, h) {
    var vw = window.innerWidth, vh = window.innerHeight;
    _stageX = Math.min(0, Math.max(vw - w, _stageX));
    _stageY = Math.min(0, Math.max(vh - h, _stageY));
  }
  function _layout() {
    if (!_dom || !_dom.classList.contains('show')) return;
    var sz = _baseSize(); if (!sz) return;
    _clampStage(sz.w, sz.h);
    var stage = document.getElementById('isStage');
    stage.style.width = Math.round(sz.w) + 'px';
    stage.style.height = Math.round(sz.h) + 'px';
    stage.style.transform = 'translate(' + Math.round(_stageX) + 'px,' + Math.round(_stageY) + 'px)';
  }
  function _resetZoomPan() {
    _zoom = 1; _stageX = 0; _stageY = 0;
    var sz = _baseSize();
    if (sz) { _stageX = (window.innerWidth - sz.w) / 2; _stageY = (window.innerHeight - sz.h) / 2; }
  }

  // ── point-in-polygon (ray casting) + shoelace area, for smallest-wins priority ──
  function _pointInPoly(x, y, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      var hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  function _polyArea(pts) {
    var a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    return Math.abs(a / 2);
  }

  // ── pointer gestures: 1 finger = tap (hit-test/place) or drag-to-pan;
  //    2 fingers = pinch-to-zoom. A single pointer only pans once it has
  //    moved past a small threshold — short taps still activate hotspots. ──
  function _dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function _mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function _toImg(clientX, clientY) {
    var img = document.getElementById('isImg');
    var r = img.getBoundingClientRect();
    var nw = img.naturalWidth, nh = img.naturalHeight;
    return [(clientX - r.left) / r.width * nw, (clientY - r.top) / r.height * nh];
  }

  function _onPointerDown(evt) {
    document.getElementById('isStage').setPointerCapture(evt.pointerId);
    _pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    // Placing (not deleting): a single finger draws a freehand shape
    // directly — no competing "pan" interpretation to disambiguate here
    // (unlike the outdoor /არე brush), since pan is only meaningful when
    // NOT placing. Delete-mode and normal browsing keep the tap/drag/pinch
    // path below.
    if (_placeMode && !_placeMode.del && _pointers.size === 1) {
      _drawing = true;
      _drawPath = [_toImg(evt.clientX, evt.clientY)];
      _refreshPlaceOverlay();
      return;
    }
    if (_pointers.size === 2) {
      var pts = Array.from(_pointers.values());
      _pinch = { dist: _dist(pts[0], pts[1]), zoom: _zoom };
      _drag = null;
    } else if (_pointers.size === 1) {
      _drag = { x: evt.clientX, y: evt.clientY, stageX: _stageX, stageY: _stageY, moved: false };
    }
  }
  function _onPointerMove(evt) {
    if (!_pointers.has(evt.pointerId)) return;
    _pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    if (_drawing) {
      var p = _toImg(evt.clientX, evt.clientY);
      var last = _drawPath[_drawPath.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 6) {
        _drawPath.push(p);
        _refreshPlaceOverlay();
      }
      return;
    }
    if (_pinch && _pointers.size === 2) {
      var pts = Array.from(_pointers.values());
      var d = _dist(pts[0], pts[1]);
      _zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, _pinch.zoom * (d / _pinch.dist)));
      _layout();
    } else if (_drag && _pointers.size === 1) {
      var dx = evt.clientX - _drag.x, dy = evt.clientY - _drag.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) _drag.moved = true;
      if (_drag.moved) {
        _stageX = _drag.stageX + dx; _stageY = _drag.stageY + dy;
        var sz = _baseSize(); if (sz) { _clampStage(sz.w, sz.h); _layout(); }
      }
    }
  }
  function _onPointerUp(evt) {
    if (_drawing) {
      _pointers.delete(evt.pointerId);
      var path = _drawPath, mode = _placeMode;
      _drawing = false; _drawPath = [];
      if (path.length < 3) { _refreshPlaceOverlay(); _say('ter', 'ძალიან პატარა — თავიდან სცადე'); return; }
      _placeMode = null; _refreshPlaceOverlay();
      _hotspotCreate(mode.kind, mode.target_id, path).then(function (res) {
        if (res === true) _say('tok', '✓ hotspot დაემატა');
        else _say('ter', '✗ ვერ შეინახა' + (res && res.msg ? (' — ' + res.msg) : ''));
      });
      return;
    }
    var wasDrag = _drag && !_pinch && _pointers.size === 1;
    var tapPos = _pointers.get(evt.pointerId);
    _pointers.delete(evt.pointerId);
    if (_pointers.size < 2) _pinch = null;
    if (_pointers.size === 0) {
      var isTap = wasDrag && _drag && !_drag.moved;
      _drag = null;
      if (isTap && tapPos) _handleTap(tapPos.x, tapPos.y);
    }
  }

  function _handleTap(clientX, clientY) {
    var p = _toImg(clientX, clientY);
    var x = p[0], y = p[1];

    if (_placeMode) { _handlePlaceTap(x, y); return; } // only del-mode reaches here now

    var best = null;
    for (var i = 0; i < _hots.length; i++) {
      var h = _hots[i];
      if (_pointInPoly(x, y, h.points) && (!best || h.area < best.area)) best = h;
    }
    if (best) _activate(best.row);
  }

  function _say(cls, msg) { if (typeof global._tmL === 'function') global._tmL(cls, msg); }

  // Visible feedback while placing/deleting a hotspot: every existing
  // hotspot gets a dashed outline (so you can see what's already there and
  // avoid overlap), plus the in-progress freehand stroke as it's drawn.
  // Cleared the instant placement isn't active — normal browsing stays
  // outline-free per the original hit-testing design.
  function _placeOverlayEl() {
    var el = document.getElementById('isPlaceOverlay');
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.id = 'isPlaceOverlay';
      el.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;');
      document.getElementById('isStage').appendChild(el);
    }
    var img = document.getElementById('isImg');
    if (img.naturalWidth) el.setAttribute('viewBox', '0 0 ' + img.naturalWidth + ' ' + img.naturalHeight);
    return el;
  }
  function _refreshPlaceOverlay() {
    var el = _placeOverlayEl();
    while (el.lastChild) el.removeChild(el.lastChild);
    if (!_placeMode) return;
    var svgNS = 'http://www.w3.org/2000/svg';
    var img = document.getElementById('isImg');
    var sw = Math.max(1, (img.naturalWidth || 1000) / 400); // stroke scales with image resolution
    _hots.forEach(function (h) {
      var poly = document.createElementNS(svgNS, 'polygon');
      poly.setAttribute('points', h.points.map(function (pt) { return pt[0] + ',' + pt[1]; }).join(' '));
      poly.setAttribute('fill', 'rgba(88,166,255,.10)');
      poly.setAttribute('stroke', 'rgba(88,166,255,.65)');
      poly.setAttribute('stroke-width', sw);
      poly.setAttribute('stroke-dasharray', (sw * 4) + ',' + (sw * 3));
      el.appendChild(poly);
    });
    if (_drawing && _drawPath.length > 1) {
      var live = document.createElementNS(svgNS, 'polyline');
      live.setAttribute('points', _drawPath.map(function (pt) { return pt[0] + ',' + pt[1]; }).join(' '));
      live.setAttribute('fill', 'rgba(0,255,136,.15)');
      live.setAttribute('stroke', '#00ff88');
      live.setAttribute('stroke-width', sw);
      el.appendChild(live);
    }
  }

  // Delete-picking is still a plain tap (point-in-polygon against existing
  // hotspots) — only "დადება" placement uses the freehand stroke above.
  function _handlePlaceTap(x, y) {
    var best = null;
    for (var i = 0; i < _hots.length; i++) {
      var h = _hots[i];
      if (_pointInPoly(x, y, h.points) && (!best || h.area < best.area)) best = h;
    }
    _placeMode = null; _refreshPlaceOverlay();
    if (!best) { _say('ter', 'ამ წერტილში hotspot ვერ მოიძებნა'); return; }
    _hotspotDeleteRow(best.row.id).then(function (res) {
      if (res === true) { _hots = _hots.filter(function (hh) { return hh !== best; }); _say('tok', '✓ წაიშალა hotspot'); }
      else _say('ter', '✗ ვერ წაიშალა' + (res && res.msg ? (' — ' + res.msg) : ''));
    });
  }

  function _activate(row) {
    if (row.kind === 'item') {
      var node = _nodes.get(row.target_id);
      if (node) { _showNode(node); return; }
      _fetchNodeById(row.target_id).then(function (n) { if (n) _showNode(n); });
    } else if (row.kind === 'link') {
      sceneEnterById(row.target_id);
    } else if (row.kind === 'canvas') {
      // exit straight to the outdoor canvas map — it was never unmounted, it's
      // sitting right under this overlay the whole time (see INSTRUCTION.md #12:
      // one canvas per viewer, so there is nothing else to pick between yet)
      interiorSceneClose();
    }
  }

  function _showNode(node) {
    if (typeof global.closeHsPopup === 'function') global.closeHsPopup();
    var title = _txt(node.title_ka, node.title_en);
    var body = _txt(node.instruction_ka, node.instruction_en);
    if (typeof global.openHsPopup === 'function') global.openHsPopup(null, title, body, null);
  }

  // Same ka/en fallback rule as runtime.js's _i18n, but for separate _ka/_en text
  // columns (interior_scenes/inventory_nodes) rather than one { ka, en } object.
  function _txt(ka, en) {
    if (typeof global._mdeloLang !== 'undefined' && global._mdeloLang === 'en') return en || ka || '';
    return ka || en || '';
  }

  // ── data loading (plain PostgREST fetch, same convention as loadAreaOverrides /
  //    loadObjectOverrides in runtime.js) ──
  function _headers() { return { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }; }

  async function _fetchSceneRow(filter) {
    var r = await fetch(SUPA_URL + '/rest/v1/interior_scenes?' + filter, { headers: _headers() });
    if (!r.ok) return null;
    var rows = await r.json();
    return rows[0] || null;
  }
  async function _fetchNodes(sceneId) {
    var r = await fetch(SUPA_URL + '/rest/v1/inventory_nodes?scene_id=eq.' + encodeURIComponent(sceneId), { headers: _headers() });
    return r.ok ? await r.json() : [];
  }
  async function _fetchHotspots(sceneId) {
    var r = await fetch(SUPA_URL + '/rest/v1/interior_hotspots?scene_id=eq.' + encodeURIComponent(sceneId), { headers: _headers() });
    return r.ok ? await r.json() : [];
  }
  async function _fetchNodeById(id) {
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/inventory_nodes?id=eq.' + encodeURIComponent(id), { headers: _headers() });
      if (!r.ok) return null;
      var rows = await r.json();
      return rows[0] || null;
    } catch (e) { return null; }
  }

  async function _open(scene) {
    if (!scene) return false;
    _scene = scene;
    var nodeRows = await _fetchNodes(scene.id);
    _nodes = new Map(nodeRows.map(function (n) { return [n.id, n]; }));
    var hotRows = await _fetchHotspots(scene.id);
    _hots = hotRows.map(function (h) {
      var pts = Array.isArray(h.polygon_points) ? h.polygon_points : [];
      return { row: h, points: pts, area: _polyArea(pts) };
    });

    _build();
    _setBreadcrumb(_txt(scene.title_ka, scene.title_en));
    var img = document.getElementById('isImg');
    img.onload = function () { _resetZoomPan(); _layout(); };
    img.src = scene.background_image_url;
    _dom.classList.add('show');
    if (img.complete && img.naturalWidth) { _resetZoomPan(); _layout(); }
    _refreshPlaceOverlay();
    return true;
  }

  // ── CRUD (Sub-scope 4, resident+ gated in terminal.js — RLS itself stays
  //    open per the DB-schema scope's confirmed decision) ──
  function _authHdr() { return (typeof global._authHeaders === 'function') ? global._authHeaders() : _headers(); }
  function _requireOpenScene() { return _scene ? null : 'ჯერ შედი სცენაში: /<სახელი> შესვლა'; }

  async function sceneCreate(name) {
    name = String(name || '').trim();
    if (!name) return { msg: 'სახელი ცარიელია' };
    if (typeof global.mdMediaOpen !== 'function') return { msg: 'mdMediaOpen ვერ მოიძებნა (upload.js?)' };
    var files = await global.mdMediaOpen();
    var img = (files || []).find(function (f) { return f.type === 'image'; });
    if (!img) return { msg: 'სურათი არ აირჩა' };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_scenes', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHdr()),
        body: JSON.stringify({ map_id: _MAP_ID, title_ka: name, background_image_url: img.url })
      });
      if (!r.ok) { var t = await r.text().catch(function () { return ''; }); return { msg: 'HTTP ' + r.status + ' ' + t.slice(0, 150) }; }
      return true;
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  async function sceneDelete(name) {
    name = String(name || '').trim();
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_scenes?map_id=eq.' + encodeURIComponent(_MAP_ID) + '&title_ka=eq.' + encodeURIComponent(name),
        { method: 'DELETE', headers: _authHdr() });
      return r.ok ? true : { msg: 'HTTP ' + r.status };
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  async function sceneRename(oldName, newName) {
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_scenes?map_id=eq.' + encodeURIComponent(_MAP_ID) + '&title_ka=eq.' + encodeURIComponent(oldName), {
        method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHdr()),
        body: JSON.stringify({ title_ka: newName })
      });
      return r.ok ? true : { msg: 'HTTP ' + r.status };
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  async function sceneSetBackground(name) {
    if (typeof global.mdMediaOpen !== 'function') return { msg: 'mdMediaOpen ვერ მოიძებნა (upload.js?)' };
    var files = await global.mdMediaOpen();
    var img = (files || []).find(function (f) { return f.type === 'image'; });
    if (!img) return { msg: 'სურათი არ აირჩა' };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_scenes?map_id=eq.' + encodeURIComponent(_MAP_ID) + '&title_ka=eq.' + encodeURIComponent(name), {
        method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHdr()),
        body: JSON.stringify({ background_image_url: img.url })
      });
      if (!r.ok) return { msg: 'HTTP ' + r.status };
      if (_scene && _scene.title_ka === name) {
        _scene.background_image_url = img.url;
        var im = document.getElementById('isImg'); if (im) im.src = img.url;
      }
      return true;
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }

  async function nodeAdd(name, instruction) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    name = String(name || '').trim();
    if (!name) return { msg: 'სახელი ცარიელია' };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/inventory_nodes', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHdr()),
        body: JSON.stringify({ scene_id: _scene.id, title_ka: name, instruction_ka: instruction || null })
      });
      if (!r.ok) return { msg: 'HTTP ' + r.status };
      var rows = await r.json();
      if (rows[0]) _nodes.set(rows[0].id, rows[0]);
      return true;
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  // For "/კვანძი სია" — so the user can see what names already exist in the
  // open scene before running "ტექსტი"/"წაშ"/"წერტილი დადება კვანძი".
  function nodeList() {
    var err = _requireOpenScene(); if (err) return { msg: err };
    var arr = [];
    _nodes.forEach(function (n) { arr.push({ title: n.title_ka, hasText: !!(n.instruction_ka || n.instruction_en) }); });
    return arr;
  }
  async function nodeDelete(name) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/inventory_nodes?scene_id=eq.' + encodeURIComponent(_scene.id) + '&title_ka=eq.' + encodeURIComponent(name),
        { method: 'DELETE', headers: _authHdr() });
      return r.ok ? true : { msg: 'HTTP ' + r.status };
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  async function nodeEdit(name, instruction) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/inventory_nodes?scene_id=eq.' + encodeURIComponent(_scene.id) + '&title_ka=eq.' + encodeURIComponent(name), {
        method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHdr()),
        body: JSON.stringify({ instruction_ka: instruction })
      });
      return r.ok ? true : { msg: 'HTTP ' + r.status };
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }

  async function _hotspotCreate(kind, target_id, pts) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_hotspots', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHdr()),
        body: JSON.stringify({ scene_id: _scene.id, kind: kind, target_id: target_id || null, polygon_points: pts })
      });
      if (!r.ok) { var t = await r.text().catch(function () { return ''; }); return { msg: 'HTTP ' + r.status + ' ' + t.slice(0, 150) }; }
      var rows = await r.json();
      if (rows[0]) _hots.push({ row: rows[0], points: pts, area: _polyArea(pts) });
      return true;
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }
  async function _hotspotDeleteRow(id) {
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/interior_hotspots?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: _authHdr() });
      return r.ok ? true : { msg: 'HTTP ' + r.status };
    } catch (e) { return { msg: 'ქსელის შეცდომა' }; }
  }

  // Arm placement mode; the NEXT one or two taps on the stage (see
  // _handlePlaceTap) supply the geometry. hotspotPlaceItem/Canvas resolve
  // synchronously (local lookup / no target); hotspotPlaceLink is async
  // (looks the target scene up by name first).
  function hotspotPlaceItem(nodeName) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    var node = null;
    _nodes.forEach(function (n) { if (n.title_ka === nodeName) node = n; });
    if (!node) return { msg: 'კვანძი ვერ მოიძებნა ამ სცენაში: ' + nodeName };
    _placeMode = { kind: 'item', target_id: node.id }; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
    return true;
  }
  async function hotspotPlaceLink(sceneName) {
    var err = _requireOpenScene(); if (err) return { msg: err };
    var target = await _fetchSceneRow('map_id=eq.' + encodeURIComponent(_MAP_ID) + '&title_ka=eq.' + encodeURIComponent(sceneName));
    if (!target) return { msg: 'სცენა ვერ მოიძებნა: ' + sceneName };
    _placeMode = { kind: 'link', target_id: target.id }; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
    return true;
  }
  function hotspotPlaceCanvas() {
    var err = _requireOpenScene(); if (err) return { msg: err };
    _placeMode = { kind: 'canvas', target_id: null }; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
    return true;
  }
  function hotspotPlaceDelete() {
    var err = _requireOpenScene(); if (err) return { msg: err };
    _placeMode = { del: true }; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
    return true;
  }
  function hotspotPlaceCancel() {
    _placeMode = null; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
    return true;
  }

  // ── public API ──
  // Returns true (entered), false (no such scene), or { error } on a network failure.
  async function sceneEnterByTitle(name) {
    name = String(name || '').trim();
    if (!name) return false;
    try {
      var scene = await _fetchSceneRow(
        'map_id=eq.' + encodeURIComponent(_MAP_ID) + '&title_ka=eq.' + encodeURIComponent(name)
      );
      if (!scene) return false;
      return await _open(scene);
    } catch (e) { return { error: 'ქსელის შეცდომა' }; }
  }
  async function sceneEnterById(id) {
    try {
      var scene = await _fetchSceneRow('id=eq.' + encodeURIComponent(id));
      if (!scene) return false;
      return await _open(scene);
    } catch (e) { return { error: 'ქსელის შეცდომა' }; }
  }
  function interiorSceneClose() {
    if (typeof global.closeHsPopup === 'function') global.closeHsPopup();
    if (_dom) _dom.classList.remove('show');
    _setBreadcrumb(null);
    _scene = null; _nodes = new Map(); _hots = [];
    _placeMode = null; _drawing = false; _drawPath = [];
    _refreshPlaceOverlay();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _dom && _dom.classList.contains('show')) interiorSceneClose();
  });

  global.sceneEnterByTitle = sceneEnterByTitle;
  global.sceneEnterById = sceneEnterById;
  global.interiorSceneClose = interiorSceneClose;
  global.sceneCreate = sceneCreate;
  global.sceneDelete = sceneDelete;
  global.sceneRename = sceneRename;
  global.sceneSetBackground = sceneSetBackground;
  global.nodeAdd = nodeAdd;
  global.nodeList = nodeList;
  global.nodeDelete = nodeDelete;
  global.nodeEdit = nodeEdit;
  global.hotspotPlaceItem = hotspotPlaceItem;
  global.hotspotPlaceLink = hotspotPlaceLink;
  global.hotspotPlaceCanvas = hotspotPlaceCanvas;
  global.hotspotPlaceDelete = hotspotPlaceDelete;
  global.hotspotPlaceCancel = hotspotPlaceCancel;

}(window));
