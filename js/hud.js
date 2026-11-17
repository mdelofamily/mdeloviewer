// hud.js — HUD: small transparent progress bars under the burger button (caretaker+).
// STEP B: named local HUDs (this device only) + /ჰუდი commands. Shared HUDs (/საერთოჰუდი) come in a later step.
// Loaded after runtime.js and terminal.js (see viewer.html). No ES modules: public API is on window.
(function () {
  'use strict';

  var MAX_PER_GROUP = 6;       // rows shown per category; any further bars are simply not shown
  var MIN_TIER = 'caretaker';  // HUD is hidden for everyone below this tier
  var MAX_HUDS = 20, MAX_ITEMS = 30, MAX_NAME = 60;
  var RESERVED = ['გამორთვა', 'ტესტი', 'წაშ', 'დიახ'];   // sub-commands / confirm word: never HUD names

  var _demoOn = false;
  var _el = null;

  // ── bar abstraction: HUD never looks at item types itself ──
  // Returns null if the item cannot be shown as a bar, else
  // { id, label, emoji, value (0..100), derived, kind: 'resource' | 'mission' }.
  // kind is automatic: indicator leaves are resources, todo leaves are missions.
  function _barOf(item) {
    if (!item || typeof item !== 'object') return null;
    var i18n = typeof window._i18n === 'function' ? window._i18n : function (x) { return x == null ? '' : (typeof x === 'string' ? x : (x.ka || x.en || '')); };
    if (item.type === 'progress') {
      return { id: item.id, label: i18n(item.label), emoji: item.emoji || '📊', value: _clamp(item.value), derived: false, kind: 'resource' };
    }
    if (item.type === 'todo') {
      // top-level todo title only; value = checked leaves / all leaves (runtime.js todo state)
      if (typeof window.menuTodoCount !== 'function') return null;
      var c = window.menuTodoCount(item);
      var v = c.total > 0 ? Math.round(c.done / c.total * 100) : 0;
      return { id: item.id, label: i18n(item.label), emoji: item.emoji || '📋', value: _clamp(v), derived: true, kind: 'mission' };
    }
    return null;
  }

  function _clamp(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
  function _color(v) { return v > 60 ? '#4ade80' : v > 30 ? '#facc15' : '#f87171'; }

  // temporary demo items (step A only) — they go through _barOf like real ones
  function _demoItems() {
    return [
      { type: 'progress', id: 'demo_1', emoji: '💧', label: { ka: 'წყალი', en: 'Water' }, value: 72 },
      { type: 'progress', id: 'demo_2', emoji: '🪵', label: { ka: 'შეშა', en: 'Firewood' }, value: 45 },
      { type: 'progress', id: 'demo_3', emoji: '🍞', label: { ka: 'საკვები', en: 'Food' }, value: 18 },
      { type: 'todo', id: 'demo_todo', label: { ka: 'ეზოს გასუფთავება', en: 'Yard cleanup' },
        children: [{ id: 'demo_t1', label: 'ტოტები', checked: true }, { id: 'demo_t2', label: 'ფოთლები', checked: false }, { id: 'demo_t3', label: 'ნაგავი', checked: false }] },
      { type: 'progress', id: 'demo_4', emoji: '🔥', label: 'ცეცხლი', value: 100 },
      { type: 'progress', id: 'demo_5', emoji: '🌾', label: 'მარცვალი', value: 5 },
      { type: 'todo', id: 'demo_todo2', label: 'სავსე მთვარისთვის მზადება', children: [{ id: 'demo_u1', label: 'ა', checked: false }, { id: 'demo_u2', label: 'ბ', checked: false }] }
    ];
  }

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
    var st = { active: null, huds: [] };
    try {
      var o = JSON.parse(window.localStorage.getItem(key) || 'null');
      var seen = {};
      ((o && Array.isArray(o.huds)) ? o.huds : []).forEach(function (h) {
        if (!h || typeof h.name !== 'string' || !h.name || seen[_norm(h.name)]) return;
        seen[_norm(h.name)] = true;
        st.huds.push({ name: h.name, items: Array.isArray(h.items) ? h.items.filter(function (x) { return typeof x === 'string' && x; }) : [] });
      });
      if (o && typeof o.active === 'string' && seen[_norm(o.active)]) st.active = o.active;
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
  function _hudIndex(st, name) {
    var q = _norm(name);
    for (var i = 0; i < st.huds.length; i++) if (_norm(st.huds[i].name) === q) return i;
    return -1;
  }
  function _activeIndex(st) { return st.active ? _hudIndex(st, st.active) : -1; }

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

  // what to show right now: { name (HUD name), bars }
  function _collect() {
    if (_demoOn) return { name: 'ზამთრის მარაგები', bars: _demoItems().map(_barOf).filter(Boolean) };
    var st = _ensureState(), i = _activeIndex(st);
    if (i < 0) return { name: '', bars: [] };
    var map = _indexItems(), bars = [];
    st.huds[i].items.forEach(function (id) { var b = _barOf(map[id]); if (b) bars.push(b); });
    return { name: st.huds[i].name, bars: bars };
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
        '.gmh-ic{width:14px;text-align:center;font-size:11px;flex-shrink:0;}' +
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

  // ── /ჰუდი ──
  // say(kind, text) = terminal logger (_tmL); ctx = { cwd, resolve, saveNode } from terminal.js (current menu node,
  // _tmResolveItem, _tmMenuSaveNode). Kinds: tok = ok, ter = error, tdm = hint, tnf = info line.
  function _nameError(name) {
    if (!name) return 'გამოყენება: /ჰუდი <სახელი>';
    if (name.length > MAX_NAME) return '✗ სახელი ძალიან გრძელია (მაქს. ' + MAX_NAME + ')';
    if (/^[+\u2212\-\u2013]/.test(name)) return '✗ სახელი ვერ დაიწყება + ან − ნიშნით (ბარის დამატება: /ჰუდი + <სახელი|id|ინდექსი>)';
    if (RESERVED.indexOf(name) >= 0) return '✗ „' + name + '“ დაცული სიტყვაა — აირჩიე სხვა სახელი';
    return null;
  }
  function _itemLabel(it) { var b = _barOf(it); return b ? (b.emoji + ' ' + (b.label || '(უსახელო)')) : null; }

  function _cmdList(say) {
    var st = _ensureState();
    if (!st.huds.length) { say('tdm', 'HUD ჯერ არ არის — შესაქმნელად: /ჰუდი <სახელი> დიახ'); return; }
    say('tdm', 'HUD-ები (ამ მოწყობილობაზე):');
    var ai = _activeIndex(st);
    st.huds.forEach(function (h, i) { say('tnf', (i === ai ? '▶ ' : '  ') + '[' + i + '] ' + h.name + ' — ' + h.items.length + ' ბარი'); });
  }

  function _activate(st, idx, say) {
    st.active = st.huds[idx].name; _save(); _demoOn = false; hudRefresh();
    say('tok', '✓ HUD „' + st.active + '“ ჩაირთო (' + st.huds[idx].items.length + ' ბარი)');
  }

  // /ჰუდი <სახელი | [N]> [დიახ] — switch on (the previous HUD switches off); unknown name needs "დიახ" to be created
  function _cmdSelect(args, say) {
    var parts = args.slice(), confirm = false;
    if (parts.length > 1 && parts[parts.length - 1] === 'დიახ') { confirm = true; parts.pop(); }
    var name = parts.join(' ').trim(), st = _ensureState();
    if (/^\d+$/.test(name)) {
      var n = parseInt(name, 10);
      if (n < st.huds.length) _activate(st, n, say); else say('ter', '✗ HUD [' + n + '] არ არსებობს — /ჰუდი');
      return;
    }
    var err = _nameError(name);
    if (err) { say('ter', err); return; }
    var idx = _hudIndex(st, name);
    if (idx >= 0) { _activate(st, idx, say); return; }
    if (!confirm) { say('tdm', 'HUD „' + name + '“ არ არსებობს — შესაქმნელად: /ჰუდი ' + name + ' დიახ'); return; }
    if (st.huds.length >= MAX_HUDS) { say('ter', '✗ HUD-ების ლიმიტი: ' + MAX_HUDS); return; }
    st.huds.push({ name: name, items: [] }); st.active = name; _save(); _demoOn = false; hudRefresh();
    say('tok', '✓ HUD „' + name + '“ შეიქმნა და ჩაირთო');
    say('tdm', 'ბარის დასამატებლად გადადი სექციაში (/cd) და: /ჰუდი + <სახელი|id|ინდექსი>');
  }

  // /ჰუდი + <ref> — add an indicator or a todo of the CURRENT menu section to the active HUD
  async function _cmdAdd(ref, say, ctx) {
    var st = _ensureState(), hi = _activeIndex(st);
    if (hi < 0) { say('ter', '✗ ჯერ აირჩიე HUD: /ჰუდი <სახელი>'); return; }
    if (!ref.trim()) { say('ter', 'გამოყენება: /ჰუდი + <სახელი | id | ინდექსი> (მიმდინარე სექციიდან)'); return; }
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
    var h = st.huds[hi];
    if (h.items.indexOf(item.id) >= 0) { say('tdm', 'უკვე არის HUD „' + h.name + '“-ში'); return; }
    if (h.items.length >= MAX_ITEMS) { say('ter', '✗ HUD-ში მაქს. ' + MAX_ITEMS + ' ბარია'); return; }
    h.items.push(item.id); _save(); hudRefresh();
    say('tok', '✓ + ' + _itemLabel(item) + ' → HUD „' + h.name + '“ (' + h.items.length + ')');
  }

  // /ჰუდი − [<[N] | სახელი | id>] — no argument: numbered list of the active HUD's bars
  function _cmdRemove(ref, say) {
    var st = _ensureState(), hi = _activeIndex(st);
    if (hi < 0) { say('ter', '✗ ჯერ აირჩიე HUD: /ჰუდი <სახელი>'); return; }
    var h = st.huds[hi], map = _indexItems();
    if (!ref.trim()) {
      if (!h.items.length) { say('tdm', 'HUD „' + h.name + '“ ცარიელია'); return; }
      say('tdm', 'HUD „' + h.name + '“ — ბარები:');
      h.items.forEach(function (id, i) { say('tnf', '[' + i + '] ' + (_itemLabel(map[id]) || '(ვერ მოიძებნა: ' + id + ')')); });
      say('tdm', 'ამოსაღებად: /ჰუდი − <[N] | სახელი | id>');
      return;
    }
    var idx = -1;
    if (/^\d+$/.test(ref)) {
      var n = parseInt(ref, 10);
      if (n >= h.items.length) { say('ter', '✗ ბარი [' + n + '] არ არსებობს — /ჰუდი −'); return; }
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
      if (!pick.length) { say('ter', '✗ ბარი „' + ref + '“ HUD-ში ვერ მოიძებნა — /ჰუდი −'); return; }
      idx = pick[0];
    }
    var id0 = h.items[idx], lbl = _itemLabel(map[id0]) || id0;
    h.items.splice(idx, 1); _save(); hudRefresh();
    say('tok', '✗ − ' + lbl + ' ამოღებულია HUD „' + h.name + '“-დან');
  }

  // /ჰუდი წაშ <სახელი | [N]> დიახ — without "დიახ" only a preview
  function _cmdDelete(rest, say) {
    var parts = rest.slice(), confirm = false;
    if (parts.length && parts[parts.length - 1] === 'დიახ') { confirm = true; parts.pop(); }
    var name = parts.join(' ').trim(), st = _ensureState();
    if (!name) { say('ter', 'გამოყენება: /ჰუდი წაშ <სახელი | [N]> დიახ'); return; }
    var idx = /^\d+$/.test(name) ? parseInt(name, 10) : _hudIndex(st, name);
    if (idx < 0 || idx >= st.huds.length) { say('ter', '✗ HUD „' + name + '“ ვერ მოიძებნა — /ჰუდი'); return; }
    var h = st.huds[idx];
    if (!confirm) { say('tdm', 'HUD „' + h.name + '“ (' + h.items.length + ' ბარი) წაიშლება — დასადასტურებლად: /ჰუდი წაშ ' + h.name + ' დიახ'); return; }
    var wasActive = st.active && _norm(st.active) === _norm(h.name);
    st.huds.splice(idx, 1);
    if (wasActive) st.active = null;
    _save(); hudRefresh();
    say('tok', '✗ HUD „' + h.name + '“ წაიშალა');
  }

  async function hudCommand(args, say, ctx) {
    args = (args || []).map(String);
    var first = args[0] || '';
    if (!args.length) { _cmdList(say); return; }
    if (args.length === 1 && first === 'ტესტი') {
      _demoOn = true; hudRefresh();
      say('tok', '✓ HUD — სატესტო ბარები ჩაირთო (გამოსართავად: /ჰუდი გამორთვა)');
      return;
    }
    if (args.length === 1 && first === 'გამორთვა') {
      _demoOn = false;
      var st = _ensureState(); st.active = null; _save();
      hudRefresh();
      say('tok', '✓ HUD გამოირთო');
      return;
    }
    if (first === '+') { await _cmdAdd(args.slice(1).join(' '), say, ctx); return; }
    if (first === '\u2212' || first === '-' || first === '\u2013') { _cmdRemove(args.slice(1).join(' '), say); return; }
    if (first === 'წაშ') { _cmdDelete(args.slice(1), say); return; }
    _cmdSelect(args, say);
  }

  window._hudBarOf = _barOf;
  window.hudRefresh = hudRefresh;
  window.hudCommand = hudCommand;
})();
