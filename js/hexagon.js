// hexagon.js — mdeloviewer: hexagon launcher (stage 1: static ring, <= 6 hexes).
// A hexagon = a row of the existing `panels` table with layout='ring' (+ `config` jsonb),
// owner-only RLS, resident+ (server-side too). Personal; not shared.
//
// The launcher is an INTERFACE only. A hex press goes through the SAME path as a panel
// button (_panelPress -> window.tmRun / window.runMacro), which re-check the presser's
// tier. No tier check runs at press time in this file (INSTRUCTION.md rule #14).
// The terminal never depends on this file: /ჰექსაგონი is a normal command, and
// "/ჰექსაგონი გამორთვა" always removes the launcher from the screen.
//
// Loaded AFTER runtime.js and terminal.js (uses their top-level bindings:
// SUPA_URL, _MAP_ID, _authHeaders, _i18n, _panelShell, _panelSetBar, _panelFit,
// _panelPress, _panelCheckAction, _panelBtnEl, _PANEL_BTN_CSS, _PANEL_IN_CSS,
// openHsPopup/closeHsPopup, toast, _tmL, closeTerm).
//
// Per-device state (localStorage, per user + map): { on: bool, id: panel_id }.
// "hidden" (drawing / keyboard) is transient and separate from "off" (state.on = false).
(function (global) {
  'use strict';

  var HX_W = 26, HX_H = 30;          // peripheral hex (pointy-top), px
  var HX_CW = 38, HX_CH = 44;        // centre hex: width = quest button (38px); regular pointy-top height
  var HX_GAP = 28;                   // distance between neighbouring hex centres along the arc, px
  var HX_SPAN = 80;                  // preferred arc span, degrees (centred on 135deg)
  var HX_RMIN = 64;                  // smallest ring radius, px
  var HX_CY_FROM_BOTTOM = 33;        // quest button: bottom 14px + 38/2 -> centre line shared with the launcher
  var HX_MAX_BTNS = 6;               // stage 1: no scrolling, so at most 6 buttons
  var HX_CLIP = 'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)';

  var _hexagons = [];                // rows with layout='ring'
  var _stale = false;                // list came from the offline snapshot
  var _loadedFor = null;             // user id the list was loaded for
  var _loading = false;
  var _root = null, _ring = null, _fab = null;
  var _open = false;
  var _sig = '';                     // signature of what is currently rendered
  var _baseH = 0, _baseW = 0;        // largest viewport seen (keyboard detection)

  // ── helpers ──────────────────────────────────────────────────────────────
  function _uid() { return (typeof global.myUserId === 'function' && global.myUserId()) || null; }
  function _tierOk() { return typeof global._tierAtLeast === 'function' && global._tierAtLeast('resident'); }
  function _snapKey() { return 'mdelo_hexagons_' + (_uid() || 'anon') + '_' + _MAP_ID; }
  function _stateKey() { return 'mdelo_hexagon_state_' + (_uid() || 'anon') + '_' + _MAP_ID; }
  function _getState() {
    try { return JSON.parse(localStorage.getItem(_stateKey()) || 'null') || { on: false, id: null }; }
    catch (e) { return { on: false, id: null }; }
  }
  function _setState(s) { try { localStorage.setItem(_stateKey(), JSON.stringify(s)); } catch (e) {} }
  function _title(h) { return _i18n({ ka: h.title, en: h.title_en }) || h.title || ''; }
  function _note(msg) { if (typeof toast === 'function') toast(msg); }

  // ── data (table `panels`, layout='ring') ─────────────────────────────────
  async function hexagonsLoad() {
    var uid = _uid();
    _stale = false;
    if (!uid) { _hexagons = []; _loadedFor = null; return _hexagons; }
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/panels?map_id=eq.' + encodeURIComponent(_MAP_ID) +
        '&layout=eq.ring&select=*&order=title.asc', { headers: _authHeaders() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var rows = await r.json();
      _hexagons = Array.isArray(rows) ? rows : [];
      try { localStorage.setItem(_snapKey(), JSON.stringify(_hexagons)); } catch (e) {}
    } catch (e) {
      var snap = null;
      try { snap = JSON.parse(localStorage.getItem(_snapKey()) || 'null'); } catch (e2) {}
      _hexagons = Array.isArray(snap) ? snap : [];
      _stale = true;   // read-only: saving needs the network
    }
    _loadedFor = uid;
    return _hexagons;
  }

  function hexagonFind(q) {
    q = (q || '').trim();
    if (!q) return null;
    if (/^\d+$/.test(q)) return _hexagons[+q - 1] || null;
    var lq = q.toLowerCase();
    for (var i = 0; i < _hexagons.length; i++) {
      if (_hexagons[i].title === q) return _hexagons[i];
      if (_hexagons[i].title_en && _hexagons[i].title_en.toLowerCase() === lq) return _hexagons[i];
    }
    return null;
  }

  function _err(r, body) { return { ok: false, status: r.status, msg: (body || '').slice(0, 150) }; }

  // h = { panel_id?, title, title_en?, icon?, buttons[], config{} } -> { ok, row } | { ok:false, status, msg }
  async function hexagonSave(h) {
    if (!navigator.onLine) return { ok: false, status: 0, msg: 'ოფლაინ — შენახვას ქსელი სჭირდება' };
    try {
      var body = {
        title: h.title, title_en: h.title_en || null, icon: h.icon || null,
        buttons: h.buttons, config: h.config || {}, updated_at: new Date().toISOString()
      };
      var url = SUPA_URL + '/rest/v1/panels', method = 'POST';
      if (h.panel_id) { method = 'PATCH'; url += '?panel_id=eq.' + encodeURIComponent(h.panel_id); }
      else { body.map_id = _MAP_ID; body.layout = 'ring'; }   // owner comes from the column default auth.uid()
      var r = await fetch(url, {
        method: method,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHeaders()),
        body: JSON.stringify(body)
      });
      var txt = await r.text().catch(function () { return ''; });
      if (!r.ok) return _err(r, txt);
      var rows = []; try { rows = JSON.parse(txt); } catch (e) {}
      var row = rows && rows[0];
      if (!row) return { ok: false, status: r.status, msg: 'ცარიელი პასუხი (უფლება/RLS?)' };
      await hexagonsLoad();   // refresh list + offline snapshot
      return { ok: true, row: row };
    } catch (e) { return { ok: false, status: 0, msg: e.message }; }
  }

  async function hexagonDelete(id) {
    if (!navigator.onLine) return { ok: false, status: 0, msg: 'ოფლაინ — წაშლას ქსელი სჭირდება' };
    try {
      var r = await fetch(SUPA_URL + '/rest/v1/panels?panel_id=eq.' + encodeURIComponent(id) + '&layout=eq.ring',
        { method: 'DELETE', headers: _authHeaders() });
      if (!r.ok) return _err(r, await r.text().catch(function () { return ''; }));
      var st = _getState();
      if (st.id === id) _setState({ on: false, id: null });
      await hexagonsLoad();
      return { ok: true };
    } catch (e) { return { ok: false, status: 0, msg: e.message }; }
  }

  // ── styles (injected from here: index.html is generated by the editor) ───
  // Look = dialogue window (#hsPopup): rgba(22,27,34,.4) + blur(12px) + 1px rgba(88,166,255,.35) outline.
  // The outline is an SVG polygon (2px stroke centred on the edge, half clipped = 1px) because
  // border does not follow a clip-path.
  var HX_SVG = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="50,0 100,25 100,75 50,100 0,75 0,25" fill="none" stroke="rgba(88,166,255,0.35)" ' +
    'stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';

  function _ensureStyle() {
    if (document.getElementById('hexStyles')) return;
    var st = document.createElement('style'); st.id = 'hexStyles';
    var glass = 'background:rgba(22,27,34,0.4);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'clip-path:' + HX_CLIP + ';-webkit-clip-path:' + HX_CLIP + ';border:none;padding:0;margin:0;cursor:pointer;' +
      '-webkit-tap-highlight-color:transparent;';
    st.textContent =
      '#hxRoot{position:fixed;right:14px;bottom:' + (HX_CY_FROM_BOTTOM - HX_CH / 2) + 'px;width:' + HX_CW + 'px;height:' + HX_CH + 'px;' +
        'z-index:32;display:none;}' +
      '#hxRoot .hx-ring{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}' +
      '#hxRoot .hx{position:absolute;left:calc(50% - ' + (HX_W / 2) + 'px);top:calc(50% - ' + (HX_H / 2) + 'px);' +
        'width:' + HX_W + 'px;height:' + HX_H + 'px;' + glass + 'pointer-events:none;visibility:hidden;' +
        'transform:translate(0,0) scale(.2);transition:transform 170ms ease,visibility 0s linear 170ms;}' +   // no fade: transform only
      '#hxRoot.open .hx{transform:translate(var(--dx),var(--dy)) scale(1);pointer-events:auto;visibility:visible;' +
        'transition:transform 170ms ease,visibility 0s;}' +
      '#hxRoot .hx:active{background:rgba(88,166,255,0.22);}' +
      '#hxRoot svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}' +
      '#hxRoot .hx-in{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
        'color:rgba(200,210,220,0.92);font-size:15px;line-height:1;}' +
      '#hxFab{position:absolute;left:0;top:0;width:' + HX_CW + 'px;height:' + HX_CH + 'px;' + glass + '}' +
      '#hxFab .hx-in{font-size:17px;}' +
      '#hxRoot.open #hxFab{background:rgba(88,166,255,0.18);}';
    document.head.appendChild(st);
  }

  // ── launcher DOM ─────────────────────────────────────────────────────────
  function _build() {
    if (_root) return;
    _ensureStyle();
    _root = document.createElement('div'); _root.id = 'hxRoot';
    _ring = document.createElement('div'); _ring.className = 'hx-ring';
    _fab = document.createElement('button'); _fab.id = 'hxFab';
    _fab.setAttribute('aria-label', 'ჰექსაგონი');
    _fab.onclick = function () { _setOpen(!_open); };
    _root.appendChild(_ring); _root.appendChild(_fab);
    // keep gestures on the launcher away from the map pan/zoom handlers
    ['touchstart', 'touchmove', 'touchend'].forEach(function (ev) {
      _root.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });
    document.body.appendChild(_root);
    // tap anywhere outside folds the ring (capture, so the map still receives the gesture)
    document.addEventListener('pointerdown', function (e) {
      if (_open && _root && !_root.contains(e.target)) _setOpen(false);
    }, true);
  }

  function _setOpen(on) {
    _open = !!on && !!_root;
    if (_root) _root.classList.toggle('open', _open);
  }

  function _active() {
    var st = _getState();
    if (!st || !st.on || !st.id) return null;
    for (var i = 0; i < _hexagons.length; i++) if (_hexagons[i].panel_id === st.id) return _hexagons[i];
    return null;
  }

  // first user-perceived character (emoji can be several UTF-16 units / ZWJ sequences: charAt() breaks them)
  function _firstGlyph(str) {
    str = (str || '').trim();
    if (!str) return '';
    try {
      if (global.Intl && Intl.Segmenter) {
        var it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)[Symbol.iterator]().next();
        return it.done ? '' : it.value.segment;
      }
    } catch (e) {}
    return Array.from(str)[0] || '';
  }

  // Ring geometry from the viewport size (NOT from getBoundingClientRect: the root is display:none
  // while hidden/loading, which made the radius depend on when the ring was rendered).
  // Compact: radius grows with the number of hexes just enough to keep them from overlapping.
  function _arc(n) {
    var cx = _baseW - 14 - HX_CW / 2, cy = _baseH - HX_CY_FROM_BOTTOM;
    var rMax = Math.max(HX_RMIN, Math.min(cx - HX_W / 2 - 6, cy - HX_H / 2 - 6 - 56));   // 56 = top bar clearance
    var R = n > 1 ? (n - 1) * HX_GAP / (HX_SPAN * Math.PI / 180) : HX_RMIN;
    R = Math.min(Math.max(R, HX_RMIN), rMax);
    var step = n > 1 ? Math.min(HX_GAP / R * 180 / Math.PI, 88 / (n - 1)) : 0;   // degrees
    return { R: R, step: step };
  }

  function _render(h) {
    var btns = (h.buttons || []).filter(function (b) { return b && b.action; }).slice(0, HX_MAX_BTNS);
    var n = btns.length;
    _ring.innerHTML = '';
    var g = _arc(n);
    // arc around the bottom-right FAB: from "left" (180deg) to "up" (90deg), centred on 135deg
    btns.forEach(function (btn, i) {
      var a = (135 + (n - 1) / 2 * g.step - i * g.step) * Math.PI / 180;
      var dx = Math.round(g.R * Math.cos(a)), dy = Math.round(-g.R * Math.sin(a));
      var el = document.createElement('button'); el.className = 'hx';
      el.style.setProperty('--dx', dx + 'px'); el.style.setProperty('--dy', dy + 'px');
      el.style.transitionDelay = (i * 18) + 'ms, 0s';
      el.innerHTML = HX_SVG + '<span class="hx-in"></span>';
      var inner = el.querySelector('.hx-in');
      var label = _i18n(btn.label) || '';
      inner.textContent = (btn.icon && btn.icon.trim()) || _firstGlyph(label) || '•';
      if (label) { el.title = label; el.setAttribute('aria-label', label); }
      el.onclick = function () {
        // same execution path as a panel button; tier is re-checked inside tmRun/runMacro
        if (typeof _panelPress === 'function') _panelPress(btn, el);
        _setOpen(false);
      };
      _ring.appendChild(el);
    });
    var cIcon = (h.config && h.config.center && h.config.center.icon) || '⬡';
    _fab.innerHTML = HX_SVG + '<span class="hx-in"></span>';
    _fab.querySelector('.hx-in').textContent = cIcon;
  }

  function _keyboardOpen() {
    var vv = global.visualViewport;
    var h = Math.min(vv ? vv.height : Infinity, global.innerHeight);
    return _baseH > 0 && h < _baseH * 0.75;
  }
  function _trackViewport() {
    var w = global.innerWidth, h = global.innerHeight;
    if (!_baseH || w !== _baseW) { _baseW = w; _baseH = h; }   // first run / orientation change
    else if (h > _baseH) _baseH = h;
  }

  // hidden ≠ off: transient hiding (drawing, keyboard) never touches the saved state
  function _hiddenNow() {
    return !!(global._areaDrawActive || global._objDrawActive || global._spotDrawActive || _keyboardOpen());
  }

  // one cheap poll covers login/logout/tier changes and the draw flags (they are plain window props)
  function _tick() {
    _trackViewport();
    var uid = _uid();
    var allowed = !!(uid && _tierOk());
    var st = allowed ? _getState() : null;
    var want = !!(st && st.on);
    if (want && !_loading && _loadedFor !== uid) {
      _loading = true;
      hexagonsLoad().then(function () { _loading = false; }, function () { _loading = false; });
      return;
    }
    var h = want && !_loading ? _active() : null;
    if (!h) { if (_root) { _root.style.display = 'none'; _setOpen(false); } _sig = ''; return; }
    _build();
    var sig = h.panel_id + '|' + (h.updated_at || '') + '|' + _baseW + 'x' + _baseH;
    if (sig !== _sig) { _sig = sig; _render(h); }
    var hide = _hiddenNow();
    _root.style.display = hide ? 'none' : 'block';
    if (hide) _setOpen(false);
  }

  function _refresh(openRing) {
    _sig = ''; _tick();
    if (openRing && _root && _root.style.display !== 'none') _setOpen(true);
  }

  // ── editor window (reuses the panel window shell) ────────────────────────
  function hexagonEdit(h, presetTitle) {
    var isNew = !h;
    var work = h ? JSON.parse(JSON.stringify(h)) : { title: presetTitle || '', title_en: '', icon: '', buttons: [], config: {} };
    var cfg = (work.config && typeof work.config === 'object') ? work.config : {};
    var rows = (work.buttons || []).slice(0, HX_MAX_BTNS).map(function (b) {
      return { id: b.id || ('b' + Math.random().toString(36).slice(2, 8)), icon: b.icon || '',
        ka: (b.label && (b.label.ka != null ? b.label.ka : b.label)) || '', en: (b.label && b.label.en) || '', action: b.action || '' };
    });
    var body = _panelShell(isNew ? 'ახალი ჰექსაგონი' : 'ჰექსაგონის რედაქტირება');
    var msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-size:12px;margin:0 0 4px;min-height:14px;color:#f85149;'; body.appendChild(msgEl);

    var inTitle = document.createElement('input'); inTitle.style.cssText = _PANEL_IN_CSS; inTitle.placeholder = 'სათაური'; inTitle.value = work.title || '';
    var inTitleEn = document.createElement('input'); inTitleEn.style.cssText = _PANEL_IN_CSS; inTitleEn.placeholder = 'title (EN, ოფციონალური)'; inTitleEn.value = work.title_en || '';
    var inIcon = document.createElement('input'); inIcon.style.cssText = _PANEL_IN_CSS; inIcon.placeholder = 'ხატი სიაში (ოფციონალური)'; inIcon.value = work.icon || '';
    var inCenter = document.createElement('input'); inCenter.style.cssText = _PANEL_IN_CSS; inCenter.placeholder = 'ცენტრის ხატი (ნაგულისხმევი ⬡)';
    inCenter.value = (cfg.center && cfg.center.icon) || '';
    body.appendChild(inTitle); body.appendChild(inTitleEn); body.appendChild(inIcon); body.appendChild(inCenter);

    var listEl = document.createElement('div'); body.appendChild(listEl);

    function drawRows() {
      listEl.innerHTML = '';
      rows.forEach(function (r, idx) {
        var card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(88,166,255,0.2);border-radius:8px;padding:6px;margin:0 0 6px;';
        var l1 = document.createElement('div'); l1.style.cssText = 'display:flex;gap:4px;';
        var ic = document.createElement('input'); ic.style.cssText = _PANEL_IN_CSS + 'width:44px;flex:none;text-align:center;'; ic.placeholder = '🌿'; ic.value = r.icon;
        ic.oninput = function () { r.icon = ic.value; };
        var ka = document.createElement('input'); ka.style.cssText = _PANEL_IN_CSS; ka.placeholder = 'წარწერა'; ka.value = r.ka;
        ka.oninput = function () { r.ka = ka.value; };
        l1.appendChild(ic); l1.appendChild(ka);
        var en = document.createElement('input'); en.style.cssText = _PANEL_IN_CSS; en.placeholder = 'label (EN, ოფციონალური)'; en.value = r.en;
        en.oninput = function () { r.en = en.value; };
        var l3 = document.createElement('div'); l3.style.cssText = 'display:flex;gap:4px;';
        var ac = document.createElement('input'); ac.style.cssText = _PANEL_IN_CSS; ac.placeholder = '/ბრძანება  ან  მაკროს სახელი'; ac.value = r.action;
        var note = document.createElement('div'); note.style.cssText = 'font-size:11px;min-height:12px;';
        function validate() {
          var res = _panelCheckAction(ac.value);
          if (res.ok) { r.action = res.action; note.style.color = '#d29922'; note.textContent = res.warn || ''; }
          else { r.action = ac.value; note.style.color = '#f85149'; note.textContent = res.msg; }
          return res.ok;
        }
        ac.oninput = function () { r.action = ac.value; };
        ac.onchange = validate;
        var del = _panelBtnEl(_PANEL_BTN_CSS + 'width:44px;flex:none;margin:0 0 4px;', '✕', function () { rows.splice(idx, 1); drawRows(); });
        l3.appendChild(ac); l3.appendChild(del);
        card.appendChild(l1); card.appendChild(en); card.appendChild(l3); card.appendChild(note);
        listEl.appendChild(card);
        if (r.action) validate();
      });
      _panelFit();
    }
    drawRows();

    body.appendChild(_panelBtnEl(_PANEL_BTN_CSS, '+', function () {
      if (rows.length >= HX_MAX_BTNS) { msgEl.style.color = '#f85149'; msgEl.textContent = 'მაქსიმუმ ' + HX_MAX_BTNS + ' ღილაკი'; return; }
      rows.push({ id: 'b' + Math.random().toString(36).slice(2, 8), icon: '', ka: '', en: '', action: '' });
      drawRows();
    }));

    var save;
    async function doSave() {
      msgEl.style.color = '#f85149';
      var title = inTitle.value.trim();
      if (!title) { msgEl.textContent = 'სათაური სავალდებულოა'; return; }
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var res = _panelCheckAction(r.action);   // re-validate: tier/macros may have changed since typing
        if (!r.ka.trim()) { msgEl.textContent = 'ღილაკი №' + (i + 1) + ': წარწერა ცარიელია'; return; }
        if (!res.ok) { msgEl.textContent = 'ღილაკი №' + (i + 1) + ': ' + res.msg; return; }
        var label = { ka: r.ka.trim() };
        var en = r.en.trim();
        if (en && en !== label.ka) label.en = en;   // en only when it really differs (untouched-field rule)
        out.push({ id: r.id, type: 'cmd', label: label, icon: r.icon.trim(), action: res.action });
      }
      var tEn = inTitleEn.value.trim();
      var ci = inCenter.value.trim();
      var payload = { panel_id: work.panel_id, title: title, title_en: (tEn && tEn !== title) ? tEn : null,
        icon: inIcon.value.trim() || null, buttons: out, config: ci ? { center: { icon: ci } } : {} };
      save.disabled = true; msgEl.style.color = '#8b949e'; msgEl.textContent = '⏳ ინახება...';
      var sres = await hexagonSave(payload);
      save.disabled = false;
      if (!sres.ok) {
        msgEl.style.color = '#f85149';
        msgEl.textContent = (sres.status === 409 || /duplicate|unique/i.test(sres.msg || '')) ? 'ამ სახელით პანელი ან ჰექსაგონი უკვე გაქვს'
          : (/limit/i.test(sres.msg || '') ? 'ლიმიტი (20) ამოიწურა — პანელები და ჰექსაგონები ერთად ითვლება' : ('✗ ვერ შეინახა — ' + (sres.msg || sres.status)));
        return;
      }
      _setState({ on: true, id: sres.row.panel_id });   // a saved hexagon becomes the active one
      _note('✓ ჰექსაგონი შენახულია');
      closeHsPopup();
      _refresh(false);
    }
    var bar = _panelSetBar([
      { glyph: '✓', label: 'შენახვა', onclick: doSave },
      { glyph: '✕', label: 'გაუქმება', onclick: function () { closeHsPopup(); } }
    ]);
    save = bar[0];
    _panelFit();
  }

  // ── terminal command: /ჰექსაგონი ─────────────────────────────────────────
  //   (none)                      list (● = active)
  //   ახალი [სახელი]              editor for a new hexagon
  //   <სახელი|№>                  turn it on, make it active, show the ring
  //   რედ <სახელი|№>              editor
  //   წაშ <სახელი|№> დიახ         delete (without "დიახ": preview only)
  //   გამორთვა                    remove the launcher from the screen (state stays saved)
  async function hexagonCommand(args) {
    args = args || [];
    if (!_uid()) { _tmL('ter', '✗ ჰექსაგონისთვის საჭიროა შესვლა — /ლოგინი'); return; }
    await hexagonsLoad();
    if (_stale) _tmL('tdm', '⚠ ქეშიდან (ოფლაინ) — ჩართვა შეიძლება, ცვლილებას ქსელი სჭირდება');
    var sub = (args[0] || '').trim();
    var st = _getState();

    if (!sub) {
      _tmL('tdm', '────────────────────');
      if (!_hexagons.length) _tmL('tdm', '(ჰექსაგონი არ გაქვს — /ჰექსაგონი ახალი <სახელი>)');
      _hexagons.forEach(function (h, i) {
        var on = st.on && st.id === h.panel_id;
        _tmL('tnf', (i + 1) + '. ' + (h.icon ? h.icon + ' ' : '') + h.title + '  (' + ((h.buttons || []).length) + ' ღილაკი)' + (on ? '  ●' : ''));
      });
      _tmL('tdm', '────────────────────');
      return;
    }
    if (sub === 'ახალი') {
      if (_stale || !navigator.onLine) { _tmL('ter', '✗ ოფლაინ — ახალი ჰექსაგონი ქსელს საჭიროებს'); return; }
      closeTerm(); hexagonEdit(null, args.slice(1).join(' ').trim()); return;
    }
    if (sub === 'გამორთვა') {
      _setState({ on: false, id: st.id });
      _refresh(false);
      _tmL('tok', '✓ ჰექსაგონი გამორთულია (ჩასართავად: /ჰექსაგონი <სახელი>)');
      return;
    }

    var isEdit = sub === 'რედ', isDel = sub === 'წაშ';
    var rest = (isEdit || isDel) ? args.slice(1) : args.slice(0);
    var confirmed = false;
    if (isDel && rest.length && rest[rest.length - 1] === 'დიახ') { confirmed = true; rest = rest.slice(0, -1); }
    var q = rest.join(' ').trim();
    if (!q) { _tmL('ter', 'გამოყენება: /ჰექსაგონი [სახელი|№] · ახალი [სახელი] · რედ <სახელი|№> · წაშ <სახელი|№> დიახ · გამორთვა'); return; }
    var h = hexagonFind(q);
    if (!h) { _tmL('ter', '✗ ჰექსაგონი ვერ მოიძებნა: ' + q + '  (სია: /ჰექსაგონი)'); return; }

    if (isDel) {
      if (!confirmed) { _tmL('tdm', 'წაიშლება: ' + h.title + ' (' + ((h.buttons || []).length) + ' ღილაკი). დასადასტურებლად: /ჰექსაგონი წაშ ' + h.title + ' დიახ'); return; }
      var dres = await hexagonDelete(h.panel_id);
      if (dres.ok) { _refresh(false); _tmL('tok', '✓ წაიშალა: ' + h.title); }
      else _tmL('ter', '✗ ვერ წაიშალა — ' + (dres.msg || dres.status));
      return;
    }
    if (isEdit) {
      if (_stale || !navigator.onLine) { _tmL('ter', '✗ ოფლაინ — რედაქტირებას ქსელი სჭირდება'); return; }
      closeTerm(); hexagonEdit(h); return;
    }
    // activate: on + remembered as the last called, ring shown open
    _setState({ on: true, id: h.panel_id });
    closeTerm();
    _refresh(true);
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  global.hexagonsLoad = hexagonsLoad;
  global.hexagonFind = hexagonFind;
  global.hexagonSave = hexagonSave;
  global.hexagonDelete = hexagonDelete;
  global.hexagonEdit = hexagonEdit;
  global.hexagonCommand = hexagonCommand;
  global.hexagonRefresh = _refresh;

  _trackViewport();
  if (global.visualViewport) global.visualViewport.addEventListener('resize', _tick);
  global.addEventListener('resize', _tick);
  setInterval(_tick, 400);
})(window);
