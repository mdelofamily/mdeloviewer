// hexagon.js — mdeloviewer: hexagon launcher (stage 1: ring; stage 2: linear scroll with edge shrink).
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

  var HX_W = 30, HX_H = 34;          // peripheral hex (pointy-top), px
  var HX_CW = 38, HX_CH = 44;        // centre hex: width = quest button (38px); regular pointy-top height
  var HX_GAP = 33;                   // distance between neighbouring hex centres along the arc, px
  var HX_SPAN = 80;                  // preferred arc span, degrees (centred on 135deg)
  var HX_RMIN = 64;                  // smallest ring radius, px
  var HX_CY_FROM_BOTTOM = 33;        // quest button: bottom 14px + 38/2 -> centre line shared with the launcher
  var HX_MAX_BTNS = 30;              // = panels.buttons limit (30)
  var HX_VISIBLE = 5;                // slots shown at once; the rest is reached by scrolling
  var HX_HOLD_MS = 400;              // long-tap on the centre hex runs config.center.action
  var HX_SLOT_PX = 40;               // vertical finger travel per slot
  var HX_DEAD_PX = 6;                // movement below this is a tap, not a scroll
  var HX_EDGE_SCALE = 0.5;           // size of a hex one slot beyond the arc end (1 at the end slots); outer hexes only shrink, they do not fade
  var HX_CENTER_IMG = 'logo.png';    // centre hex picture (mdeloviewer root, precached by sw.js); swap the file name to change it
  var HX_CLIP = 'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)';

  var _hexagons = [];                // rows with layout='ring'
  var _stale = false;                // list came from the offline snapshot
  var _loadedFor = null;             // user id the list was loaded for
  var _loading = false;              // a network refresh is in flight
  var _syncedFor = null;             // user id a network refresh was already started for
  var HX_FETCH_MS = 4000;            // network timeout; the offline copy is shown meanwhile
  var _root = null, _pad = null, _ring = null, _fab = null;
  var _open = false;
  var _sig = '';                     // signature of what is currently rendered
  var _els = [], _slots = 0, _maxOff = 0;   // rendered hexes, slots used, max scroll offset (in slots)
  var _off = 0, _offFor = null;      // current scroll offset (slots) and the hexagon it belongs to
  var _drag = null, _wasDrag = false;
  var _centerAction = '';            // command run by a long-tap on the centre hex (config.center.action)
  var _holdT = null, _holdXY = null, _fabLong = false;
  var _baseH = 0, _baseW = 0;        // largest viewport seen (keyboard detection)
  var _centerFn = null;              // nav mode: function run by a long-tap on the centre hex (instead of _centerAction)
  var _centerTapFn = null;           // nav mode: function run by a plain tap on the centre hex (instead of folding the ring)
  var _navSelSec = null;             // nav mode: selected SECTION (long-tap on its hex) -> rename / delete ring
  var _navCreate = false;            // nav mode: the ring shows the "what to create" choice (section / text / todo)
  var _navBuf = null, _navBusy = false;   // nav clipboard { mode:'copy'|'cut', node, ref, id, item } (this session only)
  var _navSel = null;                // nav mode: selected leaf { node, id, idx } (null = none)
  var _navDel = false, _navDelT = null;   // nav mode: delete waits for a second tap

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
  function _loadSnap() {
    var snap = null;
    try { snap = JSON.parse(localStorage.getItem(_snapKey()) || 'null'); } catch (e) {}
    if (!Array.isArray(snap)) return false;
    _hexagons = snap;
    return true;
  }
  function _saveSnap() { try { localStorage.setItem(_snapKey(), JSON.stringify(_hexagons)); } catch (e) {} }

  // network first (with a timeout), the offline copy as fallback
  async function hexagonsLoad() {
    var uid = _uid();
    _stale = false;
    if (!uid) { _hexagons = []; _loadedFor = null; return _hexagons; }
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, HX_FETCH_MS) : null;
    try {
      if (!navigator.onLine) throw new Error('offline');
      var r = await fetch(SUPA_URL + '/rest/v1/panels?map_id=eq.' + encodeURIComponent(_MAP_ID) +
        '&layout=eq.ring&select=*&order=title.asc', { headers: _authHeaders(), signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var rows = await r.json();
      _hexagons = Array.isArray(rows) ? rows : [];
      _saveSnap();
    } catch (e) {
      if (!_loadSnap()) _hexagons = [];
      _stale = true;   // read-only: saving needs the network
    } finally { if (to) clearTimeout(to); }
    _loadedFor = uid;
    return _hexagons;
  }

  // after a successful write whose list refresh failed: keep the local copy correct
  function _upsertLocal(row) {
    var i = -1;
    for (var k = 0; k < _hexagons.length; k++) if (_hexagons[k].panel_id === row.panel_id) { i = k; break; }
    if (i >= 0) _hexagons[i] = row; else _hexagons.push(row);
    _hexagons.sort(function (a, b) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; });
    _saveSnap();
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
      if (_stale) _upsertLocal(row);   // refresh failed (slow network): still show the saved hexagon
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
      if (_stale) { _hexagons = _hexagons.filter(function (x) { return x.panel_id !== id; }); _saveSnap(); }
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

  // section = double frame (outer + inner polygon); a leaf keeps the single frame
  var HX_SVG_SEC = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="50,0 100,25 100,75 50,100 0,75 0,25" fill="none" stroke="rgba(88,166,255,0.35)" ' +
    'stroke-width="1" vector-effect="non-scaling-stroke"/>' +
    '<polygon points="50,13 87,34 87,66 50,87 13,66 13,34" fill="none" stroke="rgba(88,166,255,0.35)" ' +
    'stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';

  // copied leaf = dashed frame
  var HX_SVG_COPY = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="50,0 100,25 100,75 50,100 0,75 0,25" fill="none" stroke="rgba(88,166,255,0.35)" ' +
    'stroke-width="1" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/></svg>';

  function _ensureStyle() {
    if (document.getElementById('hexStyles')) return;
    var st = document.createElement('style'); st.id = 'hexStyles';
    var glass = 'background:rgba(22,27,34,0.4);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);' +
      'clip-path:' + HX_CLIP + ';-webkit-clip-path:' + HX_CLIP + ';border:none;padding:0;margin:0;cursor:pointer;' +
      '-webkit-tap-highlight-color:transparent;';
    st.textContent =
      '#hxRoot{position:fixed;right:14px;bottom:' + (HX_CY_FROM_BOTTOM - HX_CH / 2) + 'px;width:' + HX_CW + 'px;height:' + HX_CH + 'px;' +
        'z-index:32;display:none;}' +
      '#hxRoot .hx-ring{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}' +
      '#hxRoot .hx{position:absolute;left:calc(50% - ' + (HX_W / 2) + 'px);top:calc(50% - ' + (HX_H / 2) + 'px);' +
        'width:' + HX_W + 'px;height:' + HX_H + 'px;' + glass + 'pointer-events:none;visibility:hidden;' +
        'transform:translate(0,0) scale(.2);touch-action:none;' +
        'transition:transform 170ms ease,visibility 0s linear 170ms;}' +
      '#hxRoot.open .hx{transform:translate(var(--dx),var(--dy)) scale(var(--sc,1));pointer-events:auto;visibility:visible;' +
        'transition:transform 170ms ease,visibility 0s;}' +
      '#hxRoot.drag .hx{transition:none !important;}' +
      '#hxRoot .hx.cut{opacity:.4;}' +
      '#hxRoot{touch-action:none;}' +
      '#hxRoot .hx-pad{position:absolute;right:0;bottom:0;pointer-events:none;touch-action:none;}' +
      '#hxRoot.open .hx-pad{pointer-events:auto;}' +
      '#hxRoot .hx:active{background:rgba(88,166,255,0.22);}' +
      '#hxRoot svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}' +
      '#hxRoot .hx-in{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
        'color:rgba(200,210,220,0.92);font-size:17px;line-height:1;}' +
      '#hxFab{position:absolute;left:0;top:0;width:' + HX_CW + 'px;height:' + HX_CH + 'px;' + glass + '}' +
      '#hxFab .hx-in{font-size:17px;}' +
      '#hxFab{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}' +
      '#hxRoot,#hxRoot *{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}' +   // long-tap must never select the emoji / open the text-selection bar
      '#hxFab img{width:110%;height:110%;object-fit:contain;pointer-events:none;-webkit-user-drag:none;}' +
      '#hxRoot.open #hxFab{background:rgba(88,166,255,0.18);}';
    document.head.appendChild(st);
  }

  // ── nav mode: the menu tree as a file manager ───────────────────────────
  // Per device (localStorage), applies to the active hexagon: its saved buttons are NOT touched, the ring is
  // just drawn from the terminal's current menu section (_tmMenuStack, terminal.js) instead.
  //   section hex (double frame): tap = enter       leaf hex: tap = select it (centre shows its emoji)
  //   centre: tap = up, long-tap = root (at root: nav mode off); the ring never folds in nav mode
  //   long-tap on a section hex: its own ring — ✏️ title editor, 🗑️ delete (two taps; takes the whole subtree incl. media)
  //   ➕ (end of the ring): choose section / text / todo -> the terminal opens with /md, /ტექსტი or /todo typed in
  //   selected leaf: ✏️ = /რედ <id>  📋 copy  ✂️ cut  📌 pin/unpin on the active HUD (todo only, needs window.hudPinInfo from hud.js)  🗑️ = /წაშ <index> (two taps); 📥 = paste
  //   (marks: copied = dashed frame, cut = half transparent; the clipboard lives until reload / nav off)
  // Editing/deleting go through _panelPress -> tmRun, so the terminal re-checks the tier (resident+).
  // emoji of the nav-only buttons — change here (one place)
  var HX_NAV_ICON = { add: '➕', sec: '📁', text: '📝', todo: '📋', pin: '📌' };

  function _navKey() { return 'mdelo_hexagon_nav_' + (_uid() || 'anon') + '_' + _MAP_ID; }
  function _navOn() { try { return localStorage.getItem(_navKey()) === '1'; } catch (e) { return false; } }
  function _navSet(on) { try { localStorage.setItem(_navKey(), on ? '1' : '0'); } catch (e) {} }
  function _navStack() { return (typeof _tmMenuStack !== 'undefined' && Array.isArray(_tmMenuStack)) ? _tmMenuStack : []; }
  function _navNode() { var st = _navStack(); return st.length ? st[st.length - 1] : null; }
  function _navList(node) { return node ? (node.children || []) : ((typeof _CFG !== 'undefined' && _CFG.menu) || []); }
  function _navItemObj(it) { return typeof it === 'string' ? { type: 'text', emoji: '•', label: it } : (it || {}); }
  function _navItemIcon(it) { var o = _navItemObj(it); return _firstGlyph(o.emoji) || (o.type === 'todo' ? '📋' : '📝'); }
  // index of the selected leaf in the current section (by id; id-less old items by index), -1 = none/invalid
  function _navFindSel(node) {
    if (!_navSel || !node || _navSel.node !== node || !node.items) return -1;
    if (_navSel.id) {
      for (var i = 0; i < node.items.length; i++) { var o = node.items[i]; if (o && typeof o === 'object' && o.id === _navSel.id) return i; }
      return -1;
    }
    return node.items[_navSel.idx] !== undefined ? _navSel.idx : -1;
  }
  // what the ring shows, as a string: any change (cd, add, delete, new emoji, selection) redraws it on the next _tick
  function _navSig() {
    var node = _navNode();
    var s = _navStack().map(function (n) { return n.id || ''; }).join('>') + '#';
    _navList(node).forEach(function (n) { s += (n.id || '') + ':' + (n.icon || '') + ';'; });
    s += '#';
    ((node && node.items) || []).forEach(function (it) { var o = _navItemObj(it); s += (o.id || '') + ':' + (o.emoji || '') + (o.type || '') + ';'; });
    var psi = _navFindSel(node);
    return s + '#' + psi + (_navSel && _navSel.id ? _navSel.id : '') + (_navDel ? '!' : '') + (_navCreate ? '+' : '') + (_navSelSec ? 'S' + (_navSelSec.id || '') : '') +
      (psi >= 0 && _navIsPin(node.items[psi]) ? 'P' : '') + (_navPinInfo() ? 'h' : '') +
      (_navBuf ? '|buf:' + _navBuf.mode + (_navBuf.id || '') + (_navBuf.node === node ? 's' : '') : '');
  }
  function _navReset() { _navSel = null; _navSelSec = null; _navDel = false; _navCreate = false; if (_navDelT) { clearTimeout(_navDelT); _navDelT = null; } }
  function _navUp() {
    var st = _navStack();
    if (!st.length) { _note('root'); return; }
    st.pop(); _navReset(); _refresh(false);
  }
  // pin = the leaf's id is added to the ACTIVE HUD (hud.js stores ids, so it is a live reference, not a copy). Only todo can be a bar.
  function _navPinInfo() { return typeof window.hudPinInfo === 'function' ? window.hudPinInfo() : null; }
  function _navIsPin(it) {
    var o = _navItemObj(it), info = _navPinInfo();
    return !!(info && o.id && info.ids.indexOf(o.id) >= 0);
  }
  function _navPin(el) {
    var node = _navNode(), i = _navFindSel(node);
    if (i < 0) { _navReset(); _refresh(false); return; }
    var info = _navPinInfo();
    if (!info) { _note('✗ ჯერ აირჩიე HUD: /ჰუდი <სახელი>'); return; }
    var it = node.items[i], o = _navItemObj(it);
    // same commands as by hand: /ჰუდი + <id>  /  /ჰუდი − <id>  (shared HUD: /საერთოჰუდი); the ring redraws when the HUD state changes
    var was = _navIsPin(it);
    _panelPress({ action: (info.shared ? '/საერთოჰუდი' : '/ჰუდი') + (was ? ' − ' : ' + ') + (o.id || String(i)) }, el);
    setTimeout(function () {   // the command's own error text goes to the terminal log: if nothing changed, tell the user here
      if (_navIsPin(it) === was) _note('⚠ პინი ვერ გადაირთო (ლიმიტი ან კავშირი?) — ნახე ტერმინალი');
    }, 2000);
  }
  // ── section selection (long-tap): ✏️ title editor (same as /სექცია/ა/ბ), 🗑️ delete with two taps ──
  function _navKa(t) { return typeof t === 'string' ? t : ((t && t.ka) || ''); }
  function _navCount(n) {   // what a section delete takes with it
    var c = { leaves: (n.items || []).length, secs: 0 };
    (n.children || []).forEach(function (ch) { var d = _navCount(ch); c.secs += 1 + d.secs; c.leaves += d.leaves; });
    return c;
  }
  function _navArm() {   // first tap of a delete: arm (⚠️), disarms itself after 3.5 s
    _navDel = true;
    if (_navDelT) clearTimeout(_navDelT);
    _navDelT = setTimeout(function () { _navDelT = null; _navDel = false; _refresh(false); }, 3500);
    _refresh(false);
  }
  function _navSecRename() {
    var sec = _navSelSec;
    if (!sec || !_tierOk() || typeof _tmMenuTitleEditOpen !== 'function') return;
    var segs = _navStack().map(function (n) { return _navKa(n.title); }).concat([_navKa(sec.title)]);
    if (segs.some(function (x) { return !x || x.indexOf('/') >= 0; })) { _note('✗ სახელში \"/\" არის ან ქართული სახელი არ აქვს — ბილიკით ვერ მივადგები'); return; }
    if (typeof _tmOpen !== 'undefined' && !_tmOpen && typeof _tmOpen_ === 'function') _tmOpen_();
    _tmMenuTitleEditOpen(segs);   // opens the title editor in the terminal (path from root, by exact title)
    _navReset(); _refresh(false);
  }
  function _navSecRemove(el) {
    var sec = _navSelSec, node = _navNode();
    if (!sec || !_tierOk() || _navList(node).indexOf(sec) < 0) { _navReset(); _refresh(false); return; }
    var title = _navKa(sec.title);
    if (!title || /^\d+$/.test(title)) { _note('✗ ამ სახელით /წაშ ვერ მიაგნებს (ცარიელია ან მხოლოდ ციფრებია) — ჯერ გადაარქვი'); return; }
    if (!_navDel) { _navArm(); return; }
    _navReset();
    _panelPress({ action: '/წაშ ' + title }, el);   // exact-title match in the current section; removes the whole subtree incl. its media
    _refresh(false);
  }
  function _navRoot() {
    var st = _navStack();
    if (!st.length) { _navOff(); return; }   // already at root: long-tap switches nav mode off
    st.length = 0; _navReset(); _refresh(false);
  }
  function _navOff() {
    _navSet(false); _navReset(); _navBuf = null;
    _refresh(false); _setOpen(false);
    _note('ნავიგაცია გამორთულია');
  }
  // creation = the terminal's own flow: the command is typed in for you, you add the name (+ optional emoji as the last word);
  // on Enter the usual creation editor opens (text / todo), /md enters the new section
  function _navPrefill(cmd) {
    if (typeof _tmOpen !== 'undefined' && !_tmOpen && typeof _tmOpen_ === 'function') _tmOpen_();
    setTimeout(function () {
      var el = document.getElementById((typeof _tmMulti !== 'undefined' && _tmMulti) ? 'tmTa' : 'tmIn');
      if (!el) return;
      el.value = cmd;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      el.focus();
      try { el.setSelectionRange(cmd.length, cmd.length); } catch (e) {}
    }, 280);
  }
  function _navTitle(it) {
    var t = (typeof _tmItemTitles === 'function' ? _tmItemTitles(it)[0] : '') || '';
    return t || String(_i18n(_navItemObj(it).label) || '').slice(0, 30);
  }
  // index of the clipboard's source leaf in its section (identity first, then id), -1 = gone
  function _navBufSrcIdx() {
    if (!_navBuf || !_navBuf.node || !_navBuf.node.items) return -1;
    var items = _navBuf.node.items, i = items.indexOf(_navBuf.ref);
    if (i >= 0) return i;
    if (_navBuf.id) for (i = 0; i < items.length; i++) if (items[i] && typeof items[i] === 'object' && items[i].id === _navBuf.id) return i;
    return -1;
  }
  function _navBufSet(mode) {
    if (!_tierOk()) return;
    var node = _navNode(), i = _navFindSel(node);
    if (i < 0) { _navReset(); _refresh(false); return; }
    var it = node.items[i];
    if (mode === 'copy' && it && typeof it === 'object' && it.segments && typeof _tmSegmentFileUrls === 'function' &&
        _tmSegmentFileUrls(it.segments).length) {
      _note('✗ მედიის მქონე ფოთლის ასლი ჯერ არ შეიძლება — გამოიყენე ✂️'); return;   // both copies would share the same files
    }
    _navBuf = { mode: mode, node: node, ref: it, id: (it && typeof it === 'object') ? (it.id || null) : null, item: JSON.parse(JSON.stringify(it)) };
    _note((mode === 'copy' ? '📋 ' : '✂️ ') + _navTitle(it));
    _navReset(); _refresh(false);
  }
  // a copy gets fresh ids (item + todo children), otherwise it would share its menu_todo_state rows with the original
  function _navCloneFresh(it) {
    if (typeof it === 'string') return it;
    var c = JSON.parse(JSON.stringify(it)), used = {};
    function nid(parent) { return typeof _tmTodoNewId === 'function' ? _tmTodoNewId(used) : ('todo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)); }
    delete c.id;   // _tmMenuSaveNode -> _tmEnsureItemIds gives the item its id
    (function walk(n) {
      if ('checked' in n) n.checked = false;
      (n.children || []).forEach(function (ch) { ch.id = nid(); walk(ch); });
    })(c);
    return c;
  }
  async function _navPaste() {
    if (_navBusy || !_navBuf || !_tierOk()) return;
    var dst = _navNode();
    if (!dst || typeof _tmMenuSaveNode !== 'function') return;
    var b = _navBuf, item, si = -1;
    if (b.mode === 'cut') {
      si = _navBufSrcIdx();
      if (si < 0) { _note('✗ ამოჭრილი ფოთოლი ვეღარ მოიძებნა'); _navBuf = null; _refresh(false); return; }
      if (b.node === dst) { _note('იგივე სექციაა'); _navBuf = null; _refresh(false); return; }
      item = b.node.items[si];
    } else {
      item = _navCloneFresh(b.item);
    }
    if (typeof _tmNameClash === 'function' && typeof _tmItemTitles === 'function' &&
        _tmItemTitles(item).some(function (t) { return _tmNameClash(dst, t); })) {
      _note('✗ ამ სექციაში უკვე არის \"' + _navTitle(item) + '\" — ჯერ გადაარქვი (✏️)'); return;
    }
    _navBusy = true;
    try {
      if (!dst.items) dst.items = [];
      dst.items.push(item);
      await _tmMenuSaveNode(dst.id, { items_json: dst.items });   // 1) it lands in the destination ...
      if (b.mode === 'cut') {                                      // 2) ... only then it leaves the source (no media delete: files move with it)
        var j = b.node.items.indexOf(item);
        if (j >= 0) b.node.items.splice(j, 1);
        await _tmMenuSaveNode(b.node.id, { items_json: b.node.items });
        _navBuf = null;
      }
      _note('📥 ' + _navTitle(item));
    } finally { _navBusy = false; _navSel = null; _refresh(false); }
  }
  function _navEdit(el) {
    var node = _navNode(), i = _navFindSel(node);
    if (i < 0) { _navReset(); _refresh(false); return; }
    var it = node.items[i], ref = (it && typeof it === 'object' && it.id) ? it.id : String(i);
    // the editor lives inside the terminal overlay: it has to be open to be seen
    if (typeof _tmOpen !== 'undefined' && !_tmOpen && typeof _tmOpen_ === 'function') _tmOpen_();
    _panelPress({ action: '/რედ ' + ref }, el);
    _navReset(); _refresh(false);
  }
  function _navRemove(el) {
    var node = _navNode(), i = _navFindSel(node);
    if (i < 0) { _navReset(); _refresh(false); return; }
    if (!_navDel) {   // first tap: arm (⚠️), disarms itself after 3.5 s
      _navDel = true;
      if (_navDelT) clearTimeout(_navDelT);
      _navDelT = setTimeout(function () { _navDelT = null; _navDel = false; _refresh(false); }, 3500);
      _refresh(false); return;
    }
    _navReset();
    _panelPress({ action: '/წაშ ' + i }, el);   // numeric = leaf by index (section names are never numeric here)
    _refresh(false);
  }
  // virtual hexagon for _render(): same shape as a saved one, buttons carry local handlers (fn)
  function _navVirtual(h) {
    var node = _navNode(), btns = [], si = _navFindSel(node);
    if (_navSel && si < 0) _navReset();
    var v = { panel_id: h.panel_id + '|nav|' + _navStack().map(function (n) { return n.id || ''; }).join('>') + (_navSel ? '|sel' : ''),
      buttons: btns, config: { center: {} } };
    if (_navSel) {
      v.config.center.icon = _navItemIcon(node.items[si]);
      v._centerTapFn = v._centerFn = function () { _navReset(); _refresh(false); };   // back to the section
      btns.push({ icon: '✏️', label: 'რედაქტირება', fn: _navEdit });
      btns.push({ icon: '📋', label: 'ასლი', fn: function () { _navBufSet('copy'); }, keepOpen: true });
      btns.push({ icon: '✂️', label: 'ამოჭრა', fn: function () { _navBufSet('cut'); }, keepOpen: true });
      var sit = node.items[si], sto = _navItemObj(sit);
      if (sto.type === 'todo' || sto.type === 'progress') {   // HUD bars exist only for todo (slider / checklist)
        var pinned = _navIsPin(sit);
        btns.push({ icon: HX_NAV_ICON.pin, label: pinned ? 'HUD-დან მოხსნა' : 'HUD-ზე მიპინვა', sec: pinned, keepOpen: true, fn: _navPin });   // pinned = double frame
      }
      btns.push({ icon: _navDel ? '⚠️' : '🗑️', label: _navDel ? 'წაშლა — კიდევ ერთი ტაპი' : 'წაშლა', fn: _navRemove, keepOpen: true });
      return v;
    }
    if (_navSelSec) {
      var ssec = _navSelSec;
      if (_navList(node).indexOf(ssec) < 0) _navReset();   // it vanished (deleted elsewhere)
      else {
        var cnt = _navCount(ssec);
        v.panel_id += '|ssec';
        v.config.center.icon = _firstGlyph(ssec.icon) || '📁';
        v._centerTapFn = v._centerFn = function () { _navReset(); _refresh(false); };   // back to the section
        btns.push({ icon: '✏️', label: 'სახელის შეცვლა', fn: _navSecRename });
        btns.push({ icon: _navDel ? '⚠️' : '🗑️', label: _navDel ? ('წაშლა — ' + cnt.leaves + ' ფოთოლი, ' + cnt.secs + ' ქვე-სექცია') : 'წაშლა', fn: _navSecRemove, keepOpen: true });
        return v;
      }
    }
    if (_navCreate && node) {
      v.panel_id += '|new';
      v.config.center.icon = HX_NAV_ICON.add;
      v._centerTapFn = v._centerFn = function () { _navCreate = false; _refresh(false); };   // cancel
      [['sec', 'სექცია', '/md '], ['text', 'ტექსტი', '/ტექსტი '], ['todo', 'todo', '/todo ']].forEach(function (c) {
        btns.push({ icon: HX_NAV_ICON[c[0]], label: c[1], keepOpen: true,
          fn: function () { _navCreate = false; _refresh(false); _navPrefill(c[2]); } });
      });
      return v;
    }
    v.config.center.icon = node ? (_firstGlyph(node.icon) || '📁') : '';   // root: empty = the default logo
    v._centerTapFn = _navUp;   // tap = up one level
    v._centerFn = _navRoot;    // long-tap = root
    _navList(node).forEach(function (n) {
      btns.push({ icon: _firstGlyph(n.icon) || '📁', label: _i18n(n.title) || '', sec: true, keepOpen: true,
        longFn: function () { _navSel = null; _navCreate = false; _navDel = false; _navSelSec = n; _refresh(false); },
        fn: function () { _navStack().push(n); _navReset(); _refresh(false); } });
    });
    ((node && node.items) || []).forEach(function (it, i) {
      var o = _navItemObj(it);
      var isSrc = _navBuf && _navBuf.node === node && (_navBuf.ref === it || (_navBuf.id && o.id === _navBuf.id));
      btns.push({ icon: _navItemIcon(it), mark: isSrc ? _navBuf.mode : undefined, label: String(_i18n(o.label) || '').replace(/\n/g, ' ').slice(0, 40), keepOpen: true,
        fn: function () { _navSel = { node: node, id: o.id || null, idx: i }; _navDel = false; _refresh(false); } });
    });
    var tail = [{ icon: HX_NAV_ICON.add, label: 'შექმნა', keepOpen: true,
      fn: function () { if (!node) { _navPrefill('/md '); return; } _navSel = null; _navCreate = true; _refresh(false); } }];   // root: only sections exist, straight to /md
    if (_navBuf && node) tail.push({ icon: '📥', label: 'ჩასმა: ' + _navTitle(_navBuf.item), keepOpen: true, fn: _navPaste });
    v.buttons = btns.slice(0, HX_MAX_BTNS - tail.length).concat(tail);   // the ring caps at 30: the tail (➕ 📥) must never be cut off
    return v;
  }

  // ── launcher DOM ─────────────────────────────────────────────────────────
  function _build() {
    if (_root) return;
    _ensureStyle();
    _root = document.createElement('div'); _root.id = 'hxRoot';
    _ring = document.createElement('div'); _ring.className = 'hx-ring';
    _fab = document.createElement('button'); _fab.id = 'hxFab';
    _fab.setAttribute('aria-label', 'ჰექსაგონი');
    _fab.onclick = function () {
      if (_fabLong) { _fabLong = false; return; }   // the click that ends a long-tap is not a toggle
      if (_centerTapFn) { _centerTapFn(); return; }   // nav mode: the ring is always open, the centre goes up
      _setOpen(!_open);
    };
    // long-tap (no movement) on the centre hex runs the saved command, same path as a panel button
    function _clearHold() { if (_holdT) { clearTimeout(_holdT); _holdT = null; } }
    _fab.addEventListener('pointerdown', function (e) {
      _fabLong = false; _clearHold();
      if (!_centerAction && !_centerFn) return;
      _holdXY = { x: e.clientX, y: e.clientY };
      _holdT = setTimeout(function () {
        _holdT = null; _fabLong = true;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (x) {}
        if (_centerFn) { _centerFn(); return; }   // nav mode: up / leave the selection; the ring stays as it is
        if (typeof _panelPress === 'function') _panelPress({ action: _centerAction }, _fab);
        _setOpen(false);
      }, HX_HOLD_MS);
    });
    _fab.addEventListener('pointermove', function (e) {
      if (_holdT && _holdXY && Math.hypot(e.clientX - _holdXY.x, e.clientY - _holdXY.y) > 8) _clearHold();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { _fab.addEventListener(ev, _clearHold); });
    _fab.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    _root.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // every ring hex, not only those with a long-tap
    // invisible touch area = the whole radius: taps/drags inside it neither fold the ring nor reach the map
    _pad = document.createElement('div'); _pad.className = 'hx-pad';
    _root.appendChild(_pad); _root.appendChild(_ring); _root.appendChild(_fab);
    // keep gestures on the launcher away from the map pan/zoom handlers
    ['touchstart', 'touchmove', 'touchend'].forEach(function (ev) {
      _root.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });
    document.body.appendChild(_root);
    _root.addEventListener('pointerdown', _onDown);
    _root.addEventListener('pointermove', _onMove);
    _root.addEventListener('pointerup', _onUp);
    _root.addEventListener('pointercancel', _onUp);
    // tap anywhere outside folds the ring (capture, so the map still receives the gesture)
    document.addEventListener('pointerdown', function (e) {
      if (_open && _root && !_root.contains(e.target) && !_navOn()) _setOpen(false);
    }, true);
  }

  function _setOpen(on) {
    if (_navOn()) on = true;   // nav mode: the ring never folds (switch it off with /ჰექსაგონი ნავ)
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

  var _clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

  // Place every hex for scroll offset `off` (in slots). Slot q = i - off; the arc has _slots positions.
  // Hexes outside the arc ends shrink (edge = 1 at the end slots, 0 one slot beyond, where they are hidden).
  function _place(off) {
    var g = _arc(_slots);
    var S = Math.round(g.R + HX_H / 2 + 10);   // radius of the touch area around the FAB centre
    _pad.style.width = (S + HX_CW / 2) + 'px'; _pad.style.height = (S + HX_CH / 2) + 'px';
    _pad.style.clipPath = _pad.style.webkitClipPath = 'circle(' + S + 'px at calc(100% - ' + (HX_CW / 2) + 'px) calc(100% - ' + (HX_CH / 2) + 'px))';
    _els.forEach(function (el) {
      var q = el._i - off;
      var a = (135 + (_slots - 1) / 2 * g.step - q * g.step) * Math.PI / 180;
      var d = Math.min(q, (_slots - 1) - q);
      var edge = _clamp(d + 1, 0, 1);
      el.style.setProperty('--dx', Math.round(g.R * Math.cos(a)) + 'px');
      el.style.setProperty('--dy', Math.round(-g.R * Math.sin(a)) + 'px');
      el.style.setProperty('--sc', (HX_EDGE_SCALE + (1 - HX_EDGE_SCALE) * edge).toFixed(3));
      el.style.visibility = edge < 0.02 ? 'hidden' : '';
      el.style.pointerEvents = edge < 0.35 ? 'none' : '';
    });
  }

  function _render(h) {
    var btns = (h.buttons || []).filter(function (b) { return b && (b.action || b.fn); }).slice(0, HX_MAX_BTNS);
    var n = btns.length;
    _ring.innerHTML = '';
    _els = [];
    _slots = Math.min(n, HX_VISIBLE);
    _maxOff = Math.max(0, n - HX_VISIBLE);
    if (_offFor !== h.panel_id) { _off = 0; _offFor = h.panel_id; }   // new hexagon starts from the beginning
    _off = _clamp(Math.round(_off), 0, _maxOff);
    btns.forEach(function (btn, i) {
      var el = document.createElement('button'); el.className = 'hx'; el._i = i;
      el.innerHTML = (btn.sec ? HX_SVG_SEC : (btn.mark === 'copy' ? HX_SVG_COPY : HX_SVG)) + '<span class="hx-in"></span>';
      if (btn.mark === 'cut') el.classList.add('cut');
      var inner = el.querySelector('.hx-in');
      var act = (btn.action || '').trim();
      // icon (emoji) is optional; without it the hex shows the first letter of the command
      inner.textContent = (btn.icon && btn.icon.trim()) || _firstGlyph(act.replace(/^\/+/, '')) || '•';
      var tt = btn.label || act; el.title = tt; el.setAttribute('aria-label', tt);
      if (btn.longFn) {   // long-tap on a ring hex (no movement, not a scroll) — nav mode: section -> rename / delete ring
        var hT = null, hXY = null;
        var hClr = function () { if (hT) { clearTimeout(hT); hT = null; } };
        el.addEventListener('pointerdown', function (e) {
          el._long = false; hClr(); hXY = { x: e.clientX, y: e.clientY };
          hT = setTimeout(function () {
            hT = null;
            if (_drag && _drag.moved) return;
            el._long = true;
            try { if (navigator.vibrate) navigator.vibrate(12); } catch (x) {}
            btn.longFn(el);
          }, HX_HOLD_MS);
        });
        el.addEventListener('pointermove', function (e) { if (hT && hXY && Math.hypot(e.clientX - hXY.x, e.clientY - hXY.y) > 8) hClr(); });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { el.addEventListener(ev, hClr); });
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      }
      el.onclick = function () {
        if (el._long) { el._long = false; return; }   // the click that ends a long-tap is not a press
        if (_wasDrag) { _wasDrag = false; return; }   // the click that ends a scroll is not a press
        if (btn.fn) { btn.fn(el); if (!btn.keepOpen) _setOpen(false); return; }   // nav mode: local handler (commands inside still go through _panelPress)
        // same execution path as a panel button; tier is re-checked inside tmRun/runMacro
        if (typeof _panelPress === 'function') _panelPress(btn, el);
        _setOpen(false);
      };
      _ring.appendChild(el);
      _els.push(el);
    });
    _place(_off);
    _centerAction = (h.config && h.config.center && h.config.center.action) || '';
    _centerFn = h._centerFn || null;
    _centerTapFn = h._centerTapFn || null;
    _fab.innerHTML = HX_SVG + '<span class="hx-in"></span>';
    var holder = _fab.querySelector('.hx-in');
    var cIcon = _firstGlyph(h.config && h.config.center && h.config.center.icon);   // per-hexagon emoji
    if (cIcon) holder.textContent = cIcon;
    else {                                                                           // default: the logo
      var img = new Image(); img.alt = ''; img.draggable = false;
      img.onerror = function () { holder.textContent = '⬡'; };   // logo missing: plain glyph
      img.src = HX_CENTER_IMG;
      holder.appendChild(img);
    }
  }

  // ── linear scroll inside the radius: x and y both count — finger down or left = later hexes,
  //    up or right = earlier ones (hexes follow the finger along the arc); snaps to a slot ──
  function _onDown(e) {
    if (!_open || _maxOff <= 0) return;
    _drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, off0: _off, moved: false };
    _wasDrag = false;
  }
  function _onMove(e) {
    if (!_drag || e.pointerId !== _drag.id) return;
    var dy = (e.clientY - _drag.y0) - (e.clientX - _drag.x0);   // along-the-arc component: y and x together
    if (!_drag.moved) {
      if (Math.abs(dy) < HX_DEAD_PX) return;
      _drag.moved = true; _wasDrag = true;
      try { _root.setPointerCapture(e.pointerId); } catch (x) {}
      _root.classList.add('drag');
    }
    var eff = dy - (dy > 0 ? HX_DEAD_PX : -HX_DEAD_PX);
    _off = _clamp(_drag.off0 + eff / HX_SLOT_PX, 0, _maxOff);
    _place(_off);
  }
  function _onUp(e) {
    if (!_drag || e.pointerId !== _drag.id) return;
    var moved = _drag.moved;
    _drag = null;
    if (moved) {
      _off = _clamp(Math.round(_off), 0, _maxOff);
      _root.classList.remove('drag');
      _place(_off);
    }
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
    if (want && _loadedFor !== uid && _loadSnap()) _loadedFor = uid;   // show the offline copy immediately
    if (want && !_loading && _syncedFor !== uid) {                      // ...and refresh from the network in the background
      _loading = true; _syncedFor = uid;
      var done = function () { _loading = false; };
      hexagonsLoad().then(done, done);
    }
    var h = want ? _active() : null;
    if (!h) { if (_root) { _root.style.display = 'none'; _setOpen(false); } _sig = ''; return; }
    _build();
    var nav = _navOn();
    if (nav && !_open) _setOpen(true);
    var sig = h.panel_id + '|' + (h.updated_at || '') + '|' + _baseW + 'x' + _baseH + (nav ? '|nav:' + _navSig() : '');
    if (sig !== _sig) { _sig = sig; _render(nav ? _navVirtual(h) : h); }
    var hide = _hiddenNow();
    _root.style.display = hide ? 'none' : 'block';
    if (hide) _setOpen(false);
  }

  function _refresh(openRing) {
    _sig = ''; _tick();
    if (openRing && _root && _root.style.display !== 'none') _setOpen(true);
  }

  // ── editor window (reuses the panel window shell): name + rows of [emoji (optional)] [command] ──
  function hexagonEdit(h, presetTitle) {
    var isNew = !h;
    var work = h ? JSON.parse(JSON.stringify(h)) : { title: presetTitle || '', buttons: [] };
    var rows = (work.buttons || []).slice(0, HX_MAX_BTNS).map(function (b) {
      return { id: b.id || ('b' + Math.random().toString(36).slice(2, 8)), icon: b.icon || '', action: b.action || '' };
    });
    var body = _panelShell(isNew ? 'ახალი ჰექსაგონი' : 'ჰექსაგონის რედაქტირება');
    var msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-size:12px;margin:0 0 4px;min-height:14px;color:#f85149;'; body.appendChild(msgEl);

    var inTitle = document.createElement('input'); inTitle.style.cssText = _PANEL_IN_CSS + 'margin:0;'; inTitle.placeholder = 'სახელი'; inTitle.value = work.title || '';
    // centre-hex emoji of this hexagon (optional; empty = the logo)
    var inCenter = document.createElement('input'); inCenter.style.cssText = _PANEL_IN_CSS + 'width:44px;flex:none;text-align:center;margin:0;';
    inCenter.placeholder = '🙂'; inCenter.value = (work.config && work.config.center && work.config.center.icon) || '';
    var titleLine = document.createElement('div'); titleLine.style.cssText = 'display:flex;gap:4px;margin:0 0 3px;';
    titleLine.appendChild(inCenter); titleLine.appendChild(inTitle);
    body.appendChild(titleLine);
    // command run by a long-tap on the centre hex (optional)
    var holdAction = (work.config && work.config.center && work.config.center.action) || '';
    var inHold = document.createElement('input'); inHold.style.cssText = _PANEL_IN_CSS + 'margin:0 0 3px;';
    inHold.placeholder = 'ცენტრი, ლონგ ტაპი: /ბრძანება'; inHold.value = holdAction;
    var holdNote = document.createElement('div'); holdNote.style.cssText = 'font-size:11px;display:none;margin:0 0 3px;';
    function _note2(el, color, text) { el.style.color = color; el.textContent = text || ''; el.style.display = text ? 'block' : 'none'; }
    function validateHold() {
      if (!inHold.value.trim()) { _note2(holdNote, '', ''); return true; }
      var res = _panelCheckAction(inHold.value);
      if (res.ok) { holdAction = res.action; _note2(holdNote, '#d29922', res.warn || ''); }
      else { _note2(holdNote, '#f85149', res.msg); }
      return res.ok;
    }
    inHold.onchange = validateHold;
    body.appendChild(inHold); body.appendChild(holdNote);
    if (holdAction) validateHold();
    var listEl = document.createElement('div'); body.appendChild(listEl);

    function drawRows() {
      listEl.innerHTML = '';
      rows.forEach(function (r, idx) {
        var wrap = document.createElement('div'); wrap.style.cssText = 'margin:0 0 3px;';
        var line = document.createElement('div'); line.style.cssText = 'display:flex;gap:4px;';
        var ic = document.createElement('input'); ic.style.cssText = _PANEL_IN_CSS + 'width:44px;flex:none;text-align:center;margin:0;'; ic.placeholder = '🙂'; ic.value = r.icon;
        ic.oninput = function () { r.icon = ic.value; };
        var ac = document.createElement('input'); ac.style.cssText = _PANEL_IN_CSS + 'margin:0;'; ac.placeholder = '/ბრძანება  ან  მაკროს სახელი'; ac.value = r.action;
        var note = document.createElement('div'); note.style.cssText = 'font-size:11px;display:none;';
        function validate() {
          var res = _panelCheckAction(ac.value);
          if (res.ok) { r.action = res.action; _note2(note, '#d29922', res.warn || ''); }
          else { r.action = ac.value; _note2(note, '#f85149', res.msg); }
          return res.ok;
        }
        ac.oninput = function () { r.action = ac.value; };
        ac.onchange = validate;
        var del = _panelBtnEl(_PANEL_BTN_CSS + 'width:15px;flex:none;margin:0;min-height:0;padding:0;', '✕', function () { rows.splice(idx, 1); drawRows(); });
        // move this row one position up (to move a row down, press ↑ on the row below it)
        var up = _panelBtnEl(_PANEL_BTN_CSS + 'width:16px;flex:none;margin:0;min-height:0;padding:0;', '↑', function () {
          if (idx < 1) return;
          var t = rows[idx]; rows[idx] = rows[idx - 1]; rows[idx - 1] = t; drawRows();
        });
        if (idx === 0) up.style.opacity = '0.35';
        line.appendChild(ic); line.appendChild(ac); line.appendChild(up); line.appendChild(del);
        wrap.appendChild(line); wrap.appendChild(note);
        listEl.appendChild(wrap);
        if (r.action) validate();
      });
      _panelFit();
    }
    drawRows();

    body.appendChild(_panelBtnEl(_PANEL_BTN_CSS, '+', function () {
      if (rows.length >= HX_MAX_BTNS) { msgEl.style.color = '#f85149'; msgEl.textContent = 'მაქსიმუმ ' + HX_MAX_BTNS + ' ღილაკი'; return; }
      rows.push({ id: 'b' + Math.random().toString(36).slice(2, 8), icon: '', action: '' });
      drawRows();
    }));

    var save;
    async function doSave() {
      msgEl.style.color = '#f85149';
      var title = inTitle.value.trim();
      if (!title) { msgEl.textContent = 'სახელი სავალდებულოა'; return; }
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r.action.trim() && !r.icon.trim()) continue;   // blank row: ignored
        var res = _panelCheckAction(r.action);              // re-validate: tier/macros may have changed since typing
        if (!res.ok) { msgEl.textContent = 'ღილაკი №' + (i + 1) + ': ' + res.msg; return; }
        out.push({ id: r.id, type: 'cmd', icon: r.icon.trim(), action: res.action });
      }
      var cfg = {}, center = {};
      var cIco = _firstGlyph(inCenter.value);
      if (cIco) center.icon = cIco;
      if (inHold.value.trim()) {
        var hres = _panelCheckAction(inHold.value);
        if (!hres.ok) { msgEl.textContent = 'ცენტრი, ლონგ ტაპი: ' + hres.msg; return; }
        center.action = hres.action;
      }
      if (center.icon || center.action) cfg.center = center;
      var payload = { panel_id: work.panel_id, title: title, title_en: null, icon: null, buttons: out, config: cfg };
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
  //   ნავ [ჩართვა|გამორთვა]       nav mode on/off (toggle without argument): the ring shows the menu tree
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

    if (sub === 'ნავ' || sub === 'ნავიგაცია') {
      var narg = (args[1] || '').trim();
      var nwant = narg === 'გამორთვა' ? false : (narg === 'ჩართვა' ? true : !_navOn());
      if (nwant && !(st.on && st.id && _active())) { _tmL('ter', '✗ ჯერ ჩართე ჰექსაგონი: /ჰექსაგონი <სახელი>'); return; }
      _navSet(nwant); _navReset(); _navBuf = null;
      closeTerm(); _refresh(nwant); if (!nwant) _setOpen(false);
      _tmL('tok', nwant ? '✓ ნავიგაცია ჩართულია (გასართავად: /ჰექსაგონი ნავ)' : '✓ ნავიგაცია გამორთულია');
      return;
    }
    var isEdit = sub === 'რედ', isDel = sub === 'წაშ';
    var rest = (isEdit || isDel) ? args.slice(1) : args.slice(0);
    var confirmed = false;
    if (isDel && rest.length && rest[rest.length - 1] === 'დიახ') { confirmed = true; rest = rest.slice(0, -1); }
    var q = rest.join(' ').trim();
    if (!q) { _tmL('ter', 'გამოყენება: /ჰექსაგონი [სახელი|№] · ახალი [სახელი] · რედ <სახელი|№> · წაშ <სახელი|№> დიახ · გამორთვა · ნავ'); return; }
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
