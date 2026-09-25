// canvas-renderer.js — the only map renderer; always active
// static file (mdeloviewer/js/canvas-renderer.js)
// depends on: _CFG, _TS (data.js) and <canvas id="mapImg"> (built by dom-init.js / runtime.js)
//
// Public API:
//   window.redrawMap()  - repaint the whole canvas. Safe to call at any time (before all
//                         images have loaded it is a no-op; the first paint happens by itself).
//   window._areaFills   - [{ x1, y1, x2, y2, tile }] active fill overlays (x2/y2 exclusive),
//                         maintained by runtime.js from area_overrides. Read on every paint.
//   window._dynamicObjects - [{ tile_id, x, y, cols, rows }] console-placed objects (/ობიექტი),
//                         maintained by runtime.js from object_overrides. Read on every paint.

(function () {
  const cfg = _CFG, TS = _TS, COLS = cfg.cols, ROWS = cfg.rows;
  const canvas = document.getElementById('mapImg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // build tile lookup
  const tileMap = new Map();
  (cfg.custom    || []).forEach(t => tileMap.set(t.id, t));
  (cfg.autoTiles || []).forEach(t => tileMap.set(t.id, t));
  (cfg.dualTiles || []).forEach(t => tileMap.set(t.id, t));

  // collect unique sheet urls + b64 tiles
  const sheets = new Map(), b64imgs = new Map(), urls = new Set();
  [...(cfg.custom || []), ...(cfg.autoTiles || []), ...(cfg.dualTiles || [])].forEach(t => { if (t.sheetUrl) urls.add(t.sheetUrl); });
  (cfg.objects || []).forEach(obj => { const def = tileMap.get(obj.id); if (def && def.sheetUrl) urls.add(def.sheetUrl); });
  const b64tiles = (cfg.custom || []).filter(t => t.src && !t.sheetUrl);

  // data-URL sprites of auto/dual tiles — preloaded so they composite in
  // layer order (a lazy per-cell Image() would paint after objects, on top)
  const spriteImgs = new Map();
  [...(cfg.autoTiles || []), ...(cfg.dualTiles || [])].forEach(t => {
    (t.sprites || []).forEach(sp => { if (typeof sp === 'string' && sp) spriteImgs.set(sp, null); });
  });

  let loadPending = urls.size + b64tiles.length + spriteImgs.size;
  let ready = false;   // true once every image has loaded (or failed); redrawMap() is a no-op before that
  function tryDone() { if (--loadPending <= 0) onAllLoaded(); }

  // ── draw helpers ──
  function connects(nid, id, compat) { return nid === id || compat.includes(nid); }
  function drawSp(t, sp, ox, oy) {
    if (!sp) return;
    if (typeof sp === 'object' && sp.x != null) {
      const sh = sheets.get(t.sheetUrl);
      if (sh) ctx.drawImage(sh, sp.x, sp.y, sp.w, sp.h, ox, oy, TS, TS);
    } else if (typeof sp === 'string') {
      const bi = spriteImgs.get(sp);
      if (bi) ctx.drawImage(bi, ox, oy, TS, TS);
    }
  }

  // ── layer renderer (base, overlay or fill) ──
  // onlyIds (optional Set): restrict the dual-tile pass to these tile ids - the fill layer uses
  // it so another dual tile's compatibleWith can never pull its sprites onto the fill layer.
  function renderLayer(lmap, onlyIds) {
    // pass 1: regular tiles
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const id = lmap[r][c]; if (!id) continue;
        const t = tileMap.get(id); if (!t || t.dualTile || t.autoTile) continue;
        if (t.sheetUrl) { const sh = sheets.get(t.sheetUrl); if (sh) ctx.drawImage(sh, t.x, t.y, t.w, t.h, c * TS, r * TS, TS, TS); }
        else { const bi = b64imgs.get(t.id); if (bi) ctx.drawImage(bi, c * TS, r * TS, TS, TS); }
      }
    }
    // pass 2: dual tiles (corner-based, drawn at half-offset)
    (cfg.dualTiles || []).forEach(dt => {
      if (onlyIds && !onlyIds.has(dt.id)) return;
      const compat = dt.compatibleWith || [];
      for (let r = 0; r < ROWS - 1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const mask =
            (connects(lmap[r][c],     dt.id, compat) ? 1 : 0) |
            (connects(lmap[r][c+1],   dt.id, compat) ? 2 : 0) |
            (connects(lmap[r+1][c],   dt.id, compat) ? 4 : 0) |
            (connects(lmap[r+1][c+1], dt.id, compat) ? 8 : 0);
          if (!mask) continue;
          drawSp(dt, (dt.sprites || [])[mask], (c + 0.5) * TS, (r + 0.5) * TS);
        }
      }
    });
    // pass 3: auto tiles (4-bit bitmask)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const id = lmap[r][c]; if (!id) continue;
        const t = tileMap.get(id); if (!t || !t.autoTile) continue;
        const compat = t.compatibleWith || [];
        let m = 0;
        if (r > 0         && connects(lmap[r-1][c], id, compat)) m |= 1;
        if (c < COLS - 1  && connects(lmap[r][c+1], id, compat)) m |= 2;
        if (r < ROWS - 1  && connects(lmap[r+1][c], id, compat)) m |= 4;
        if (c > 0         && connects(lmap[r][c-1], id, compat)) m |= 8;
        const sprites = t.sprites || [];
        const sp = sprites[m] || sprites[0] || sprites.find(v => v && typeof v === 'object' && v.w > 0) || sprites.find(Boolean);
        if (sp) drawSp(t, sp, c * TS, r * TS);
      }
    }
  }

  // ── fill layer: synthetic COLS x ROWS layer, empty except the cells of active fill areas ──
  // Purely visual - map[][] / overlayMap are never touched. Fills never overlap (enforced by
  // the /არე შევსება command), so cell order does not matter.
  function renderFills() {
    const fills = (window._areaFills || []).filter(f => f && tileMap.has(f.tile));
    if (!fills.length) return;
    const lmap = [];
    for (let r = 0; r < ROWS; r++) lmap.push(new Array(COLS).fill(''));
    const ids = new Set();
    fills.forEach(f => {
      ids.add(f.tile);
      const x1 = Math.max(0, f.x1), y1 = Math.max(0, f.y1), x2 = Math.min(COLS, f.x2), y2 = Math.min(ROWS, f.y2);
      for (let r = y1; r < y2; r++) for (let c = x1; c < x2; c++) lmap[r][c] = f.tile;
    });
    renderLayer(lmap, ids);
  }

  // ── console-placed objects (window._dynamicObjects, from object_overrides) ──
  // tile_id references the SAME catalog (cfg.custom, isObject:true) baked objects
  // draw from, so no extra asset loading is needed here — just another consumer
  // of the tileMap/sheets/b64imgs already built above.
  function renderDynamicObjects() {
    (window._dynamicObjects || []).forEach(o => {
      const def = tileMap.get(o.tile_id); if (!def) return;
      const dx = o.x * TS, dy = o.y * TS, w = (o.cols || 1) * TS, h = (o.rows || 1) * TS;
      if (def.sheetUrl) {
        const sh = sheets.get(def.sheetUrl);
        if (sh) ctx.drawImage(sh, def.x, def.y, def.w, def.h, dx, dy, w, h);
      } else {
        const im = b64imgs.get(def.id);
        if (im) ctx.drawImage(im, dx, dy, w, h);
      }
    });
  }

  // ── composite: base -> overlay -> fills -> objects (baked, then console) ──
  function composite() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderLayer(cfg.map);
    if (cfg.overlayMap) renderLayer(cfg.overlayMap);
    renderFills();

    // draw objects — straight from their tile definition (sheet crop or
    // b64 tile image); no per-object image data is stored in data.js
    (cfg.objects || []).forEach(obj => {
      const def = tileMap.get(obj.id); if (!def) return;
      const dx = obj.x * TS, dy = obj.y * TS, w = (obj.cols || 1) * TS, h = (obj.rows || 1) * TS;
      if (def.sheetUrl) {
        const sh = sheets.get(def.sheetUrl);
        if (sh) ctx.drawImage(sh, def.x, def.y, def.w, def.h, dx, dy, w, h);
      } else {
        const im = b64imgs.get(def.id);
        if (im) ctx.drawImage(im, dx, dy, w, h);
      }
    });
    renderDynamicObjects();
  }

  function onAllLoaded() { ready = true; composite(); }
  window.redrawMap = function () { if (ready) composite(); };

  // ── load assets ──
  if (loadPending === 0) { onAllLoaded(); return; }
  urls.forEach(url => {
    const img = new Image();
    img.onload = () => { sheets.set(url, img); tryDone(); };
    img.onerror = () => tryDone();
    img.src = url;
  });
  b64tiles.forEach(t => {
    const img = new Image();
    img.onload = () => { b64imgs.set(t.id, img); tryDone(); };
    img.onerror = () => tryDone();
    img.src = t.src;
  });
  [...spriteImgs.keys()].forEach(src => {
    const img = new Image();
    img.onload = () => { spriteImgs.set(src, img); tryDone(); };
    img.onerror = () => tryDone();
    img.src = src;
  });
})();
