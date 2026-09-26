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
//   - Render: background image, scaled to fit the viewport with the aspect ratio
//     preserved (no letterboxing math needed elsewhere since the stage box is sized
//     to exactly match the scaled image).
//   - Hit-testing: manual point-in-polygon (ray casting) against interior_hotspots
//     .polygon_points, no visible outlines drawn — smallest-polygon-wins when two
//     hotspots overlap (per user decision).
//   - Item popup: reuses the EXISTING #hsPopup via openHsPopup(null, title, body,
//     null) / closeHsPopup() — "one design line" per user request, no new popup UI.
//
// Explicitly OUT of scope here (left for later sub-scopes, not decided yet):
//   - interior_hotspots.node_id nesting vs. inventory_nodes.parent_id (open question
//     #4 in the architecture doc) — a kind='item' hotspot just shows its target
//     inventory_nodes row directly; no tree drill-down / breadcrumb UI.
//   - Any polygon-drawing tool — polygon_points is ASSUMED to be a JSON array of
//     [x, y] pixel pairs in the background image's own natural pixel space, e.g.
//     [[120,80],[240,80],[240,200],[120,200]]. This is a new format decision (no
//     drawing tool exists yet to produce it), flag if a different shape is wanted.
//   - Realtime sync while a visitor is inside a scene (DB publication exists per the
//     schema scope, but no subscribe/rebuild wiring here yet).

(function (global) {
  'use strict';

  var _scene = null;      // current interior_scenes row
  var _nodes = new Map(); // id -> inventory_nodes row (current scene only)
  var _hots = [];         // [{ row, points:[[x,y],...], area }]
  var _dom = null;

  // ── DOM (built once, lazily, on first scene entry — never touches index.html) ──
  function _build() {
    if (_dom) return _dom;

    var style = document.createElement('style');
    style.textContent =
      '#interiorScene{display:none;position:fixed;inset:0;z-index:45;background:#0d1117;' +
        'align-items:center;justify-content:center;flex-direction:column;}' +
      '#interiorScene.show{display:flex;}' +
      '#isHdr{position:fixed;top:0;left:0;right:0;z-index:1;display:flex;align-items:center;' +
        'justify-content:space-between;padding:7px 14px;background:rgba(13,17,23,0.6);' +
        'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
        'border-bottom:1px solid rgba(48,54,61,0.35);}' +
      '#isTitle{font:13px sans-serif;color:rgba(230,237,243,0.85);}' +
      '#isClose{background:none;border:none;color:#8b949e;font-size:20px;cursor:pointer;' +
        'line-height:1;padding:0 4px;}' +
      '#isStage{position:relative;}' +
      '#isImg{display:block;width:100%;height:100%;cursor:pointer;user-select:none;' +
        '-webkit-user-drag:none;image-rendering:auto;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'interiorScene';
    wrap.innerHTML =
      '<div id="isHdr"><span id="isTitle"></span><button id="isClose">\u2715</button></div>' +
      '<div id="isStage"><img id="isImg" draggable="false" alt=""></div>';
    document.body.appendChild(wrap);

    document.getElementById('isClose').addEventListener('click', interiorSceneClose);
    document.getElementById('isImg').addEventListener('click', _onStageClick);
    window.addEventListener('resize', _layout);

    _dom = wrap;
    return wrap;
  }

  // Scale the image to fit the viewport, aspect ratio preserved. The stage box is
  // sized to exactly the scaled image, so getBoundingClientRect() on #isImg IS the
  // visible picture — no object-fit letterbox math needed anywhere else.
  function _layout() {
    if (!_dom || !_dom.classList.contains('show')) return;
    var img = document.getElementById('isImg'), stage = document.getElementById('isStage');
    var nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;
    var vw = window.innerWidth, vh = window.innerHeight - 40; // ~#isHdr height
    var scale = Math.min(vw / nw, vh / nh);
    stage.style.width = Math.round(nw * scale) + 'px';
    stage.style.height = Math.round(nh * scale) + 'px';
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

  function _onStageClick(evt) {
    var img = document.getElementById('isImg');
    var r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var nw = img.naturalWidth, nh = img.naturalHeight;
    var x = (evt.clientX - r.left) / r.width * nw;
    var y = (evt.clientY - r.top) / r.height * nh;
    var best = null;
    for (var i = 0; i < _hots.length; i++) {
      var h = _hots[i];
      if (_pointInPoly(x, y, h.points) && (!best || h.area < best.area)) best = h;
    }
    if (best) _activate(best.row);
  }

  function _activate(row) {
    if (row.kind === 'item') {
      var node = _nodes.get(row.target_id);
      if (node) { _showNode(node); return; }
      _fetchNodeById(row.target_id).then(function (n) { if (n) _showNode(n); });
    } else if (row.kind === 'link') {
      sceneEnterById(row.target_id);
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
    document.getElementById('isTitle').textContent = _txt(scene.title_ka, scene.title_en);
    var img = document.getElementById('isImg');
    img.onload = _layout;
    img.src = scene.background_image_url;
    _dom.classList.add('show');
    if (img.complete && img.naturalWidth) _layout();
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
    _scene = null; _nodes = new Map(); _hots = [];
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _dom && _dom.classList.contains('show')) interiorSceneClose();
  });

  global.sceneEnterByTitle = sceneEnterByTitle;
  global.sceneEnterById = sceneEnterById;
  global.interiorSceneClose = interiorSceneClose;

}(window));
