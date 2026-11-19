// hud.js — HUD: small transparent progress bars under the burger button (caretaker+).
// Named HUDs — local (this device) via /ჰუდი, shared (table huds) via /საერთოჰუდი. Shared: seen by caretaker+, edited by resident+.
// Loaded after runtime.js and terminal.js (see viewer.html). No ES modules: public API is on window.
(function () {
  'use strict';

  var MAX_PER_GROUP = 6;       // rows shown per category; any further bars are simply not shown
  var MIN_TIER = 'caretaker';  // HUD is hidden for everyone below this tier
  var MAX_HUDS = 20, MAX_ITEMS = 30, MAX_NAME = 60;
  var RESERVED = ['გამორთვა', 'წაშ', 'დიახ'];   // sub-commands / confirm word: never HUD names

  var _el = null;

  // ── bar abstraction: HUD never looks at item types itself ──
  // Returns null if the item cannot be shown as a bar, else
  // { id, label, emoji, value (0..100), derived, kind: 'resource' | 'mission' }.
  // kind is automatic: a todo without children (slider) is a resource, a todo with children (checklist) is a mission.
  function _barOf(item) {
    if (!item || typeof item !== 'object') return null;
    var i18n = typeof window._i18n === 'function' ? window._i18n : function (x) { return x == null ? '' : (typeof x === 'string' ? x : (x.ka || x.en || '')); };
    if (item.type !== 'todo' && item.type !== 'progress') return null;   // 'progress' = legacy indicator, read like a slider
    if (item.children && item.children.length) {
      // checklist = mission: value = checked leaves / all leaves (runtime.js todo state)
      if (typeof window.menuTodoCount !== 'function') return null;
      var c = window.menuTodoCount(item);
      var v = c.total > 0 ? Math.round(c.done / c.total * 100) : 0;
      return { id: item.id, label: i18n(item.label), emoji: item.emoji || '📋', value: _clamp(v), derived: true, kind: 'mission' };
    }
    // no children = slider = resource: live value from runtime.js (falls back to the stored value)
    var sv = typeof window.menuSliderValue === 'function' ? window.menuSliderValue(item) : item.value;
    return { id: item.id, label: i18n(item.label), emoji: item.emoji || '📊', value: _clamp(sv), derived: false, kind: 'resource' };
  }

  function _clamp(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
  function _color(v) { return v > 60 ? '#4ade80' : v > 30 ? '#facc15' : '#f87171'; }

  // ── HUD storage: local (this device only), per user + map ──
  // { active: name | null, huds: [ { name, items: [leaf id, ...] } ] }
  // Items are stored as leaf ids and resolved from the live menu tree on every refresh, so renames/moves never
  // break a HUD. Ids that are not found are skipped but never pruned automatically (the menu may not be loaded yet).
  var _state = null, _stateKey = null;

  function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function _txt(x) {
    if (typeof window._i18n === 'function') return window._i18n(x);
    return typeof x === 'string' ? x : (x && (x.ka || x.en)) || '';
  }
  function _key() {
    var uid = typeof window.myUserId === 'function' ? window.myUserId() : null;
    return 'mdelo_huds_' + (uid || 'anon') + '_' + ((window._CFG && window._CFG.title) || '');
  }
  function _load(key) {
    var st = { active: null, activeShared: null, huds: [] };
    try {
      var o = JSON.parse(window.localStorage.getItem(key) || 'null');
      var seen = {};
      ((o && Array.isArray(o.huds)) ? o.huds : []).forEach(function (h) {
        if (!h || typeof h.name !== 'string' || !h.name || seen[_norm(h.name)]) return;
        seen[_norm(h.name)] = true;
        st.huds.push({ name: h.name, items: Array.isArray(h.items) ? h.items.filter(function (x) { return typeof x === 'string' && x; }) : [] });
      });
      if (o && typeof o.active === 'string' && seen[_norm(o.active)]) st.active = o.active;
      else if (o && typeof o.activeShared === 'string' && o.activeShared) st.activeShared = o.activeShared;   // validated against the shared list once it is loaded
    } catch (e) {}
    return st;
  }
  function _save() { try { window.localStorage.setItem(_stateKey, JSON.stringify(_state)); } catch (e) {} }
  // the key depends on the logged-in user, which is only known after auth boot — so (re)load lazily
  function _ensureState() {
    var k = _key();
    if (!_state || k !== _stateKey) { _state = _load(k); _stateKey = k; }
    return _state;
  }
  function _indexIn(list, name) {
    var q = _norm(name);
    for (var i = 0; i < list.length; i++) if (_norm(list[i].name) === q) return i;
    return -1;
  }
  function _activeIndex(st) { return st.active ? _indexIn(st.huds, st.active) : -1; }

  // id -> item for every leaf item in the live menu tree (one walk per refresh)
  function _indexItems() {
    var map = {};
    (function walk(nodes, depth) {
      if (!Array.isArray(nodes) || depth > 30) return;
      nodes.forEach(function (n) {
        if (!n) return;
        if (Array.isArray(n.items)) n.items.forEach(function (it) { if (it && typeof it === 'object' && it.id) map[it.id] = it; });
        walk(n.children, depth + 1);
      });
    })(window._CFG && window._CFG.menu, 0);
    return map;
  }

  // ── shared HUDs (Supabase table huds; SQL: huds-migration.sql) ──
  // Everyone caretaker+ sees them (/ჰუდი <სახელი> switches one on); only resident+ edits (/საერთოჰუდი).
  // Same model as area_overrides: public read/insert/update, soft delete, tier is enforced by the UI only.
  // Editing needs a connection (like panels); reading falls back to the offline snapshot.
  var _shared = { list: [] };   // [ { id, name, items } ]

  function _supa() { return (typeof SUPA_URL === 'string' && typeof SUPA_KEY === 'string') ? { url: SUPA_URL, key: SUPA_KEY } : null; }
  function _mapId() { return typeof _MAP_ID === 'string' ? _MAP_ID : ((window._CFG && window._CFG.title) || 'map'); }
  function _newHudId() { return 'hud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

  function _applyShared(rows) {
    var list = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || r.deleted || typeof r.hud_id !== 'string' || typeof r.name !== 'string' || !r.name) return;
      list.push({ id: r.hud_id, name: r.name, items: Array.isArray(r.items) ? r.items.filter(function (x) { return typeof x === 'string' && x; }) : [] });
    });
    list.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });   // ids start with a timestamp = creation order
    _shared.list = list;
  }
  function _snapSaveShared() {
    if (typeof _syncSnapSave !== 'function') return;
    _syncSnapSave('huds', _shared.list.map(function (h) { return { hud_id: h.id, name: h.name, items: h.items, deleted: false }; }));
  }
  function _sharedActiveIndex(st) {
    if (!st.activeShared) return -1;
    for (var i = 0; i < _shared.list.length; i++) if (_shared.list[i].id === st.activeShared) return i;
    return -1;
  }

  // load (caretaker+ only); called by runtime.js at boot. Never throws.
  async function hudLoadShared() {
    if (!_allowed()) return;
    var restore = function () { if (typeof _syncSnapRestore === 'function') _syncSnapRestore('huds', _applyShared); };
    var sp = _supa();
    if (!sp) { restore(); hudRefresh(); return; }
    try {
      var r = await fetch(sp.url + '/rest/v1/huds?map_id=eq.' + encodeURIComponent(_mapId()) + '&deleted=eq.false&order=hud_id.asc',
        { headers: { 'apikey': sp.key, 'Authorization': 'Bearer ' + sp.key } });
      if (!r.ok) restore();
      else {
        var rows = await r.json();
        _applyShared(rows);
        if (typeof _syncSnapSave === 'function') _syncSnapSave('huds', rows);
      }
    } catch (e) { restore(); }
    hudRefresh();
  }

  // one upsert covers create / edit / soft delete (all columns always present). true | { error }
  async function _sharedUpsert(h, deleted) {
    var sp = _supa();
    if (!sp) return { error: 'კავშირი ვერ მოიძებნა' };
    var row = { map_id: _mapId(), hud_id: h.id, name: h.name, items: h.items, deleted: !!deleted, updated_at: new Date().toISOString() };
    try {
      var hdr = typeof _authHeaders === 'function' ? _authHeaders() : { 'apikey': sp.key, 'Authorization': 'Bearer ' + sp.key };
      var r = await fetch(sp.url + '/rest/v1/huds', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }, hdr),
        body: JSON.stringify([row])
      });
      if (r.ok) return true;
      var body = r.text ? await r.text().catch(function () { return ''; }) : '';
      return { error: 'სერვერმა უარყო (' + r.status + ') ' + body.slice(0, 120) };
    } catch (e) { return { error: 'ქსელი მიუწვდომელია — საერთო HUD ოფლაინ ვერ შეიცვლება' }; }
  }

  // ── stores: the commands below work on a "store" so local and shared HUDs share one implementation ──
  // list() / activeIdx() / activate(i) / create(name) / setItems(h, items) / remove(h); async ones return true | { error }
  function _localStore() {
    var st = _ensureState();
    return {
      shared: false,
      list: function () { return st.huds; },
      activeIdx: function () { return _activeIndex(st); },
      activate: function (i) { st.active = st.huds[i].name; st.activeShared = null; _save(); },
      create: async function (name) { st.huds.push({ name: name, items: [] }); st.active = name; st.activeShared = null; _save(); return true; },
      setItems: async function (h, items) { h.items = items; _save(); return true; },
      remove: async function (h) {
        st.huds.splice(st.huds.indexOf(h), 1);
        if (st.active && _norm(st.active) === _norm(h.name)) st.active = null;
        _save(); return true;
      }
    };
  }
  function _sharedStore() {
    var st = _ensureState();
    return {
      shared: true,
      list: function () { return _shared.list; },
      activeIdx: function () { return _sharedActiveIndex(st); },
      activate: function (i) { st.activeShared = _shared.list[i].id; st.active = null; _save(); },
      create: async function (name) {
        var h = { id: _newHudId(), name: name, items: [] };
        var r = await _sharedUpsert(h, false);
        if (r !== true) return r;
        _shared.list.push(h); st.activeShared = h.id; st.active = null; _save(); _snapSaveShared();
        return true;
      },
      setItems: async function (h, items) {
        var r = await _sharedUpsert({ id: h.id, name: h.name, items: items }, false);
        if (r !== true) return r;
        h.items = items; _snapSaveShared();
        return true;
      },
      remove: async function (h) {
        var r = await _sharedUpsert(h, true);
        if (r !== true) return r;
        _shared.list.splice(_shared.list.indexOf(h), 1);
        if (st.activeShared === h.id) st.activeShared = null;
        _save(); _snapSaveShared();
        return true;
      }
    };
  }

  // what to show right now: { name (HUD name), bars }
  function _collect() {
    var st = _ensureState(), h = null, i;
    if (st.activeShared) { i = _sharedActiveIndex(st); if (i >= 0) h = _shared.list[i]; }
    else { i = _activeIndex(st); if (i >= 0) h = st.huds[i]; }
    if (!h) return { name: '', bars: [] };
    var map = _indexItems(), bars = [];
    h.items.forEach(function (id) { var b = _barOf(map[id]); if (b) bars.push(b); });
    return { name: h.name, bars: bars };
  }

  function _allowed() {
    return typeof window._tierAtLeast === 'function' && window._tierAtLeast(MIN_TIER);
  }

  // ── DOM (injected here: index.html is regenerated by the editor export) ──
  function _ensureDom() {
    if (!document.getElementById('gmHudStyles')) {
      var st = document.createElement('style');
      st.id = 'gmHudStyles';
      st.textContent =
        '#gmHud{position:fixed;top:54px;right:5px;z-index:25;pointer-events:none;display:none;flex-direction:column;gap:3px;' +
        'width:85px;box-sizing:border-box;font:10px/1 sans-serif;color:rgba(200,210,220,.9);' +
        'text-shadow:0 0 3px rgba(0,0,0,.9),0 0 1px rgba(0,0,0,.9);}' +
        '#gmHud.show{display:flex;}' +
        '.gmh-row{display:flex;align-items:center;gap:5px;height:14px;}' +
        '.gmh-ic{position:relative;width:14px;text-align:center;font-size:11px;flex-shrink:0;pointer-events:auto;cursor:pointer;}' +
        '.gmh-ic::after{content:"";position:absolute;left:-6px;right:-6px;top:-3px;bottom:-3px;}' +
        '.gmh-bar{position:relative;flex:1;height:9px;border-radius:3px;background:rgba(0,0,0,.45);overflow:hidden;}' +
        '.gmh-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;opacity:.65;}' +
        '.gmh-pct{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:flex-end;padding-right:3px;' +
        'font-size:9px;line-height:1;color:rgba(200,210,220,.95);}' +
        '.gmh-head{height:10px;line-height:10px;font-size:8px;letter-spacing:.3px;text-align:right;white-space:nowrap;' +
        'overflow:hidden;text-overflow:ellipsis;opacity:.75;margin-top:4px;' +
        'text-shadow:0 0 3px #000,0 0 3px #000,0 0 2px #000,0 0 1px #000;}' +
        '.gmh-head:first-child{margin-top:0;}';
      document.head.appendChild(st);
    }
    if (!_el || !document.body.contains(_el)) {
      _el = document.createElement('div');
      _el.id = 'gmHud';
      _el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(_el);
    }
    return _el;
  }

  function _row(b) {
    var row = document.createElement('div'); row.className = 'gmh-row';
    var ic = document.createElement('span'); ic.className = 'gmh-ic'; ic.textContent = b.emoji;
    // tap the emoji = open this item in the menu (checklist -> its list, slider -> its slider)
    ic.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); if (b.id && typeof window.menuOpenItem === 'function') window.menuOpenItem(b.id); });
    var bar = document.createElement('div'); bar.className = 'gmh-bar';
    var fill = document.createElement('div'); fill.className = 'gmh-fill';
    fill.style.width = b.value + '%'; fill.style.background = _color(b.value);
    var pct = document.createElement('span'); pct.className = 'gmh-pct'; pct.textContent = b.value + '%';
    bar.appendChild(fill); bar.appendChild(pct);   // number sits inside the bar, above the fill
    row.appendChild(ic); row.appendChild(bar);
    return row;
  }

  // single refresh entry point — safe to call at any time, any number of times
  function hudRefresh() {
    var cur = _collect();
    var bars = cur.bars;
    if (!bars.length || !_allowed()) { if (_el) _el.classList.remove('show'); return; }
    var el = _ensureDom();
    while (el.firstChild) el.removeChild(el.firstChild);
    var i18n = typeof window._i18n === 'function' ? window._i18n : function (x) { return x.ka; };
    // two categories, sorted automatically by bar kind: missions (todo) first, then resources (indicators).
    // The first header is always the HUD's own name; "რესურსები" is only a separate header when both groups exist.
    var missions  = bars.filter(function (b) { return b.kind === 'mission'; });
    var resources = bars.filter(function (b) { return b.kind === 'resource'; });
    var nameTitle = cur.name || (missions.length ? { ka: 'მისია', en: 'Missions' } : { ka: 'რესურსები', en: 'Resources' });
    var groups = [];
    if (missions.length)  groups.push({ title: nameTitle, list: missions });
    if (resources.length) groups.push({ title: missions.length ? { ka: 'რესურსები', en: 'Resources' } : nameTitle, list: resources });
    groups.forEach(function (g) {
      var head = document.createElement('div'); head.className = 'gmh-head'; head.textContent = typeof g.title === 'string' ? g.title : i18n(g.title);
      el.appendChild(head);
      g.list.slice(0, MAX_PER_GROUP).forEach(function (b) { el.appendChild(_row(b)); });
    });
    el.classList.add('show');
  }

  // ── /ჰუდი (local + view of shared) and /საერთოჰუდი (shared, resident+) ──
  // say(kind, text) = terminal logger (_tmL); ctx = { cwd, resolve, saveNode } from terminal.js (current menu node,
  // _tmResolveItem, _tmMenuSaveNode). Kinds: tok = ok, ter = error, tdm = hint, tnf = info line.
  // Numbers: "N" = local list, "სN" = shared list (in /საერთოჰუდი plain "N" also means the shared list).
  function _nameError(name) {
    if (!name) return 'გამოყენება: /ჰუდი <სახელი>';
    if (name.length > MAX_NAME) return '✗ სახელი ძალიან გრძელია (მაქს. ' + MAX_NAME + ')';
    if (/^[+\u2212\-\u2013]/.test(name)) return '✗ სახელი ვერ დაიწყება + ან − ნიშნით (ბარის დამატება: /ჰუდი + <სახელი|id|ინდექსი>)';
    if (RESERVED.indexOf(name) >= 0) return '✗ „' + name + '“ დაცული სიტყვაა — აირჩიე სხვა სახელი';
    return null;
  }
  function _itemLabel(it) { var b = _barOf(it); return b ? (b.emoji + ' ' + (b.label || '(უსახელო)')) : null; }
  function _parseNum(tok) { var m = /^(ს)?(\d+)$/.exec(tok); return m ? { shared: !!m[1], n: parseInt(m[2], 10) } : null; }
  function _cmdName(store) { return store && store.shared ? '/საერთოჰუდი' : '/ჰუდი'; }
  function _noActiveMsg(store, st) {
    if (store.shared) return '✗ ჯერ აირჩიე საერთო HUD: /საერთოჰუდი <სახელი>';
    return st.activeShared ? '✗ აქტიური HUD საერთოა — შესაცვლელად: /საერთოჰუდი + ... (ან აირჩიე ლოკალური: /ჰუდი <სახელი>)' : '✗ ჯერ აირჩიე HUD: /ჰუდი <სახელი>';
  }

  function _cmdList(say, sharedOnly) {
    var st = _ensureState(), sl = _shared.list;
    if (!sharedOnly) {
      if (!st.huds.length && !sl.length) { say('tdm', 'HUD ჯერ არ არის — შესაქმნელად: /ჰუდი <სახელი> დიახ'); return; }
      if (st.huds.length) {
        say('tdm', 'ლოკალური HUD-ები (ამ მოწყობილობაზე):');
        var ai = _activeIndex(st);
        st.huds.forEach(function (h, i) { say('tnf', (i === ai ? '▶ ' : '  ') + '[' + i + '] ' + h.name + ' — ' + h.items.length + ' ბარი'); });
      }
    }
    if (sl.length) {
      say('tdm', 'საერთო HUD-ები:');
      var si = _sharedActiveIndex(st);
      sl.forEach(function (h, i) { say('tnf', (i === si ? '▶ ' : '  ') + '[ს' + i + '] ' + h.name + ' — ' + h.items.length + ' ბარი'); });
    } else if (sharedOnly) {
      say('tdm', 'საერთო HUD ჯერ არ არის — შესაქმნელად: /საერთოჰუდი <სახელი> დიახ');
    }
  }

  function _activate(store, idx, say) {
    store.activate(idx); hudRefresh();
    var h = store.list()[idx];
    say('tok', '✓ HUD „' + h.name + '“ ჩაირთო (' + (store.shared ? 'საერთო, ' : '') + h.items.length + ' ბარი)');
  }

  // <სახელი | N | სN> [დიახ] — switch on (the previous HUD switches off); an unknown name needs "დიახ" to be created
  // store = the shared store for /საერთოჰუდი (look up + create there only), null for /ჰუდი (local first, then shared; creates local)
  async function _cmdSelect(args, say, store) {
    var parts = args.slice(), confirm = false;
    if (parts.length > 1 && parts[parts.length - 1] === 'დიახ') { confirm = true; parts.pop(); }
    var name = parts.join(' ').trim();
    var loc = _localStore(), sh = _sharedStore(), cmd = _cmdName(store);
    var num = _parseNum(name);
    if (num) {
      var target = (num.shared || (store && store.shared)) ? sh : loc, list = target.list();
      if (num.n < list.length) _activate(target, num.n, say);
      else say('ter', '✗ HUD [' + (target.shared ? 'ს' : '') + num.n + '] არ არსებობს — ' + cmd);
      return;
    }
    var err = _nameError(name);
    if (err) { say('ter', err); return; }
    var order = (store && store.shared) ? [sh] : [loc, sh];
    for (var k = 0; k < order.length; k++) {
      var i = _indexIn(order[k].list(), name);
      if (i >= 0) { _activate(order[k], i, say); return; }
    }
    var cstore = store || loc;
    if (!confirm) { say('tdm', 'HUD „' + name + '“ არ არსებობს — შესაქმნელად: ' + cmd + ' ' + name + ' დიახ'); return; }
    if (cstore.list().length >= MAX_HUDS) { say('ter', '✗ HUD-ების ლიმიტი: ' + MAX_HUDS); return; }
    var r = await cstore.create(name);
    if (r !== true) { say('ter', '✗ ' + r.error); return; }
    hudRefresh();
    say('tok', '✓ HUD „' + name + '“ შეიქმნა და ჩაირთო' + (cstore.shared ? ' (საერთო)' : ''));
    say('tdm', 'ბარის დასამატებლად გადადი სექციაში (/cd) და: ' + cmd + ' + <სახელი|id|ინდექსი>');
    if (cstore.shared && _indexIn(loc.list(), name) >= 0) say('tdm', '⚠ ამავე სახელის ლოკალური HUD ამ მოწყობილობაზე /ჰუდი <სახელი>-ზე უპირატესობს');
  }

  // + <ref> — add an indicator or a todo of the CURRENT menu section to the active HUD of this store
  async function _cmdAdd(ref, say, ctx, store) {
    var st = _ensureState(), hi = store.activeIdx();
    if (hi < 0) { say('ter', _noActiveMsg(store, st)); return; }
    if (!ref.trim()) { say('ter', 'გამოყენება: ' + _cmdName(store) + ' + <სახელი | id | ინდექსი> (მიმდინარე სექციიდან)'); return; }
    var node = ctx && ctx.cwd ? ctx.cwd() : null;
    if (!node) { say('ter', '✗ root-ში ფოთლები არ არსებობს — გადადი სექციაში (/cd)'); return; }
    var rr = ctx.resolve(node, ref, null);
    if (rr.error) { say('ter', '✗ ' + rr.error); return; }
    var item = node.items[rr.idx];
    if (!item || typeof item !== 'object' || (item.type !== 'progress' && item.type !== 'todo')) {
      say('ter', '✗ ბარი შეიძლება იყოს მხოლოდ ინდიკატორი ან todo'); return;
    }
    // old items may have no id yet: any node save stamps ids on all its items (same mechanism as every menu edit)
    if (!item.id) { await ctx.saveNode(node.id, { items_json: node.items }); }
    if (!item.id) { say('ter', '✗ id ვერ მიენიჭა — სცადე ისევ'); return; }
    var h = store.list()[hi];
    if (h.items.indexOf(item.id) >= 0) { say('tdm', 'უკვე არის HUD „' + h.name + '“-ში'); return; }
    if (h.items.length >= MAX_ITEMS) { say('ter', '✗ HUD-ში მაქს. ' + MAX_ITEMS + ' ბარია'); return; }
    var r = await store.setItems(h, h.items.concat([item.id]));
    if (r !== true) { say('ter', '✗ ' + r.error); return; }
    hudRefresh();
    say('tok', '✓ + ' + _itemLabel(item) + ' → HUD „' + h.name + '“ (' + h.items.length + ')');
  }

  // − [<N | სახელი | id>] — no argument: numbered list of the active HUD's bars
  async function _cmdRemove(ref, say, store) {
    var st = _ensureState(), hi = store.activeIdx();
    if (hi < 0) { say('ter', _noActiveMsg(store, st)); return; }
    var h = store.list()[hi], map = _indexItems(), cmd = _cmdName(store);
    if (!ref.trim()) {
      if (!h.items.length) { say('tdm', 'HUD „' + h.name + '“ ცარიელია'); return; }
      say('tdm', 'HUD „' + h.name + '“ — ბარები:');
      h.items.forEach(function (id, i) { say('tnf', '[' + i + '] ' + (_itemLabel(map[id]) || '(ვერ მოიძებნა: ' + id + ')')); });
      say('tdm', 'ამოსაღებად: ' + cmd + ' − <[N] | სახელი | id>');
      return;
    }
    var idx = -1;
    if (/^\d+$/.test(ref)) {
      var n = parseInt(ref, 10);
      if (n >= h.items.length) { say('ter', '✗ ბარი [' + n + '] არ არსებობს — ' + cmd + ' −'); return; }
      idx = n;
    } else {
      var q = _norm(ref), exact = [], pref = [];
      h.items.forEach(function (id, i) {
        if (id === ref) { exact.push(i); return; }
        var b = _barOf(map[id]); if (!b) return;
        var t = _norm(b.label);
        if (t === q) exact.push(i); else if (t.indexOf(q) === 0) pref.push(i);
      });
      var pick = exact.length ? exact : pref;
      if (pick.length > 1) {
        say('ter', '✗ რამდენიმე ბარი ემთხვევა „' + ref + '“: ' + pick.map(function (i) { return '[' + i + '] ' + (_itemLabel(map[h.items[i]]) || h.items[i]); }).join(', ') + ' — მიუთითე ინდექსი');
        return;
      }
      if (!pick.length) { say('ter', '✗ ბარი „' + ref + '“ HUD-ში ვერ მოიძებნა — ' + cmd + ' −'); return; }
      idx = pick[0];
    }
    var id0 = h.items[idx], lbl = _itemLabel(map[id0]) || id0;
    var items = h.items.slice(); items.splice(idx, 1);
    var r = await store.setItems(h, items);
    if (r !== true) { say('ter', '✗ ' + r.error); return; }
    hudRefresh();
    say('tok', '✗ − ' + lbl + ' ამოღებულია HUD „' + h.name + '“-დან');
  }

  // წაშ <სახელი | N | სN> დიახ — without "დიახ" only a preview
  async function _cmdDelete(rest, say, store) {
    var parts = rest.slice(), confirm = false, cmd = _cmdName(store);
    if (parts.length && parts[parts.length - 1] === 'დიახ') { confirm = true; parts.pop(); }
    var name = parts.join(' ').trim();
    if (!name) { say('ter', 'გამოყენება: ' + cmd + ' წაშ <სახელი | [N]> დიახ'); return; }
    var list = store.list(), num = _parseNum(name), idx;
    if (num) idx = (num.shared && !store.shared) ? -1 : num.n;   // "სN" only means something in the shared list
    else idx = _indexIn(list, name);
    if (idx < 0 || idx >= list.length) { say('ter', '✗ HUD „' + name + '“ ვერ მოიძებნა — ' + cmd); return; }
    var h = list[idx];
    if (!confirm) { say('tdm', 'HUD „' + h.name + '“ (' + h.items.length + ' ბარი) წაიშლება — დასადასტურებლად: ' + cmd + ' წაშ ' + h.name + ' დიახ'); return; }
    var r = await store.remove(h);
    if (r !== true) { say('ter', '✗ ' + r.error); return; }
    hudRefresh();
    say('tok', '✗ HUD „' + h.name + '“ წაიშალა');
  }

  function _isMinus(x) { return x === '\u2212' || x === '-' || x === '\u2013'; }

  async function hudCommand(args, say, ctx) {
    args = (args || []).map(String);
    var first = args[0] || '';
    if (!args.length) { _cmdList(say, false); return; }
    if (args.length === 1 && first === 'გამორთვა') {
      var st = _ensureState(); st.active = null; st.activeShared = null; _save();
      hudRefresh();
      say('tok', '✓ HUD გამოირთო');
      return;
    }
    if (first === '+') { await _cmdAdd(args.slice(1).join(' '), say, ctx, _localStore()); return; }
    if (_isMinus(first)) { await _cmdRemove(args.slice(1).join(' '), say, _localStore()); return; }
    if (first === 'წაშ') { await _cmdDelete(args.slice(1), say, _localStore()); return; }
    await _cmdSelect(args, say, null);
  }

  // /საერთოჰუდი — manage shared HUDs (resident+; the terminal tier table gates it, re-checked here)
  async function hudSharedCommand(args, say, ctx) {
    if (typeof window._tierAtLeast !== 'function' || !window._tierAtLeast('resident')) { say('ter', '✗ საერთო HUD-ის შეცვლა მხოლოდ resident+-ს შეუძლია'); return; }
    args = (args || []).map(String);
    var first = args[0] || '', sh = _sharedStore();
    if (!args.length) { _cmdList(say, true); return; }
    if (args.length === 1 && first === 'გამორთვა') { await hudCommand(args, say, ctx); return; }
    if (first === '+') { await _cmdAdd(args.slice(1).join(' '), say, ctx, sh); return; }
    if (_isMinus(first)) { await _cmdRemove(args.slice(1).join(' '), say, sh); return; }
    if (first === 'წაშ') { await _cmdDelete(args.slice(1), say, sh); return; }
    await _cmdSelect(args, say, sh);
  }

  window._hudBarOf = _barOf;
  window.hudRefresh = hudRefresh;
  window.hudCommand = hudCommand;
  window.hudSharedCommand = hudSharedCommand;
  window.hudLoadShared = hudLoadShared;
})();
