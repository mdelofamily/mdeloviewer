// canvas-renderer.js — the only map renderer; always active
// static file (mdeloviewer/js/canvas-renderer.js), loaded after runtime.js
// depends on: _CFG, _TS (data.js) and <canvas id="mapImg"> (built by runtime.js)

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

  // ── layer renderer (base or overlay) ──
  function renderLayer(lmap) {
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

  // ── final composite after all images loaded ──
  function onAllLoaded() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderLayer(cfg.map);
    if (cfg.overlayMap) renderLayer(cfg.overlayMap);

    // draw objects
    const _oImgs = new Map();
    (cfg.objects || []).forEach(obj => {
      if (obj.src && !_oImgs.has(obj.src)) {
        const im = new Image(); im.src = obj.src; _oImgs.set(obj.src, im);
      }
    });
    Promise.all([..._oImgs.values()].map(im => im.complete ? Promise.resolve() : new Promise(r => { im.onload = r; im.onerror = r; }))).then(() => {
      (cfg.objects || []).forEach(obj => {
        const w = (obj.cols || 1) * TS, h = (obj.rows || 1) * TS;
        if (obj.src && _oImgs.has(obj.src)) {
          ctx.drawImage(_oImgs.get(obj.src), obj.x * TS, obj.y * TS, w, h);
        } else {
          const def = tileMap.get(obj.id); if (!def) return;
          if (def.sheetUrl) { const sh = sheets.get(def.sheetUrl); if (sh) ctx.drawImage(sh, def.sx, def.sy, def.sw, def.sh, obj.x * TS, obj.y * TS, w, h); }
        }
      });
    });
  }

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
