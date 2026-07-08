// terminal.js — viewer terminal + /commands
// injected inline by export-html.js assembler
// depends on: _CFG, scale (runtime.js), applyScale, fitAreas, toggleMenu (runtime.js), menuOverrideSave (runtime.js)

function _tmInit() {
  if (!window.matchMedia('(display-mode: standalone)').matches) return;
  document.getElementById('termBtn').style.display = 'block';
  document.getElementById('mapTitle').style.display = 'none';
}

var _tmOpen = false, _tmFull = false, _tmHist = [], _tmHIdx = -1, _tmHCur = '', _tmMulti = false;
var _tmBooted = false;
var _tmEditObj = null;     // truthy sentinel while an edit session is open (dlg objKey, or menu node id)
var _tmEditMode = null;    // 'dlg' | 'menuItem' | null
var _tmEditMenuCtx = null; // { node, idx, type } — set only when _tmEditMode === 'menuItem'
var _tmEditLabel = null;   // human-readable label shown in cancel/header messages
var _tmEditBuf = null;     // raw content buffered from a chain segment, consumed by /შეყვანა
var _TMCMDS = ['/დახმარება','/გასუფთავება','/ინფო','/მასშტაბი','/ზონები','/ობიექტები','/დიალოგი','/წასვლა','/ლეგენდა','/მენიუ','/გახსნა','/შეყვანა','/სრული','/ისტორია','/ვადა','/ტექსტი','/შეტყობინება','/marker','/დახურვა','/flag','/nick','/me','/who','/color','/help','/pwd','/ls','/cd','/md','/rm','/edit','/ფოთოლი','/macro','/ლოგინი','/ლოგაუთი','/სახელი','/სესია','/სია','/დაწინაურება','/რეჟიმი'];

function toggleTerm() { _tmOpen ? closeTerm() : _tmOpen_(); }
function _tmOpen_() {
  _tmOpen = true;
  document.getElementById('mdlTerm').classList.add('open');
  setTimeout(function () { document.getElementById('tmIn').focus(); }, 240);
  if (!_tmBooted) { _tmBooted = true; _tmBoot(); }
}
function closeTerm() {
  // cancel edit mode silently on close
  if (_tmEditObj) { _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; document.getElementById('tmTa').value = ''; if (_tmMulti) tmToggleMulti(); }
  if (typeof _tmHistPopHide === 'function') _tmHistPopHide();
  _tmOpen = false; _tmFull = false;
  var t = document.getElementById('mdlTerm');
  t.classList.remove('open', 'tmfull');
  document.getElementById('tmFullBtn').classList.remove('on');
  document.getElementById('tmFullBtn').textContent = '⛶';
}
function tmToggleFull() {
  _tmFull = !_tmFull;
  document.getElementById('mdlTerm').classList.toggle('tmfull', _tmFull);
  var b = document.getElementById('tmFullBtn');
  b.classList.toggle('on', _tmFull); b.textContent = _tmFull ? '⊟' : '⛶';
}
function tmClear() { document.getElementById('tmOut').innerHTML = ''; }

// ── chat history (localStorage, 3 days) ──
var _HIST_TTL = 3 * 24 * 60 * 60 * 1000;
var _HIST_KEY = 'mdelo_chat_' + (_CFG && _CFG.title ? _CFG.title.replace(/[^a-zA-Z0-9ა-ჿ]/g, '_') : 'map');
var _HIST_TTL_KEY = _HIST_KEY + '_ttl';
var _HIST_MAX = 300;
(function () { try { var s = localStorage.getItem(_HIST_TTL_KEY); if (s) { var n = parseInt(s); if (n >= 1 && n <= 365) _HIST_TTL = n * 86400000; } } catch (e) {} })();

function _histSave(html) {
  try {
    var raw = localStorage.getItem(_HIST_KEY);
    var msgs = raw ? JSON.parse(raw) : [];
    msgs.push({ h: html, t: Date.now() });
    var cut = Date.now() - _HIST_TTL;
    msgs = msgs.filter(function (m) { return m.t > cut; });
    if (msgs.length > _HIST_MAX) msgs = msgs.slice(-_HIST_MAX);
    localStorage.setItem(_HIST_KEY, JSON.stringify(msgs));
  } catch (e) {}
}

function _histLoad() {
  try {
    var raw = localStorage.getItem(_HIST_KEY);
    if (!raw) return;
    var msgs = JSON.parse(raw);
    var cut = Date.now() - _HIST_TTL;
    msgs = msgs.filter(function (m) { return m.t > cut; });
    if (!msgs.length) return;
    var ago = Math.round((Date.now() - msgs[0].t) / 3600000);
    _tmL('tdm', '── ისტორია (' + ago + ' სთ წინ) ──');
    msgs.forEach(function (m) { _tmLH('chat hist', m.h); });
    _tmL('tdm', '────────────────────────────────');
  } catch (e) {}
}

function _histClear() {
  try { localStorage.removeItem(_HIST_KEY); } catch (e) {}
  _tmL('tok', 'ისტორია წაიშალა');
}

// ── multiline (chat/edit) mode ──
function tmToggleMulti() {
  _tmMulti = !_tmMulti;
  var btn   = document.getElementById('tmMlBtn');
  var inp   = document.getElementById('tmIn');
  var ta    = document.getElementById('tmTa');
  var hint  = document.getElementById('tmHint');
  var slash = document.getElementById('tmSlashBtn');
  var send  = document.getElementById('tmSendBtn');
  _tmHistPopHide();
  btn.textContent = _tmMulti ? '■' : '□';
  btn.classList.toggle('on', _tmMulti);
  inp.style.display   = _tmMulti ? 'none'  : '';
  hint.style.display  = _tmMulti ? 'none'  : '';
  slash.style.display = _tmMulti ? 'none'  : '';
  ta.style.display    = _tmMulti ? 'block' : 'none';
  send.style.display  = _tmMulti ? 'block' : 'none';
  if (_tmMulti) {
    ta.style.height = '44px';
    ta.style.maxHeight = '88px';
    ta.style.overflowY = 'auto';
  } else {
    ta.style.height = '';
  }
  setTimeout(function () { (_tmMulti ? ta : inp).focus(); }, 50);
}

function _tmTaResize(ta) {
  ta = ta || document.getElementById('tmTa');
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// ── send handler (shared by button and Ctrl+Enter) ──
function tmSend() {
  var ta = document.getElementById('tmTa');
  var v = ta.value.trim(); if (!v) return;

  // DSL/menu-item/legend edit mode intercept — don't treat as chat
  if (_tmEditObj) {
    if (_tmEditMode === 'menuItem') { _tmSaveMenuItem(v); return; }
    if (_tmEditMode === 'legend')   { _tmSaveLegend(v); return; }
    _tmSaveDlg(v); return;
  }

  _tmHist.unshift(v); _tmHIdx = -1; _tmHCur = '';
  ta.value = '';
  if (typeof chatHandleInput === 'function' && chatHandleInput(v)) return;
  _tmL('ti', v); _tmRun(v);
}

// textarea keydown (multiline + edit mode)
(function () {
  var ta = document.getElementById('tmTa');
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); tmSend(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (_tmEditObj) { _tmEditCancel(); }
      else { closeTerm(); }
    }
  });
  ta.addEventListener('input', function () { if (_tmMulti) _tmTaResize(ta); });
})();


function _tmL(cls, txt) {
  var d = document.createElement('div'); d.className = 'tl ' + cls; d.textContent = txt;
  var o = document.getElementById('tmOut'); o.appendChild(d); o.scrollTop = o.scrollHeight;
}
function _tmLH(cls, html) {
  var d = document.createElement('div'); d.className = 'tl ' + cls; d.innerHTML = html;
  var o = document.getElementById('tmOut'); o.appendChild(d); o.scrollTop = o.scrollHeight;
  if (cls === 'chat') _histSave(html);
}

// public API — other scripts can print to terminal
window.consolePrint = function (html, type) { _tmLH('chat', html); };
window.consoleClear = tmClear;

// ── boot message ──
function _tmBoot() {
  var d = _CFG;
  var objs  = document.querySelectorAll('.hotspot:not(.hs-area):not(.no-interact)').length;
  var areas = document.querySelectorAll('.hs-area').length;
  var lines = [
    ['tsy', 'MDELO — ტერმინალი'],
    ['tdm', '────────────────────────────────'],
    ['tnf', 'რუკა: ' + (d.title || 'უსახელო') + '   ' + d.cols + 'x' + d.rows],
    ['tnf', 'ობიექტები: ' + objs + '   ზონები: ' + areas],
    ['tdm', '"/დახმარება" — ბრძანების სია'],
    ['tdm', '────────────────────────────────']
  ];
  for (var i = 0; i < lines.length; i++) {
    (function (l, delay) { setTimeout(function () { _tmL(l[0], l[1]); }, delay); })(lines[i], i * 55);
  }
  setTimeout(_histLoad, lines.length * 55 + 80);
}

// ── inline history popup (backspace on empty input) ──
var _TM_HPOP_N = 5; // how many recent commands to show

function _tmHistPopBuild() {
  var pop = document.getElementById('tmHistPop');
  var inp = document.getElementById('tmIn');
  if (!pop || !_tmHist.length) return;
  var items = _tmHist.slice(0, _TM_HPOP_N);
  pop.innerHTML = items.map(function (h, i) {
    var esc = String(h).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div class="tm-hist-item" data-ix="' + i + '">' + esc + '</div>';
  }).join('');
  // position exactly above the input caret, not the whole row
  if (inp) {
    pop.style.left  = inp.offsetLeft + 'px';
    pop.style.right = 'auto';
    pop.style.width = Math.max(inp.offsetWidth, 140) + 'px';
  }
  pop.classList.add('open');
}
function _tmHistPopHide() {
  var pop = document.getElementById('tmHistPop');
  if (pop) pop.classList.remove('open');
}
window._tmHistPopHide = _tmHistPopHide;

// ── keyboard input ──
(function () {
  var inp = document.getElementById('tmIn');
  var hint = document.getElementById('tmHint');
  var pop  = document.getElementById('tmHistPop');

  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var v = inp.value.trim();
      if (!v) {
        // empty input + Enter/Go → run the most recent command directly
        if (_tmHist.length) {
          var last = _tmHist[0];
          _tmHistPopHide();
          _tmL('ti', last);
          _tmRun(last);
        }
        return;
      }
      _tmHist.unshift(v); _tmHIdx = -1; _tmHCur = '';
      var _isChat = v.charAt(0) !== '/' && typeof chatHandleInput === 'function';
      if (!_isChat) _tmL('ti', v);
      inp.value = ''; hint.textContent = '';
      _tmHistPopHide();
      _tmRun(v);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _tmHistPopHide();
      if (_tmHIdx === -1) _tmHCur = inp.value;
      _tmHIdx = Math.min(_tmHIdx + 1, _tmHist.length - 1);
      inp.value = _tmHist[_tmHIdx] || '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      _tmHistPopHide();
      _tmHIdx = Math.max(_tmHIdx - 1, -1);
      inp.value = _tmHIdx === -1 ? _tmHCur : _tmHist[_tmHIdx];
    } else if (e.key === 'Tab') {
      e.preventDefault();
      var v2 = inp.value.trim();
      var m = _TMCMDS.find(function (c) { return c.startsWith(v2) && c !== v2; });
      if (m) { inp.value = m; hint.textContent = ''; }
    } else if (e.key === 'Backspace' && inp.value === '' && _tmHist.length) {
      e.preventDefault();
      _tmHistPopBuild();
    } else if (e.key === 'Escape') {
      if (pop && pop.classList.contains('open')) { _tmHistPopHide(); }
      else { closeTerm(); }
    } else {
      _tmHistPopHide();
    }
  });
  inp.addEventListener('input', function () {
    var v = inp.value.trim();
    var m = _TMCMDS.find(function (c) { return c.startsWith(v) && c !== v; });
    hint.textContent = m ? m.slice(v.length) : '';
    if (v !== '') _tmHistPopHide();
  });

  // tap an item in the popup → fill it into the input (no auto-run)
  if (pop) {
    pop.addEventListener('click', function (e) {
      var item = e.target.closest('.tm-hist-item');
      if (!item) return;
      var ix = +item.dataset.ix;
      inp.value = _tmHist[ix] || '';
      _tmHIdx = ix;
      _tmHistPopHide();
      inp.focus();
    });
  }

  // tap anywhere outside the popup/input → close it
  document.addEventListener('pointerdown', function (e) {
    if (!pop || !pop.classList.contains('open')) return;
    if (pop.contains(e.target) || e.target === inp) return;
    _tmHistPopHide();
  });
})();

// ── global keyboard shortcuts ──
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && _tmOpen) { closeTerm(); return; }
  if ((e.key === '`' || e.key === '~') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault(); toggleTerm();
  }
});

var _SEP = '────────────────────────────────';

function tmInsertSlash() {
  var inp = document.getElementById('tmIn');
  if (inp.value.charAt(0) !== '/') inp.value = '/' + inp.value;
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
}

// ── command router ──
// ── tier-gated commands ──────────────────────────────────────────
// Everything NOT listed here defaults to 'visitor' (open to everyone,
// including logged-out visitors) — these are read-only/navigation/client-
// local commands: დახმარება, ინფო, მასშტაბი, ზონები, ობიექტები, წასვლა,
// ლეგენდა (view), მენიუ, pwd/ls/cd (nav only — comment above confirms /cd
// never mutates), marker (LOCAL-ONLY per _tmMarkerCmd, never touches
// Supabase), flag (this delegates to unlock.js — flag-setting IS the
// visitor-tier capability itself), ვადა (localStorage only), ლოგინი.
//
// Listed here = actually mutates shared state (menu_overrides,
// terminal_macros, notifications) via Supabase, so it needs the tier
// check the RLS layer intentionally does NOT enforce (UI-gating model).
var _TM_MIN_TIER = {
  'შეტყობინება': 'caretaker', // notification send — caretaker's other direct capability
  'todo':        'caretaker', // leaf-level todo/counter toggle (the exact "cat food refilled" case)
  'ფოთოლი':      'caretaker', // leaf-level item add (text/indicator/todo) — caretaker's direct write scope
  'დიალოგი':     'resident',  // dialogue DSL authoring
  'md':          'resident',  // create menu branch — structural, not leaf
  'rm':          'resident',  // remove menu node — structural
  'edit':        'resident',  // edit menu node/branch
  'macro':       'resident',  // author/manage shared macros
  'სია':         'shadow_admin' // list logged-in users (nickname/name/email/tier)
};

// Scoped elevation flag — true only while executing the commands *inside* a
// macro whose own min_tier the caller already cleared. Never set outside
// that one _tmRunChain call, and always restored in a finally block.
var _tmMacroElevated = false;

// Returns true (deny) when the current tier is below the command's
// requirement. Fails OPEN (allows) if the auth engine isn't loaded yet,
// so this never blocks local dev/testing before runtime.js is wired up —
// the real backstop is still the RLS policies on the write itself.
function _tmTierDenied(cmdKey) {
  if (_tmMacroElevated) return false; // authorized by the macro's own min_tier
  var minTier = _TM_MIN_TIER[cmdKey];
  if (!minTier) return false;
  if (typeof window._tierAtLeast !== 'function') return false;
  return !window._tierAtLeast(minTier);
}
function _tmDenyMsg(cmdKey) {
  var minTier = _TM_MIN_TIER[cmdKey];
  _tmL('ter', '✗ "/' + cmdKey + '" საჭიროებს "' + minTier + '" ან უფრო მაღალ tier-ს — შენი: ' + (typeof window.myTier === 'function' ? window.myTier() : 'visitor'));
}

async function _tmRun(raw) {
  var text = raw.trim();
  if (text.charAt(0) !== '/') {
    if (typeof chatHandleInput === 'function' && chatHandleInput(text)) return;
    _tmL('ter', 'ბრძანებები იწყება "/" — მაგ.: /დახმარება');
    return;
  }
  var full = text.slice(1);

  // A macro DEFINITION owns its own ";"-separated body — never let the generic
  // resolver/splitter below tear it apart before it reaches _tmMacro.
  var isMacroDef = /^macro\s+(local|საერთო)\s+/.test(full) && full.indexOf(':=') >= 0;

  if (!isMacroDef) {
    // ── exact macro-name match (local scope wins over shared) — checked before
    //    normal dispatch, so a saved shortcut behaves like a brand-new command ──
    var macroHit = _tmMacroResolve(full);
    if (macroHit) {
      if (macroHit.minTier && !window._tierAtLeast(macroHit.minTier)) {
        _tmL('ter', '✗ "/' + full + '" საჭიროებს "' + macroHit.minTier + '" ან უფრო მაღალ tier-ს — შენი: ' + (typeof window.myTier === 'function' ? window.myTier() : 'visitor'));
        return;
      }
      // min_tier IS the authorization for this macro's own bundled commands —
      // elevate ONLY for the duration of this chain, never leaks beyond it.
      var wasElevated = _tmMacroElevated;
      if (macroHit.minTier) _tmMacroElevated = true;
      try {
        await _tmRunChain(macroHit.commands);
      } finally {
        _tmMacroElevated = wasElevated;
      }
      return;
    }

    // ── generic ";"-chaining: only splits where ";" is followed by "/",
    //    so a stray ";" inside ordinary item text is left alone ──
    var chainParts = _tmSplitChain(full);
    if (chainParts.length > 1) { await _tmRunChain(chainParts); return; }
  }

  // ── /შეტყობინება[*!~+.] text [@@area] — direct notification send ──
  // /todo/<სექცია>/<სექცია>/.../<N> — toggle a todo item anywhere, no /cd needed.
  // Path resolution is identical to /მენიუ/... — collision-safe even when two
  // different branches have todos with the same label, since the path always
  // pins down one exact node and N is that node's own items[] index.
  var todoPathM = full.match(/^todo\/(.+)$/);
  if (todoPathM) {
    if (_tmTierDenied('todo')) { _tmDenyMsg('todo'); return; }
    var tsegs = todoPathM[1].split('/').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!tsegs.length || !/^\d+$/.test(tsegs[tsegs.length - 1])) {
      _tmL('ter', 'გამოყენება: /todo/სექცია/.../N');
    } else {
      var tIdx = parseInt(tsegs[tsegs.length - 1]);
      var tNode = _tmFindMenuNodeByPath(tsegs.slice(0, -1));
      if (tNode) await _tmTodoToggle(tNode, tIdx);
    }
    return;
  }

  var notifM = full.match(/^შეტყობინება([*!~+.^]?)(?:\s+([\s\S]*))?$/);
  if (notifM) {
    if (_tmTierDenied('შეტყობინება')) { _tmDenyMsg('შეტყობინება'); return; }
    await _tmNotify(notifM[1], notifM[2] || ''); return;
  }

  // /მენიუ/<სექცია>/<სექცია>/.../<ფოთოლი_index?> — deep-link straight to a menu panel/leaf
  var menuPathM = full.match(/^მენიუ\/(.+)$/);
  if (menuPathM) { _tmMenuOpenPath(menuPathM[1].split('/').map(function (s) { return s.trim(); }).filter(Boolean)); return; }

  var parts = full.split(/\s+/), cmd = parts[0], args = parts.slice(1);
  var map = {
    'დახმარება':   _tmHelp,
    'გასუფთავება': tmClear,
    'ინფო':        _tmInfo,
    'მასშტაბი':    _tmZoom,
    'ზონები':      _tmAreas,
    'ობიექტები':   _tmObjects,
    'დიალოგი':     _tmDlgEdit,
    'წასვლა':      _tmGo,
    'ლეგენდა':     _tmLegend,
    'მენიუ':       _tmMenu,
    'გახსნა':      _tmOpenCmd,
    'შეყვანა':     _tmSubmitCmd,
    'სრული':       tmToggleFull,
    'ისტორია':     _histClear,
    'ვადა':        _tmVada,
    'ტექსტი':      tmToggleMulti,
    'დახურვა':     closeTerm,
    'flag':        _tmFlagDelegate,
    'pwd':         _tmMenuPwd,
    'ls':          _tmMenuLs,
    'cd':          _tmMenuCd,
    'md':          _tmMenuMd,
    'rm':          _tmMenuRm,
    'edit':        _tmMenuEdit,
    'ფოთოლი':      _tmMenuLeaf,
    'macro':       _tmMacro,
    'marker':      _tmMarkerCmd,
    'ლოგინი':      _tmLogin,
    'ლოგაუთი':     _tmLogout,
    'სახელი':      _tmSetName,
    'სტატუსი':     _tmResolveStatus,
    'სესია':       _tmDebug,
    'სია':         _tmUserList,
    'დაწინაურება': _tmRequestTierUp,
    'რეჟიმი':      _tmDevViewTier
  };
  var fn = map[cmd];
  if (fn) {
    if (_tmTierDenied(cmd)) { _tmDenyMsg(cmd); return; }
    await fn(args); return;
  }
  if (typeof chatHandleInput === 'function' && chatHandleInput(text)) return;
  _tmL('ter', 'უცნობი ბრძანება: "/' + cmd + '" — სცადე: /დახმარება');
}

// ── built-in commands ──
function _tmHelp() {
  var list = [
    ['/დახმარება',        'ბრძანების სია'],
    ['/გასუფთავება',      'კონსოლის გასუფთავება'],
    ['/ინფო',             'რუკის ინფორმაცია'],
    ['/მასშტაბი [N]',     'zoom 0.25–6'],
    ['/ზონები',           'ზონების სია'],
    ['/ობიექტები',        'ობიექტები + dialogue სტატუსი'],
    ['/დიალოგი [სახელი]', 'DSL რედაქტირება · Ctrl+Enter შესანახად'],
    ['/წასვლა [N]',       'ზონაზე ნავიგაცია'],
    ['/ლეგენდა',          'აღწერას ჩვენა/დამალვა'],
    ['/ლეგენდა რედაქტირება', 'მთავარი ლეგენდის ტექსტის რედაქტირება'],
    ['/მენიუ',            'მენიუს toggle'],
    ['/მენიუ/სექცია/.../N', 'პირდაპირი ლინკი ნესტ. სექციაზე ან item-ზე'],
    ['/todo/სექცია/.../N',  'todo-ის toggle ნებისმიერი branch-დან, /cd-ის გარეშე'],
    ['/გახსნა',           'ტერმინალის გახსნა (macro/window hook-ისთვის)'],
    ['/შეყვანა',          'Enter/Send — ღია edit-სესიის submit (macro-chain-ისთვის)'],
    ['/სრული',            'სრული ↔ ნახევარი'],
    ['/ისტორია',          'ჩატის ისტორიის წაშლა'],
    ['/ვადა [N]',         'ისტ. შენახვა N დღე'],
    ['/ტექსტი',           'ჩატ ↔ ბრძანება mode'],
    ['/შეტყობინება[*!~+.^] ტექსტი [@@ზონა]', 'შეტყობინების გაგზავნა  (^+. =ხმის მიცემა ::დეტ ##N {ბრძანება})'],
    ['/marker set <სახელი> ?/!/~/-', 'მარკერი — ლოკალური (მხ. შენ)'],
    ['/marker reset [სახელი]', 'მარკერი → საწყისზე (ერთი ან ყველა)'],
    ['/დახურვა',          'დახურვა  [Esc]'],
    ['/flag set/clear/list', 'flag სისტემა'],
    ['/nick სახელი',      'ნიკნეიმის შეცვლა'],
    ['/me ტექსტი',        '* აქშნის მესიჯი'],
    ['/who',              'ონლაინ სია'],
    ['/color #hex',       'ნიკნეიმის ფერი'],
    ['/pwd',              'მენიუს მიმდინარე გზა'],
    ['/ls',               'მენიუს კვანძის შემცველობა'],
    ['/cd [სახელი|..|/|a/b/c]', 'ნავიგაცია — ერთი ნაბიჯი ან slash-path'],
    ['/md <სახელი> [ემოჯი]', 'ახალი ქვე-სექცია + ავტო-cd (default 📁)'],
    ['/ფოთოლი ტექსტი|ინდიკატორი [ემოჯი]|todo', 'item-ის დამატება მიმდინარე კვანძში'],
    ['/rm <სახელი|N>',    'სექციის (სახელით) ან item-ის (ინდექსით) წაშლა'],
    ['/edit <N>',         'item [N] — multiline რედაქტირება'],
    ['/edit <N> <...>',   'item [N] — სწრაფი ერთხაზიანი ედიტი'],
    ['/macro local <სახელი> := ...',  'პერსონალური შორთკატის შექმნა'],
    ['/macro საერთო <სახელი> := ...', 'გაზიარებული შორთკატის შექმნა'],
    ['/macro ls',         'ყველა შორთკატის სია'],
    ['/macro rm local|საერთო <სახელი>', 'შორთკატის წაშლა'],
    ['/სია', 'დალოგინებული იუზერების სია (მხოლოდ shadow_admin)'],
    ['/დაწინაურება', 'შემდეგი ტიერის თხოვნა კონსენსუსით (visitor→caretaker, caretaker→resident)'],
    ['/რეჟიმი <tier>', 'ტესტ რეჟიმი — UI ხედავს სხვა ტიერად (მხოლოდ shadow_admin, /რეჟიმი გამორთვა-ით იხურება)'],
    ['/ლოგინი',           'შესვლა (popup: email + სახელი), ან სტატუსის ჩვენება'],
    ['/ლოგაუთი',          'გამოსვლა სისტემიდან'],
    ['/სახელი <ახალი სახელი>', 'display_name-ის შეცვლა (დიალოგებში ჩანს)'],
    ['/სესია',            'auth-ის მდგომარეობა — devtools-ის გარეშე']
  ];
  _tmL('tdm', _SEP); _tmL('tsy', '--- ბრძანები ---');
  for (var i = 0; i < list.length; i++) {
    var c = list[i][0], d = list[i][1];
    var pad = c; while (pad.length < 24) pad += ' ';
    _tmL('tnf', pad + d);
  }
  _tmL('tdm', 'Tab — ავტოდასრულება   ↑↓ — ისტორია');
  _tmL('tdm', 'ტექსტი "/" გარეშე → ჩატის მესიჯი');
  _tmL('tdm', _SEP);
}
function _tmInfo() {
  var d = _CFG;
  var objs  = document.querySelectorAll('.hotspot:not(.hs-area):not(.no-interact)').length;
  var areas = document.querySelectorAll('.hs-area').length;
  _tmL('tdm', _SEP);
  _tmL('tnf', 'სახელი:    ' + (d.title || 'უსახელო'));
  _tmL('tnf', 'ზომა:       ' + d.cols + ' × ' + d.rows + ' სექტორი');
  _tmL('tnf', 'zoom:       ' + scale.toFixed(2) + 'x');
  _tmL('tnf', 'ობიექტები: ' + objs);
  _tmL('tnf', 'ზონები:    ' + areas);
  _tmL('tdm', _SEP);
}
function _tmZoom(args) {
  var n = parseFloat(args[0]);
  if (isNaN(n) || n < 0.25 || n > 6) { _tmL('ter', 'მასშტაბი: 0.25–6 შორის'); return; }
  applyScale(n, wrap.clientWidth / 2, wrap.clientHeight / 2);
  _tmL('tok', 'მასშტაბი: ' + n + 'x');
}
function _tmAreas() {
  var els = document.querySelectorAll('.hs-area');
  if (!els.length) { _tmL('tdm', 'ზონები: ცარიელია'); return; }
  var seen = {}; _tmL('tdm', _SEP);
  els.forEach(function (el) { var t = el.dataset.title; if (t && !seen[t]) { seen[t] = 1; _tmL('tnf', '▸ ' + t); } });
  _tmL('tdm', _SEP); _tmL('tdm', 'გამოიყენე: წასვლა [სახელი]');
}

function _tmObjects() {
  var els = document.querySelectorAll('.hotspot:not(.hs-area):not(.no-interact)');
  if (!els.length) { _tmL('tdm', 'ობიექტები: ცარიელია'); return; }
  _tmL('tdm', _SEP);
  _tmL('tsy', 'ობიექტები  [/დიალოგი სახელი — რედაქტირება]');
  els.forEach(function (el) {
    var title = el.dataset.title || '(უსახელო)';
    var oi = el.dataset.oi;
    var obj = (oi != null && typeof _OBJS !== 'undefined' && _OBJS[+oi]) ? _OBJS[+oi] : null;
    var displayName = (obj && obj.lb) ? obj.lb : title;
    var suffix = '';
    if (obj && obj.dialogue && obj.dialogue.length) {
      suffix = ' [💬 ' + obj.dialogue.length + ']';
    }
    _tmL('tnf', '◆ ' + displayName + suffix);
  });
  _tmL('tdm', _SEP);
}

// /ლოგინი — თუ უკვე ხარ ავტორიზებული, სტატუსს აჩვენებს. თუ არა — ხსნის
// combined popup-ს (email + სახელი, runtime.js: showLoginModal). ცალკე
// "/ლოგინი email@x.com" ვარიანტი ამოღებულია — არაფერს ამარტივებდა, popup
// ისედაც ყოველთვის იხსნებოდა.
async function _tmLogin() {
  if (typeof window.isLoggedIn === 'function' && window.isLoggedIn()) {
    _tmL('tok', '✓ ავტორიზებული ხარ, როგორც ' + window.myDisplayName() + '  (tier: ' + window.myTier() + ')');
    return;
  }
  if (typeof window.showLoginModal !== 'function' || typeof window.requestMagicLink !== 'function') {
    _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var res = await window.showLoginModal();
  if (!res) return; // გააუქმა

  if (res.name) { try { localStorage.setItem('mdelo_pending_name', res.name); } catch (e) {} }

  _tmL('ti', '/ლოგინი ' + res.email);
  _tmL('tdm', 'იგზავნება login ბმული "' + res.email + '"-ზე...');
  var lres = await window.requestMagicLink(res.email);
  if (lres === true) _tmL('tok', '✓ შეამოწმე ელფოსტა — login ბმული გამოგზავნილია');
  else _tmL('ter', '✗ ვერ გაიგზავნა: ' + (lres && lres.msg ? lres.msg : 'უცნობი შეცდომა'));
}

// /სტატუსი <notification_id> — HIDDEN deliberately: not in _TMCMDS, not in
// _tmHelp, no autocomplete. Only ever meant to run as a notification's own
// terminal_cmd (auto-attached by btn.applyTier in runtime.js), auto-executed
// once the existing consensus-quorum UI detects unanimity. It is still safe
// to type by hand or forge, though — resolve_tier_change() (SQL, security
// definer) re-counts votes itself and no-ops unless real quorum is met, so
// hiding this command is a courtesy, not the actual protection.
async function _tmResolveStatus(args) {
  var notifId = (args || [])[0];
  if (!notifId) return; // silent — this should never be invoked by a person directly
  try {
    var r = await fetch(SUPA_URL + '/rest/v1/rpc/resolve_tier_change', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _authHeaders()),
      body: JSON.stringify({ notif_id: notifId })
    });
    var data = r.ok ? await r.json() : null;
    if (data && data.ok) {
      _tmL('tok', '✓ tier შეიცვალა — ' + data.tier);
      if (typeof loadNotifs === 'function') loadNotifs();
    } else {
      _tmL('tdm', 'tier ცვლილება ჯერ არ დამტკიცებულა (' + (data && data.reason ? data.reason : 'უცნობი') + ')');
    }
  } catch (e) { /* silent — this is a background auto-command */ }
}

// /სახელი <ახალი სახელი> — შეცვლის display_name-ს ნებისმიერ დროს (არა მხოლოდ
// პირველ login-ზე). სასარგებლოა ზუსტად იმ შემთხვევისთვის, თუ პირველი login-ის
// popup-ში სახელი ცარიელი დარჩა (ძველი ბაგი — Enter email-ის ველში აგზავნიდა
// ფორმას სახელის ველამდე მისვლის გარეშე; ეს ახლა სავალდებულოა, მაგრამ ვინც
// ადრე დარეგისტრირდა ცარიელი სახელით, ამ ბრძანებით გაასწორებს, ლოგაუთის გარეშე).
// /სესია — mobile-friendly stand-in for devtools console; prints the raw
// auth state (session presence, tier row, etc.) straight into the terminal.
// (named /სესია, not /debug — chat.js already owns /debug for its own diagnostics)
async function _tmDebug() {
  var loggedIn = typeof window.isLoggedIn === 'function' ? window.isLoggedIn() : '(isLoggedIn ვერ მოიძებნა)';
  _tmL('ti', 'isLoggedIn(): ' + loggedIn);
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem('mdelo_auth_session') || 'null'); } catch (e) {}
  if (sess) {
    _tmL('tdm', 'session: user_id=' + (sess.user && sess.user.id) + '  email=' + (sess.user && sess.user.email) +
      '  expires_at=' + new Date(sess.expires_at).toLocaleString());
  } else {
    _tmL('ter', 'session: localStorage-ში არაფერია (mdelo_auth_session)');
  }
  _tmL('tdm', 'window._myTier: ' + JSON.stringify(window._myTier));
  _tmL('tdm', 'myTier(): ' + (typeof window.myTier === 'function' ? window.myTier() : '?') +
    '   myDisplayName(): ' + (typeof window.myDisplayName === 'function' ? window.myDisplayName() : '?'));

  // if the tier row never loaded, retry it right here and print the *exact*
  // failure into the terminal — not a toast, so it doesn't disappear before
  // you can read it
  if (loggedIn && !window._myTier && sess && sess.user) {
    _tmL('tdm', 'ვცდი user_tiers-ის ხელახლა ჩატვირთვას...');
    try {
      var gr = await fetch(SUPA_URL + '/rest/v1/user_tiers?user_id=eq.' + sess.user.id + '&select=*', { headers: _authHeaders() });
      var gbody = await gr.text();
      _tmL(gr.ok ? 'tok' : 'ter', 'GET user_tiers → ' + gr.status + ': ' + gbody.slice(0, 300));
      if (gr.ok && JSON.parse(gbody || '[]').length === 0) {
        var pr = await fetch(SUPA_URL + '/rest/v1/user_tiers', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHeaders()),
          body: JSON.stringify({ user_id: sess.user.id })
        });
        var pbody = await pr.text();
        _tmL(pr.ok ? 'tok' : 'ter', 'POST user_tiers → ' + pr.status + ': ' + pbody.slice(0, 300));
      }
    } catch (e) { _tmL('ter', 'exception: ' + e.message); }
  }
}

// /სია — shadow_admin only. Lists every account with a user_tiers row:
// display name + email + tier. "ნიკნეიმი" (mdelo_nick from chat.js' /nick)
// is deliberately NOT included — it's device-local localStorage, never
// synced to Supabase, so there is nothing server-side to list it from.
// Backed by the `list_users` SQL RPC (SECURITY DEFINER) — see handoff notes
// for the migration; this command is a no-op until that RPC exists.
async function _tmUserList() {
  if (typeof window.listUsers !== 'function') { _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)'); return; }
  var rows = await window.listUsers();
  if (rows && rows.ok === false) {
    _tmL('ter', '✗ Supabase: ' + (rows.msg || ('status ' + rows.status)));
    if (rows.status === 404) _tmL('tdm', '(სავარაუდოდ `list_users` RPC ჯერ არ არსებობს Supabase-ში)');
    return;
  }
  if (!rows || !rows.length) { _tmL('tdm', 'ვერცერთი იუზერი ვერ მოიძებნა'); return; }
  _tmL('tsy', 'იუზერების სია (' + rows.length + '):');
  rows.forEach(function (u) {
    var name = u.display_name || '(უსახელო)';
    var email = u.email || '?';
    var tier = u.tier || 'visitor';
    _tmL('tnf', '  ' + name + '  ·  ' + email + '  ·  ' + tier);
  });
}

// /დაწინაურება — available to any logged-in tier below resident (visitor or
// caretaker). Auto-computes the next tier (nextTierFor), pops a form for the
// person's own request text (name automatic), then delegates to the shared
// requestTierUp() — the exact same consensus/quorum/subject_data shape the
// applyTier dialogue button already uses. One open request per person at a
// time (requestTierUp itself blocks a duplicate on the same topic).
async function _tmRequestTierUp() {
  if (typeof window.isLoggedIn !== 'function' || !window.isLoggedIn()) {
    _tmL('tdm', 'ჯერ არ ხარ ავტორიზებული — /ლოგინი.');
    return;
  }
  var myTier = typeof window.myTier === 'function' ? window.myTier() : 'visitor';
  // visitor can request either caretaker or resident directly — both are
  // equally valid, single-topic consensus requests (per project decision).
  // caretaker only ever has one next step: resident.
  var tierOptions;
  if (myTier === 'visitor') {
    tierOptions = [
      { value: 'caretaker', label: 'ქეართეიქერი' },
      { value: 'resident', label: 'რეზიდენტი' }
    ];
  } else if (myTier === 'caretaker') {
    tierOptions = [{ value: 'resident', label: 'რეზიდენტი' }];
  } else {
    _tmL('tdm', 'შენი ტიერიდან (' + myTier + ') აღარაფერი მოითხოვება ავტომატურად ამ გზით.');
    return;
  }
  if (typeof window.showNotifyFormModal !== 'function' || typeof window.requestTierUp !== 'function') {
    _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var fres = await window.showNotifyFormModal({
    title: 'დაწინაურების განაცხადი',
    tierOptions: tierOptions,
    textForTier: function (tier) {
      var lbl = tier === 'caretaker' ? 'ქეართეიქერი' : 'რეზიდენტი';
      return window.myDisplayName() + '-ს სურს გახდეს ' + lbl;
    }
  });
  if (!fres) { _tmL('tdm', 'გაუქმდა'); return; }
  var targetTier = fres.tier || tierOptions[0].value;
  var label = targetTier === 'caretaker' ? 'ქეართეიქერი' : 'რეზიდენტი';
  var res = await window.requestTierUp(targetTier, fres.text, fres.detail);
  if (res.ok) {
    _tmL('tok', '✓ განაცხადი გაგზავნილია (' + label + ') — ხმის მიცემა იწყება');
  } else if (res.reason === 'already_pending') {
    _tmL('tdm', '⚠️ უკვე გაქვს გახსნილი განაცხადი — დაელოდე მის გადაწყვეტას');
  } else {
    _tmL('ter', '✗ განაცხადი ვერ გაიგზავნა (' + (res.reason || 'უცნობი') + ')');
    if (res.status) _tmL('tdm', 'Supabase HTTP ' + res.status + ': ' + (res.msg || ''));
  }
}

// /რეჟიმი <tier> — shadow_admin only. Local view-tier override: UI-gating
// (buttons, macro tier-checks, command tier-checks) sees the given tier
// instead of the real one, WITHOUT logging out/in. Gated on myRealTier(),
// never myTier() — otherwise once viewing as visitor there'd be no way to
// switch back. Does NOT touch the real Supabase session — RLS-enforced
// writes underneath still run as the real shadow_admin, so this only proves
// what the UI shows/hides for a tier, not what the server would block.
var _TM_TIER_ALIASES = {
  'ვიზიტორი': 'visitor', 'visitor': 'visitor',
  'ქეართეიქერი': 'caretaker', 'მეურვე': 'caretaker', 'caretaker': 'caretaker',
  'რეზიდენტი': 'resident', 'resident': 'resident',
  'შედოუადმინი': 'shadow_admin', 'ადმინი': 'shadow_admin', 'shadow_admin': 'shadow_admin'
};
function _tmDevViewTier(args) {
  if (typeof window.myRealTier !== 'function' || window.myRealTier() !== 'shadow_admin') {
    _tmL('ter', '✗ "/რეჟიმი" საჭიროებს "shadow_admin" — შენი: ' + (typeof window.myTier === 'function' ? window.myTier() : 'visitor'));
    return;
  }
  var arg = (args || [])[0];
  if (!arg) {
    var cur = localStorage.getItem('mdelo_dev_view_tier');
    _tmL('tdm', cur ? ('ტესტ რეჟიმი აქტიურია: ' + cur) : 'ტესტ რეჟიმი გამორთულია (ხედავ როგორც shadow_admin)');
    _tmL('tdm', 'გამოყენება: /რეჟიმი visitor|caretaker|resident|shadow_admin  ან  /რეჟიმი გამორთვა');
    return;
  }
  if (arg === 'გამორთვა' || arg === 'off' || arg === 'shadow_admin') {
    window.clearDevViewTier();
    _tmL('tok', '✓ ტესტ რეჟიმი გამორთულია — ისევ shadow_admin ხედვაა');
    return;
  }
  var tier = _TM_TIER_ALIASES[arg];
  if (!tier) { _tmL('ter', '✗ უცნობი ტიერი: "' + arg + '"'); return; }
  var res = window.setDevViewTier(tier);
  if (res.ok) _tmL('tok', '✓ ტესტ რეჟიმი: ხედავ როგორც "' + tier + '"');
  else _tmL('ter', '✗ ვერ ჩაირთო (' + res.reason + ')');
}

async function _tmSetName(args) {
  if (typeof window.isLoggedIn !== 'function' || !window.isLoggedIn()) {
    _tmL('tdm', 'ჯერ არ ხარ ავტორიზებული — /ლოგინი.');
    return;
  }
  var name = (args || []).join(' ').trim();
  if (!name) { _tmL('ter', 'გამოყენება: /სახელი ახალი სახელი'); return; }
  if (typeof window.setDisplayName !== 'function') { _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)'); return; }
  var ok = await window.setDisplayName(name);
  if (ok) _tmL('tok', '✓ სახელი შეიცვალა: ' + name);
  else _tmL('ter', '✗ ვერ განახლდა');
}

function _tmLogout() {
  if (typeof window.isLoggedIn !== 'function' || !window.isLoggedIn()) {
    _tmL('tdm', 'ჯერ არ ხარ ავტორიზებული.');
    return;
  }
  if (typeof window.signOut !== 'function') { _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)'); return; }
  window.signOut();
  _tmL('tok', '✓ გამოხვედი სისტემიდან');
}

function _tmGo(args) {
  var label = args.join(' ').trim();
  if (!label) { _tmL('ter', 'გამოყენება: წასვლა [ზონის სახელი]'); return; }
  var els = document.querySelectorAll('.hs-area[data-title="' + label + '"]');
  if (!els.length) { _tmL('ter', 'ზონა ვერ მოიძებნა: "' + label + '"'); return; }
  fitAreas(label); closeTerm();
}
function _tmLegend(args) {
  var sub = (args[0] || '').trim();
  if (sub === 'რედაქტირება' || sub === 'edit') { _tmLegendEditOpen(); return; }
  toggleQuest();
  _tmL('tok', 'ლეგენდა: toggled');
}

// Open the multiline editor for the main "?" legend text.
function _tmLegendEditOpen() {
  var p = document.getElementById('questPopup');
  if (!p) { _tmL('ter', '✗ ლეგენდის ელემენტი ვერ მოიძებნა'); return; }
  var current = p.dataset.full || p.textContent || '';

  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = current;
  _tmTaResize();
  _tmEditObj   = '__legend__';
  _tmEditMode  = 'legend';
  _tmEditLabel = 'მთავარი ლეგენდა';

  _tmL('tsy', '─── მთავარი ლეგენდა ──────────────');
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Save the multiline editor content as the new legend text — updates the
// live popup immediately and pushes the override to Supabase for every viewer.
async function _tmSaveLegend(text) {
  var p = document.getElementById('questPopup');
  if (p) {
    p.dataset.full = text;
    if (p.style.display === 'block') {
      p.textContent = '';
      if (typeof _typewriter === 'function') _typewriter(p, text, 60); else p.textContent = text;
    }
  }

  var label = _tmEditLabel;
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null;
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();

  _tmL('tdm', '↑ ' + label + ' — ვინახავ...');
  if (typeof window.legendOverrideSave !== 'function') {
    _tmL('ter', '✗ legendOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var res = await window.legendOverrideSave(text);
  if (res === true) _tmL('tok', label + ' — შენახულია ✓ (ყველა viewer-ს ეჩვენება)');
  else _tmL('ter', '✗ Supabase: ' + (res && res.msg ? res.msg : 'უცნობი'));
}
function _tmMenu() { closeTerm(); toggleMenu(); }

// ── /მენიუ/<section>/<section>/.../<leaf-item-index?> — deep link ──
// Drills the visible game-menu UI (runtime.js's _gmShowPanel/_gmOpenOverlay)
// straight to a nested section or a specific item inside a leaf, instead of
// making the person tap through each level by hand.
// Resolves a section-title path (["მაცხოვრებლები","გიორგი","დღიური"]) to its
// node object, walking _gmCfg.menu top-down. Returns null + logs an error if
// any segment doesn't match. Shared by /მენიუ deep-link and /todo toggle.
function _tmFindMenuNodeByPath(segs) {
  if (!_gmCfg) _gmCfg = _CFG;
  var nodes = _gmCfg.menu || [], node = null;
  for (var i = 0; i < segs.length; i++) {
    node = nodes.find(function (n) { return (n.title || '').trim() === segs[i]; });
    if (!node) { _tmL('ter', 'მენიუში ვერ მოიძებნა: "' + segs[i] + '"'); return null; }
    if (i < segs.length - 1) {
      if (!node.children || !node.children.length) { _tmL('ter', '"' + node.title + '" — ქვესექციები არ აქვს'); return null; }
      nodes = node.children;
    }
  }
  return node;
}

function _tmMenuOpenPath(segs) {
  if (!segs.length) { _tmMenu(); return; }
  if (!_gmCfg) _gmCfg = _CFG;

  var itemIdx = null;
  if (/^\d+$/.test(segs[segs.length - 1])) { itemIdx = parseInt(segs[segs.length - 1]); segs = segs.slice(0, -1); }
  if (!segs.length) { _tmMenu(); return; }

  var nodes = _gmCfg.menu || [], path = [], node = null;
  for (var i = 0; i < segs.length; i++) {
    node = nodes.find(function (n) { return (n.title || '').trim() === segs[i]; });
    if (!node) { _tmL('ter', 'მენიუში ვერ მოიძებნა: "' + segs[i] + '"'); return; }
    if (i < segs.length - 1) {
      if (!node.children || !node.children.length) { _tmL('ter', '"' + node.title + '" — ქვესექციები არ აქვს'); return; }
      path.push({ title: node.title, nodes: node.children });
      nodes = node.children;
    }
  }

  var gm = document.getElementById('gameMenu');
  var wasOpen = gm.classList.contains('open');
  if (!wasOpen) toggleMenu();

  if (node.items && node.items.length) {
    _gmOpenOverlay(node, nodes, path, !wasOpen);
    if (itemIdx != null) {
      setTimeout(function () {
        var body = document.getElementById('gmOverlayBody');
        var el = body.children[itemIdx];
        if (!el) { _tmL('ter', 'item [' + itemIdx + '] არ არსებობს'); return; }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var orig = el.style.backgroundColor;
        el.style.transition = 'background-color .3s';
        el.style.backgroundColor = 'rgba(0,255,136,.25)';
        setTimeout(function () { el.style.backgroundColor = orig; }, 1200);
      }, 80);
    }
  } else if (node.children && node.children.length) {
    _gmShowPanel(node.children, path.concat([{ title: node.title, nodes: node.children }]));
  } else {
    _gmShowPanel(nodes, path);
  }
  _tmL('tok', '☰ → ' + segs.join('/') + (itemIdx != null ? '/' + itemIdx : ''));
}

function _tmOpenCmd() {
  if (!_tmOpen) _tmOpen_();
  _tmL('tok', 'ტერმინალი გახსნილია');
}

// ── /შეყვანა — Enter/Send equivalent for macro chains ──
// Submits content into whichever edit session is currently open (dlg/menuItem/
// legend), exactly as pressing the ➤ button would. Content comes from either
// a buffered chain segment (_tmEditBuf, set by _tmRunChain) or, if typed
// directly rather than via a macro, whatever's already sitting in #tmTa.
function _tmSubmitCmd() {
  if (!_tmEditObj) { _tmL('ter', '/შეყვანა: ღია edit-სესია არ მოიძებნა'); return; }
  var v = (_tmEditBuf != null) ? _tmEditBuf : document.getElementById('tmTa').value.trim();
  _tmEditBuf = null;
  if (!v) { _tmL('ter', '/შეყვანა: შესანახი ტექსტი არ მოიძებნა'); return; }
  if (_tmEditMode === 'menuItem') { _tmSaveMenuItem(v); return; }
  if (_tmEditMode === 'legend')   { _tmSaveLegend(v); return; }
  _tmSaveDlg(v);
}

// ── /marker set|reset — local-only marker override (personal exploration) ──
// Reuses _applyMarkerDom / _markerSave / _mkRestoring / _MK_KEY from runtime.js — zero new infra.
// Visible only on this device; community/Supabase state never touched.
//   ?  →  '?'   (badge "?"   class q)    — აღებული ქუესტი
//   !  →  '!'   (badge "!"   class exc)  — quest
//   ~  →  '💬'  (badge "..." class chat) — ჩატი
//   -  →  ''    (hs-dot "•")             — ნეიტრალური
var _TM_MK_SYM = { '?': '?', '!': '!', '~': '💬', '-': '' };

// Find hotspot by name — same dual-path lookup as /დიალოგი (data-title, then .lb fallback by oi).
function _tmFindHotspot(name) {
  var hs = document.querySelector('.hotspot[data-title="' + name.replace(/"/g, '\\"') + '"]:not(.hs-area):not(.no-interact)');
  if (!hs && typeof _OBJS !== 'undefined') {
    for (var _i = 0; _i < _OBJS.length; _i++) {
      if (_OBJS[_i] && _OBJS[_i].lb === name) {
        var _c = document.querySelector('.hotspot[data-oi="' + _i + '"]:not(.hs-area):not(.no-interact)');
        if (_c) { hs = _c; break; }
      }
    }
  }
  return hs || null;
}

// Original (export/Supabase-baked) marker for an object, converted to _applyMarkerDom's input domain.
function _tmOrigMk(oi) {
  var raw = (typeof _OBJS !== 'undefined' && _OBJS[+oi] && _OBJS[+oi].marker) || '';
  return raw === '...' ? '💬' : raw;
}

async function _tmMarkerCmd(args) {
  var sub = (args[0] || '').toLowerCase();

  if (sub === 'set') {
    var rest = args.slice(1).join(' ').trim();
    var m = rest.match(/^([\s\S]+?)\s+([?!~-])$/);
    if (!m) {
      _tmL('ter', 'გამოყენება: /marker set <სახელი> ?|!|~|-');
      _tmL('tdm', '?ქუესტი  !აღებული  ~ჩატი(...)  -ნეიტრალური(•)');
      return;
    }
    var name = m[1].trim(), sym = m[2];
    var hs = _tmFindHotspot(name);
    if (!hs) { _tmL('ter', 'ობიექტი ვერ მოიძებნა: "' + name + '"'); return; }
    _applyMarkerDom(hs, _TM_MK_SYM[sym]);
    _tmL('tok', name + ' — მარკერი "' + sym + '" (ლოკალური, მხ. შენ)');
    return;
  }

  if (sub === 'reset') {
    var name2 = args.slice(1).join(' ').trim();

    if (!name2) {
      try {
        var s = JSON.parse(localStorage.getItem(_MK_KEY) || '{}');
        _mkRestoring = true;
        Object.keys(s).forEach(function (oi) {
          var el = document.querySelector('.hotspot[data-oi="' + oi + '"]:not(.hs-area)');
          if (el) _applyMarkerDom(el, _tmOrigMk(oi));
        });
        _mkRestoring = false;
        localStorage.removeItem(_MK_KEY);
        _tmL('tok', 'ყველა მარკერი — საწყის მდგომარეობაზე დაბრუნდა');
      } catch (e) { _mkRestoring = false; _tmL('ter', 'შეცდომა: ' + e.message); }
      return;
    }

    var hs2 = _tmFindHotspot(name2);
    if (!hs2) { _tmL('ter', 'ობიექტი ვერ მოიძებნა: "' + name2 + '"'); return; }
    var oi2 = hs2.dataset.oi;
    _mkRestoring = true;
    _applyMarkerDom(hs2, _tmOrigMk(oi2));
    _mkRestoring = false;
    try {
      var s2 = JSON.parse(localStorage.getItem(_MK_KEY) || '{}');
      delete s2[oi2];
      localStorage.setItem(_MK_KEY, JSON.stringify(s2));
    } catch (e) {}
    _tmL('tok', name2 + ' — საწყის მდგომარეობაზე დაბრუნდა');
    return;
  }

  _tmL('ter', 'გამოყენება: /marker set|reset <სახელი> [?|!|~|-]');
}

// ── /შეტყობინება — direct send to Supabase `notifications` table ──
// type chars match bulk-parser.js _NOTIFY_TYPES:  * info  ! warning  ~ danger  + project  . done
var _TM_NOTIFY_TYPES = { '*': 'info', '!': 'warning', '~': 'danger', '+': 'project', '.': 'done', '^': 'consensus', '': 'info' };
var _TM_NOTIFY_SYMS  = { info: '💬', warning: '⚠', danger: '❗', done: '✅', project: '🚀', consensus: '🗳' };

// Vote-capable types: they all share the ::detail / ##N(quorum) / {ბრძანება} syntax
// and post through the same consensus_votes pipeline — only the wording of the
// "opened" confirmation and the yes/no outcome differ per type.
var _TM_VOTE_TYPES = { consensus: true, project: true, done: true };
var _TM_NOTIFY_VOTE_LABEL = {
  consensus: { open: 'კონსენსუსი გაიხსნა',             yes: 'თანხმობა',  no: '' },
  project:   { open: 'პროექტის ხმის მიცემა გაიხსნა',   yes: 'მიღებულია', no: 'უარყოფილია' },
  done:      { open: 'დასრულების ხმის მიცემა გაიხსნა', yes: 'დასრულდა',  no: 'არ დასრულებულა' }
};

async function _tmNotify(typeChar, rest) {
  rest = (rest || '').trim();
  var viaModal = false, modalDetail = '';
  if (!rest) {
    if (typeof window.showNotifyFormModal !== 'function') {
      _tmL('tnf', 'გამოყენება: /შეტყობინება[*!~+.^] ტექსტი [@@ზონა]');
      _tmL('tdm', '*ინფო  !გაფრთხ.  ~საფრთხე');
      _tmL('tdm', 'ხმის მიცემა: /შეტყობინება[^+.] კითხვა [::დეტალი] [##N] [@@ზონა] [{ბრძანება}]');
      _tmL('tdm', '  ^კონსენსუსი(თანხმობა) · +პროექტი(მიღებულია/უარყოფილია) · .დასრულება(დასრულდა/არ დასრულებულა)');
      _tmL('tdm', '  {ბრძანება} — quorum-ის მიღწევისას (დადებითი შედეგისას) გაეშვება window.tmRun()-ით');
      return;
    }
    // Popup path — used both for a person typing bare "/შეტყობინება^" AND for
    // a low-tier macro that bundles "/შეტყობინება^" without hardcoding the
    // request text. Name is automatic (shown in the popup, never re-typed).
    var typeLabel = { '*': 'ინფო', '!': 'გაფრთხილება', '~': 'საფრთხე', '^': 'კონსენსუსი', '+': 'პროექტი', '.': 'დასრულება', '': 'ინფო' }[typeChar] || 'ინფო';
    var fres = await window.showNotifyFormModal({ title: 'შეტყობინება (' + typeLabel + ')' });
    if (!fres) { _tmL('tdm', 'გაუქმდა'); return; }
    rest = (fres.text || '').trim();
    modalDetail = (fres.detail || '').trim();
    viaModal = true;
    if (!rest) { _tmL('ter', 'ტექსტი ცარიელია'); return; }
  }

  // optional {terminal_cmd} field — consensus-only, but stripped for every type so the
  // braces never leak into the notification text. MUST be extracted before @@area, since
  // area's trailing match is greedy to end-of-string and would otherwise swallow "{...}".
  var cmdField = '';
  var cmdM = rest.match(/\{([^}]*)\}/);
  if (cmdM) {
    cmdField = cmdM[1].trim();
    rest = rest.replace(/\s*\{[^}]*\}/, '').trim();
    if (cmdField && cmdField.charAt(0) !== '/') cmdField = '/' + cmdField; // tmRun requires leading "/"
  }

  // optional trailing @@area
  var area = '';
  var areaM = rest.match(/^(.*?)\s*@@(.+?)\s*$/);
  if (areaM) { area = areaM[2].trim(); rest = areaM[1].trim(); }

  var type   = _TM_NOTIFY_TYPES[typeChar] || 'info';
  var sym    = _TM_NOTIFY_SYMS[type];
  var sender = (typeof window.myDisplayName === 'function') ? window.myDisplayName()
             : (localStorage.getItem('mdelo_sender') || (typeof _CFG !== 'undefined' && _CFG && _CFG.title) || 'ანონიმი');

  // ── vote branch: consensus ^ / project + / done . ──
  // All three share identical parsing and Supabase payload shape; only the
  // confirmation wording (via _TM_NOTIFY_VOTE_LABEL) differs per type.
  if (_TM_VOTE_TYPES[type]) {
    // /შეტყობინება[^+.] კითხვა [::დეტალი] [##N] [@@ზონა] [{ბრძანება}]
    // {ბრძანება} already stripped above (before @@area extraction) into cmdField.
    // Parse order here: ##N first (from full rest), then ::detail, so neither swallows the other.
    var detail = '', quorum = null;

    if (viaModal) {
      // popup already collected the detail directly — no "::" to re-parse
      detail = modalDetail;
    } else {
      // 1. Extract ##N from anywhere in rest
      var qM = rest.match(/##(\d+)/);
      if (qM) { quorum = parseInt(qM[1]); rest = rest.replace(/\s*##\d+/, '').trim(); }

      // 2. Extract ::detail (everything after first "::")
      var dcIdx = rest.indexOf('::');
      if (dcIdx !== -1) { detail = rest.slice(dcIdx + 2).trim(); rest = rest.slice(0, dcIdx).trim(); }
    }

    if (!rest) { _tmL('ter', 'ხმის მიცემა: კითხვა ცარიელია'); return; }

    // No explicit ##N given (typed or popup path alike) — fall back to the
    // dynamic quorum formula: every resident + every shadow_admin must agree.
    if (!quorum && typeof window.consensusQuorumCount === 'function') {
      quorum = await window.consensusQuorumCount();
    }

    var body = { type: type, symbol: sym, text: rest, sender: sender, linked_area: area };
    if (detail)   body.detail       = detail;
    if (quorum)   body.quorum_count = quorum;
    if (cmdField) body.terminal_cmd = cmdField;

    try {
      var r = await fetch(SUPA_URL + '/rest/v1/notifications', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHeaders()),
        body: JSON.stringify(body)
      });
      if (r.ok) {
        var vl = _TM_NOTIFY_VOTE_LABEL[type] || _TM_NOTIFY_VOTE_LABEL.consensus;
        _tmL('tok', sym + ' ' + vl.open + ': ' + rest + (quorum ? '  (quorum: ' + quorum + ')' : '') + (cmdField ? '  ⚙ ' + cmdField : ''));
        if (typeof loadNotifs === 'function') loadNotifs();
      } else { _tmL('ter', 'შეცდომა: ' + r.status); }
    } catch (e) { _tmL('ter', 'კავშირის შეცდომა'); }
    return;
  }

  // ── standard notification branch (info / warning / danger) ──
  if (!rest) { _tmL('ter', 'ტექსტი ცარიელია'); return; }
  if (cmdField) _tmL('tdm', '{ბრძანება} მუშაობს მხოლოდ ^/+/. ტიპებზე — იგნორირებულია');
  var stdBody = { type: type, symbol: sym, text: rest, sender: sender, linked_area: area };
  if (viaModal && modalDetail) stdBody.detail = modalDetail;
  try {
    var r2 = await fetch(SUPA_URL + '/rest/v1/notifications', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHeaders()),
      body: JSON.stringify(stdBody)
    });
    if (r2.ok) {
      _tmL('tok', sym + ' შეტყობინება გაიგზავნა');
      if (typeof loadNotifs === 'function') loadNotifs();
    } else { _tmL('ter', 'შეცდომა: ' + r2.status); }
  } catch (e) { _tmL('ter', 'კავშირის შეცდომა'); }
}
function _tmVada(args) {
  var n = parseInt(args[0]);
  if (!args.length || isNaN(n) || n < 1 || n > 365) {
    var cur = Math.round(_HIST_TTL / 86400000);
    _tmL('tnf', 'ამჟამინდელი ვადა: ' + cur + ' დღე');
    _tmL('tdm', 'გამოყენება: /ვადა [1–365]');
    return;
  }
  _HIST_TTL = n * 86400000;
  try { localStorage.setItem(_HIST_TTL_KEY, String(n)); } catch (e) {}
  _tmL('tok', 'ისტორიის ვადა: ' + n + ' დღე');
}

// ── dialogue DSL editor ──

// Open DSL edit mode for an object
function _tmDlgEdit(args) {
  var title = args.join(' ').trim();
  if (!title) {
    _tmL('ter', 'გამოყენება: /დიალოგი [ობიექტის სახელი]');
    _tmL('tdm', 'სია: /ობიექტები');
    return;
  }

  // verify object exists — try data-title first, then obj.lb (renamed objects)
  var hs = document.querySelector('.hotspot[data-title="' + title.replace(/"/g, '\\"') + '"]:not(.hs-area):not(.no-interact)');
  if (!hs && typeof _OBJS !== 'undefined') {
    for (var _i = 0; _i < _OBJS.length; _i++) {
      if (_OBJS[_i] && _OBJS[_i].lb === title) {
        var _c = document.querySelector('.hotspot[data-oi="' + _i + '"]:not(.hs-area):not(.no-interact)');
        if (_c) { hs = _c; break; }
      }
    }
  }
  if (!hs) {
    _tmL('ter', 'ობიექტი ვერ მოიძებნა: "' + title + '"');
    _tmL('tdm', 'სია: /ობიექტები');
    return;
  }

  // get current DSL (from override or embedded dialogue)
  // always use data-title as Supabase key — not lb (which may differ after rename)
  var objKey = hs.dataset.title;
  var dsl = '';
  if (typeof dlgGetCurrentDsl === 'function') dsl = dlgGetCurrentDsl(objKey);

  // fallback template if no dialogue exists yet
  if (!dsl) {
    dsl = '@0 ' + ((_OBJS && _OBJS[+hs.dataset.oi] && _OBJS[+hs.dataset.oi].lb) || objKey) + '\n\n<> \n\n-> ';
  }

  // switch to multiline mode and load DSL
  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = dsl;
  _tmTaResize();
  _tmEditObj = objKey;
  _tmEditMode = 'dlg';
  _tmEditLabel = (_OBJS && _OBJS[+hs.dataset.oi] && _OBJS[+hs.dataset.oi].lb) || objKey;

  _tmL('tsy', '─── ' + ((_OBJS && _OBJS[+hs.dataset.oi] && _OBJS[+hs.dataset.oi].lb) || objKey) + ' — DSL ──────────────');
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Cancel edit mode without saving
function _tmEditCancel() {
  var label = _tmEditLabel || _tmEditObj;
  _tmEditObj = null;
  _tmEditMode = null;
  _tmEditMenuCtx = null;
  _tmEditLabel = null;
  _tmEditBuf = null;
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();
  _tmL('tdm', label + ' — გაუქმდა');
}

// Save DSL to Supabase and patch _OBJS locally
async function _tmSaveDlg(dsl) {
  var title = _tmEditObj;

  if (typeof parseBulkDSL !== 'function') {
    _tmL('ter', '✗ bulk-parser.js არ არის ჩატვირთული');
    return;
  }

  var result;
  try {
    // strip #? / #! headers before passing to parseBulkDSL
    var _dslClean = (typeof parseUnlockHeaders === 'function') ? parseUnlockHeaders(dsl).dsl.trim() : dsl;
    result = parseBulkDSL(_dslClean || '@0\n');
  } catch (e) {
    _tmL('ter', '✗ DSL შეცდომა: ' + e.message);
    return;
  }

  // parseBulkDSL may return array or { nodes, title, marker }
  var nodes  = Array.isArray(result) ? result : (result && result.nodes ? result.nodes : []);
  var marker = (!Array.isArray(result) && result && result.marker != null) ? result.marker : undefined;
  if (!nodes.length) {
    _tmL('ter', '✗ DSL: კვანძები ვერ მოიძებნა — შეამოწმე ფორმატი');
    return;
  }

  _tmL('tdm', '↑ ' + title + ' — ვინახავ...');

  if (typeof dlgOverrideSave !== 'function') {
    _tmL('ter', '✗ dlgOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }

  var ok = false, okResult = null;
  try {
    okResult = await dlgOverrideSave(title, nodes, dsl); ok = okResult === true;
  } catch (e) {
    _tmL('ter', '✗ Supabase: ' + e.message);
    return;
  }

  if (ok) {
    _tmEditObj = null;
    _tmEditMode = null;
    _tmEditLabel = null;
    _tmEditBuf = null;
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    _tmL('tok', title + ' — შენახულია ✓  (ყველა viewer განახლდება)');
  } else {
    var _em = okResult && okResult.msg ? ('HTTP ' + okResult.status + ': ' + okResult.msg) : 'უცნობი';
    _tmL('ter', '✗ Supabase ' + _em);
    _tmL('tdm', 'DSL textarea-ში რჩება, შეგიძლია კვლავ სცადო');
  }
}

// ── /flag command ──
// Delegates entirely to unlock.js's unlockHandleCmd (set/clear/check/list/reset).
// terminal.js no longer reimplements flag logic — single source of truth in unlock.js.
function _tmFlagDelegate(args) {
  if (typeof unlockHandleCmd !== 'function') {
    _tmL('ter', '/flag: unlock.js არ არის ჩატვირთული'); return;
  }
  unlockHandleCmd(['flag'].concat(args));
}

// ── menu CLI — filesystem-style navigation/editing over _CFG.menu ──
// State lives only in the terminal session (Pure CLI State): navigating with
// /cd never touches the burger menu's own drill-down UI/state (_gmCfg/_gmShowPanel).
// Mutations (/md, /ფოთოლი, /rm) DO mutate _CFG.menu in place — the same object
// the burger menu reads from — and are pushed to Supabase via menuOverrideSave
// (runtime.js) so every viewer sees them on next page load.
var _tmMenuStack = []; // array of node refs, root = []

function _tmMenuCwdNode() { return _tmMenuStack.length ? _tmMenuStack[_tmMenuStack.length - 1] : null; }
function _tmMenuCwdList() {
  var n = _tmMenuCwdNode();
  if (!n) { if (!_CFG.menu) _CFG.menu = []; return _CFG.menu; }
  if (!n.children) n.children = [];
  return n.children;
}
function _tmMenuPathStr() {
  var parts = _tmMenuStack.map(function (n) { return n.title || '(უსახელო)'; });
  return 'root' + (parts.length ? '/' + parts.join('/') : '');
}

function _tmMenuPwd() { _tmL('tnf', _tmMenuPathStr()); }

function _tmMenuLs() {
  var node  = _tmMenuCwdNode();
  var list  = _tmMenuCwdList();
  var items = node ? (node.items || []) : [];
  _tmL('tdm', _SEP);
  _tmL('tsy', _tmMenuPathStr());
  if (!list.length && !items.length) _tmL('tdm', '(ცარიელია)');
  list.forEach(function (n) {
    var hasKids = (n.children && n.children.length) || (n.items && n.items.length);
    _tmL('tnf', (n.icon || '📁') + ' ' + (n.title || '(უსახელო)') + (hasKids ? '/' : ''));
  });
  items.forEach(function (it, idx) {
    var itObj = typeof it === 'string' ? { type: 'text', emoji: '•', label: it } : it;
    if (itObj.type === 'progress') {
      _tmL('tnf', '  [' + idx + '] ინდიკატორი: "' + (itObj.label || '') + '" (' + (itObj.value != null ? itObj.value : 0) + '%)');
    } else {
      var lbl = (itObj.label || '').replace(/\n/g, ' ');
      if (lbl.length > 60) lbl = lbl.slice(0, 60) + '…';
      _tmL('tnf', '  [' + idx + '] ტექსტი: "' + lbl + '"');
    }
  });
  _tmL('tdm', _SEP);
}

function _tmMenuCd(args) {
  var name = args.join(' ').trim();
  if (!name || name === '/') { _tmMenuStack = []; _tmL('tok', _tmMenuPathStr()); return; }
  if (name === '..') {
    if (!_tmMenuStack.length) { _tmL('tnf', 'უკვე root-ში ხარ'); return; }
    _tmMenuStack.pop(); _tmL('tok', _tmMenuPathStr()); return;
  }
  if (name.indexOf('/') >= 0) { _tmMenuCdPath(name); return; }

  var list  = _tmMenuCwdList();
  var found = list.find(function (n) { return (n.title || '').trim() === name; });
  if (!found) { _tmL('ter', 'ვერ მოიძებნა: "' + name + '"'); _tmL('tdm', 'სია: /ls'); return; }
  _tmMenuStack.push(found);
  _tmL('tok', _tmMenuPathStr());
}

// Slash-segmented path: "/a/b/c" (absolute, from root) or "a/b/c" (relative, from cwd).
// ".." is a valid segment too ("../sibling"). Resolved against a throwaway copy of
// the stack first — Unix `cd` semantics: any missing segment aborts the WHOLE move,
// cwd stays exactly where it was (no partial hop).
function _tmMenuCdPath(path) {
  var absolute = path.charAt(0) === '/';
  var segments = path.split('/').map(function (s) { return s.trim(); }).filter(Boolean);
  var stack = absolute ? [] : _tmMenuStack.slice();

  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (seg === '.') continue;
    if (seg === '..') {
      if (!stack.length) {
        _tmL('ter', 'root-ზე მაღლა ასვლა შეუძლებელია — სეგმენტი ' + (i + 1) + '/' + segments.length + ' (".."), cwd უცვლელია');
        return;
      }
      stack.pop();
      continue;
    }
    var topNode  = stack.length ? stack[stack.length - 1] : null;
    var children = topNode ? (topNode.children || []) : (_CFG.menu || []);
    var found = children.find(function (n) { return (n.title || '').trim() === seg; });
    if (!found) {
      _tmL('ter', 'ვერ მოიძებნა: "' + seg + '" (სეგმენტი ' + (i + 1) + '/' + segments.length + ') — cwd უცვლელია');
      return;
    }
    stack.push(found);
  }

  _tmMenuStack = stack;
  _tmL('tok', _tmMenuPathStr());
}

// Detects whether a trailing arg token is a custom icon/emoji override rather
// than part of the name/text itself — short (<=2 unicode chars, covers most
// single emoji incl. variation selectors) and containing no ordinary letters
// or digits, so a real word/number is never mistaken for an icon.
function _tmIsIconToken(tok) {
  if (!tok) return false;
  return Array.from(tok).length <= 2 && !/[a-zA-Zა-ჿ0-9]/.test(tok);
}

async function _tmMenuMd(args) {
  var icon = '📁';
  if (args.length > 1 && _tmIsIconToken(args[args.length - 1])) {
    icon = args[args.length - 1];
    args = args.slice(0, -1);
  }
  var name = args.join(' ').trim();
  if (!name) { _tmL('ter', 'გამოყენება: /md <სახელი> [ემოჯი]'); return; }
  var parent = _tmMenuCwdNode();
  var list   = _tmMenuCwdList();
  if (list.find(function (n) { return (n.title || '').trim() === name; })) {
    _tmL('ter', 'უკვე არსებობს: "' + name + '"'); return;
  }
  var node = { id: 'nd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), icon: icon, title: name, items: [], children: [] };
  list.push(node);
  _tmMenuStack.push(node);
  _tmL('tok', icon + ' ' + name + '  →  ' + _tmMenuPathStr());
  await _tmMenuSaveNode(node.id, { parent_id: parent ? parent.id : null, icon: node.icon, title: node.title, items_json: [] });
}

async function _tmMenuLeaf(args) {
  var sub  = (args[0] || '').trim();
  var node = _tmMenuCwdNode();
  if (!node) { _tmL('ter', 'root-ში ფოთლები არ შეიძლება — /cd <სახელი> შედი სექციაში'); return; }

  if (sub === 'ტექსტი') {
    var rest = args.slice(1);
    var emoji = '•';
    if (rest.length > 1 && _tmIsIconToken(rest[rest.length - 1])) {
      emoji = rest[rest.length - 1];
      rest = rest.slice(0, -1);
    }
    var text = rest.join(' ').trim();
    if (!text) { _tmL('ter', 'გამოყენება: /ფოთოლი ტექსტი <ტექსტი> [ემოჯი]'); return; }
    if (!node.items) node.items = [];
    node.items.push({ type: 'text', emoji: emoji, label: text });
    _tmL('tok', '+ [' + (node.items.length - 1) + '] ' + emoji + ' ტექსტი დაემატა');
    await _tmMenuSaveNode(node.id, { items_json: node.items });
  } else if (sub === 'ინდიკატორი') {
    var rest2  = args.slice(1);
    var emoji2 = '📊';
    if (rest2.length > 1 && _tmIsIconToken(rest2[rest2.length - 1])) {
      emoji2 = rest2[rest2.length - 1];
      rest2 = rest2.slice(0, -1);
    }
    var pct    = parseInt(rest2[rest2.length - 1]);
    var hasPct = !isNaN(pct) && rest2.length > 1;
    var label  = (hasPct ? rest2.slice(0, -1) : rest2).join(' ').trim();
    if (!label) { _tmL('ter', 'გამოყენება: /ფოთოლი ინდიკატორი <სახელი> <%> [ემოჯი]'); return; }
    var val = hasPct ? Math.max(0, Math.min(100, pct)) : 100;
    if (!node.items) node.items = [];
    node.items.push({ type: 'progress', emoji: emoji2, label: label, value: val });
    _tmL('tok', '+ [' + (node.items.length - 1) + '] ' + emoji2 + ' ინდიკატორი დაემატა (' + val + '%)');
    await _tmMenuSaveNode(node.id, { items_json: node.items });
  } else if (sub === 'todo') {
    var todoSub = (args[1] || '').trim();
    if (todoSub === 'ls') { _tmTodoLs(node); return; }
    var todoIdx = parseInt(todoSub);
    if (!isNaN(todoIdx)) { await _tmTodoToggle(node, todoIdx); return; }
    var todoName = args.slice(1).join(' ').trim();
    if (!todoName) { _tmL('ter', 'გამოყენება: /ფოთოლი todo <სახელი>  ან  /ფოთოლი todo ls  ან  /ფოთოლი todo <N>'); return; }
    if (!node.items) node.items = [];
    node.items.push({ type: 'todo', id: 'todo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), label: todoName, checked: false });
    _tmL('tok', '+ [' + (node.items.length - 1) + '] ⬜ todo დაემატა');
    await _tmMenuSaveNode(node.id, { items_json: node.items });
  } else {
    _tmL('tdm', _SEP);
    _tmL('tsy', '/ფოთოლი ბრძანებები:');
    _tmL('tnf', '  ტექსტი <ტექსტი> [ემოჯი]         — ტექსტური item (default •)');
    _tmL('tnf', '  ინდიკატორი <სახელი> <%> [ემოჯი] — progress item (default 📊)');
    _tmL('tnf', '  todo <სახელი>           — todo item');
    _tmL('tnf', '  todo <N>                — toggle item [N]');
    _tmL('tnf', '  todo ls                 — todos სია ⬜/✅');
    _tmL('tdm', _SEP);
  }
}

// List all todos in current node with checked status
function _tmTodoLs(node) {
  var todos = (node.items || []).filter(function (it) { return it.type === 'todo'; });
  if (!todos.length) { _tmL('tdm', '(todos არ არსებობს)'); return; }
  _tmL('tdm', _SEP);
  todos.forEach(function (todo, idx) {
    var realIdx = node.items.findIndex(function (it) { return it === todo; });
    var status = todo.checked ? '✅' : '⬜';
    _tmL('tnf', '  [' + realIdx + '] ' + status + ' ' + (todo.label || '(უსახელო)'));
  });
  _tmL('tdm', _SEP);
}

// Toggle todo [idx] in current node and sync to Supabase
async function _tmTodoToggle(node, idx) {
  if (!node.items || !node.items[idx] || node.items[idx].type !== 'todo') {
    _tmL('ter', 'todo [' + idx + '] ვერ მოიძებნა — /ფოთოლი todo ls');
    return;
  }
  var todo = node.items[idx];
  todo.checked = !todo.checked;
  var status = todo.checked ? '✅' : '⬜';
  _tmL('tok', '[' + idx + '] ' + status + ' განახლდა');
  await _tmMenuSaveNode(node.id, { items_json: node.items });
  if (typeof window.todoSaveChecked === 'function') {
    await window.todoSaveChecked(node.id, todo.id, todo.checked);
  }
}

async function _tmMenuRm(args) {
  var arg = args.join(' ').trim();
  if (!arg) { _tmL('ter', 'გამოყენება: /rm <სახელი>  ან  /rm <ინდექსი>'); return; }
  var node     = _tmMenuCwdNode();
  var isIndex  = /^\d+$/.test(arg);

  if (isIndex) {
    var idx = parseInt(arg);
    if (!node) { _tmL('ter', 'root-ში items არ არსებობს'); return; }
    if (!node.items || !node.items[idx]) { _tmL('ter', 'item [' + idx + '] ვერ მოიძებნა — /ls'); return; }
    node.items.splice(idx, 1);
    _tmL('tok', '✗ item [' + idx + '] წაიშალა');
    await _tmMenuSaveNode(node.id, { items_json: node.items });
  } else {
    var list = _tmMenuCwdList();
    var fIdx = list.findIndex(function (n) { return (n.title || '').trim() === arg; });
    if (fIdx < 0) { _tmL('ter', 'ვერ მოიძებნა: "' + arg + '" — /ls'); return; }
    var removed = list[fIdx];
    list.splice(fIdx, 1);
    _tmL('tok', '✗ "' + arg + '" — სექცია წაიშალა (ქვე-შემცველობასთან ერთად)');
    await _tmMenuSaveNode(removed.id, { deleted: true });
  }
}

// Edit an existing item in place by index.
//   /edit <N>                          — multiline editor (Ctrl+Enter — შენახვა · Esc — გაუქმება)
//   /edit <N> <ახალი ტექსტი>           — text item: ცვლის label-ს მთლიანად, inline
//   /edit <N> <ახალი ტექსტი> <%>       — progress item: ცვლის label-სა და value-ს ერთად, inline
//   /edit <N> <%>                      — progress item: ცვლის მხოლოდ value-ს, label ხელუხლებელია
async function _tmMenuEdit(args) {
  var node = _tmMenuCwdNode();
  if (!node) { _tmL('ter', 'root-ში items არ არსებობს'); return; }
  var idx = parseInt(args[0]);
  if (isNaN(idx) || !node.items || !node.items[idx]) {
    _tmL('ter', 'გამოყენება: /edit <ინდექსი> [ახალი შინაარსი] — სია: /ls');
    return;
  }
  var rest  = args.slice(1);
  var itObj = typeof node.items[idx] === 'string' ? { type: 'text', emoji: '•', label: node.items[idx] } : node.items[idx];

  if (!rest.length) { _tmMenuEditOpen(node, idx, itObj); return; }

  if (itObj.type === 'progress') {
    var lastIsNum = /^\d+$/.test(rest[rest.length - 1]);
    var label = (lastIsNum ? rest.slice(0, -1) : rest).join(' ').trim();
    if (lastIsNum) itObj.value = Math.max(0, Math.min(100, parseInt(rest[rest.length - 1])));
    if (label) itObj.label = label;
  } else {
    itObj.label = rest.join(' ').trim();
  }

  node.items[idx] = itObj;
  _tmL('tok', '✎ [' + idx + '] განახლდა');
  await _tmMenuSaveNode(node.id, { items_json: node.items });
}

// Serialize an item into editable plain text for the multiline textarea.
// Line 1 is a tagged "[emoji: X]" line so it can't be confused with real
// label content — progress items also keep their value on a trailing "NN%" line.
function _tmMenuItemToEditText(itObj) {
  var emoji = itObj.emoji || (itObj.type === 'progress' ? '📊' : '•');
  var head  = '[emoji: ' + emoji + ']';
  if (itObj.type === 'progress') {
    return head + '\n' + (itObj.label || '') + '\n\n' + (itObj.value != null ? itObj.value : 0) + '%';
  }
  return head + '\n' + (itObj.label || '');
}

// Parse the textarea content back into { emoji, label, value } on save.
// If line 1 isn't a valid "[emoji: X]" tag (e.g. accidentally edited away),
// `fallbackEmoji` (the item's current emoji) is kept instead of guessing —
// nothing gets silently swallowed into the label.
function _tmParseMenuEditText(text, type, fallbackEmoji) {
  var lines = text.split('\n');
  var emoji = fallbackEmoji || (type === 'progress' ? '📊' : '•');
  var tagMatch = /^\[emoji:\s*(.*)\]$/.exec((lines[0] || '').trim());
  if (tagMatch) { emoji = tagMatch[1].trim() || emoji; lines.shift(); }
  var rest = lines;

  if (type === 'progress') {
    while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
    var last  = rest.length ? rest[rest.length - 1].trim() : '';
    var m     = /^(\d{1,3})%?$/.exec(last);
    var value = null, labelLines = rest;
    if (m) { value = Math.max(0, Math.min(100, parseInt(m[1]))); labelLines = rest.slice(0, -1); }
    while (labelLines.length && labelLines[labelLines.length - 1].trim() === '') labelLines.pop();
    return { emoji: emoji, label: labelLines.join('\n').trim(), value: value };
  }
  return { emoji: emoji, label: rest.join('\n').trim(), value: null };
}

// Open the multiline editor for item [idx] of `node`.
function _tmMenuEditOpen(node, idx, itObj) {
  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = _tmMenuItemToEditText(itObj);
  _tmTaResize();
  _tmEditObj     = node.id;
  _tmEditMode    = 'menuItem';
  _tmEditMenuCtx = { node: node, idx: idx, type: itObj.type || 'text' };
  _tmEditLabel   = '[' + idx + '] ' + (node.title || '');

  _tmL('tsy', '─── [' + idx + '] ' + (node.title || '') + ' ──────────────');
  _tmL('tdm', 'ხაზი 1 — [emoji: X], მხოლოდ X გამოცვალე');
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Save the multiline editor content back into the item + push to Supabase.
async function _tmSaveMenuItem(text) {
  var ctx = _tmEditMenuCtx;
  if (!ctx) { _tmEditCancel(); return; }
  var node = ctx.node, idx = ctx.idx;
  if (!node.items || !node.items[idx]) {
    _tmL('ter', '✗ item [' + idx + '] აღარ არსებობს');
    _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null;
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    return;
  }

  var existing      = node.items[idx];
  var currentEmoji  = (existing && typeof existing === 'object' && existing.emoji) ? existing.emoji : (ctx.type === 'progress' ? '📊' : '•');
  var parsed        = _tmParseMenuEditText(text, ctx.type, currentEmoji);
  var itObj         = typeof existing === 'string' ? { type: ctx.type } : existing;
  itObj.type  = ctx.type;
  itObj.emoji = parsed.emoji;
  itObj.label = parsed.label;
  if (ctx.type === 'progress' && parsed.value != null) itObj.value = parsed.value;
  node.items[idx] = itObj;

  var label = _tmEditLabel;
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null;
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();

  _tmL('tdm', '↑ ' + label + ' — ვინახავ...');
  await _tmMenuSaveNode(node.id, { items_json: node.items });
  _tmL('tok', label + ' — შენახულია ✓');
}

// Partial upsert into menu_overrides — only the given fields get written/replaced server-side.
async function _tmMenuSaveNode(nodeId, fields) {
  if (typeof window.menuOverrideSave !== 'function') {
    _tmL('ter', '✗ menuOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var res = await window.menuOverrideSave(nodeId, fields);
  if (res !== true) {
    var em = res && res.msg ? ('HTTP ' + res.status + ': ' + res.msg) : 'უცნობი';
    _tmL('ter', '✗ Supabase: ' + em);
  }
}

// ── macro/shortcut engine ──
// Two scopes:
//   local   — localStorage, this device only, instant, no Supabase round-trip
//   საერთო  — Supabase (terminal_macros table), every viewer sees it on next load
// A macro IS a brand-new command: once saved, typing its exact name (with /) runs
// the whole stored chain. Local scope takes precedence over shared on a name clash.
var _TM_RESERVED = ['macro','marker','cd','md','rm','ls','pwd','edit','ფოთოლი','flag','nick','me','who','color','help',
  'დახმარება','გასუფთავება','ინფო','მასშტაბი','ზონები','ობიექტები','დიალოგი','წასვლა','ლეგენდა','მენიუ','გახსნა','შეყვანა','სრული','ისტორია','ვადა','ტექსტი','შეტყობინება','დახურვა','სია','დაწინაურება','რეჟიმი'];

// Splits a chain on ";" — but only when ";" is followed by "/" (so a stray
// ";" inside ordinary command args is left alone) — PLUS treats any [...]
// block as its own atomic segment: content inside brackets is never split
// on ";" no matter what follows, and the brackets force a boundary on both
// sides. This lets a macro safely carry free-form multi-word content (e.g.
// the body for /edit + /შეყვანა) without it bleeding into a neighboring
// command's args or being torn apart by a literal ";" in the text itself.
//   /edit 0; [თავის ტექსტი; შესაძლოა ; აქაც]; /შეყვანა
function _tmSplitChain(full) {
  var parts = [], buf = '', i = 0, n = full.length;
  while (i < n) {
    var ch = full[i];
    if (ch === '[') {
      if (buf.trim()) parts.push(buf);
      buf = '';
      var j = full.indexOf(']', i + 1);
      if (j === -1) j = n;
      parts.push(full.slice(i + 1, j));
      i = j + 1;
      while (i < n && /[\s;]/.test(full[i])) i++;
      continue;
    }
    if (ch === ';') {
      var rest = full.slice(i + 1).replace(/^\s+/, '');
      if (rest.charAt(0) === '/' || rest.charAt(0) === '[') {
        if (buf.trim()) parts.push(buf);
        buf = '';
        i++;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map(function (s) { return s.trim(); }).filter(Boolean);
}

// Run a list of command strings (each with or without a leading "/") in order,
// awaiting each before starting the next, echoing every step to the log.
async function _tmRunChain(cmds) {
  for (var i = 0; i < cmds.length; i++) {
    var c = (cmds[i] || '').trim();
    if (!c) continue;

    // While an edit session is open (_tmEditObj truthy), a segment that isn't
    // an explicit "/" command is raw content for that session — buffer it for
    // /შეყვანა to submit, instead of force-dispatching it as an unknown command.
    if (_tmEditObj && c.charAt(0) !== '/') {
      _tmEditBuf = c;
      _tmL('ti', c);
      continue;
    }

    if (c.charAt(0) !== '/') c = '/' + c;
    _tmL('ti', c);
    await _tmRun(c);
  }
}

function _tmMacroLocalKey() { return 'mdelo_macro_local_' + ((typeof _CFG !== 'undefined' && _CFG && _CFG.title) || 'map'); }
function _tmMacroLocalAll() {
  try { return JSON.parse(localStorage.getItem(_tmMacroLocalKey()) || '{}'); } catch (e) { return {}; }
}
function _tmMacroLocalSave(all) {
  try { localStorage.setItem(_tmMacroLocalKey(), JSON.stringify(all)); return true; } catch (e) { return false; }
}

// Best-effort extraction of the "command key" _TM_MIN_TIER checks against,
// from a raw bundled command string (e.g. "/შეტყობინება^ text" → "შეტყობინება").
// Mirrors the special-cased matches _tmRun itself uses, before falling back
// to "first token after the slash".
function _tmCmdKeyFor(cmdStr) {
  var c = (cmdStr || '').replace(/^\//, '');
  if (/^todo\//.test(c)) return 'todo';
  if (/^შეტყობინება/.test(c)) return 'შეტყობინება';
  return c.split(/\s+/)[0] || '';
}

// Exact-name lookup across both scopes. Returns { commands: [...], minTier }
// or null. Local macros never carry an elevation tier — they're personal,
// self-run, and already naturally bounded by the creator's own access.
function _tmMacroResolve(full) {
  var name = (full || '').trim();
  if (!name) return null;
  var locals = _tmMacroLocalAll();
  if (locals[name]) return { commands: locals[name], minTier: null };
  var shared = window._tmMacroShared && window._tmMacroShared[name];
  if (shared) return { commands: shared.commands || [], minTier: shared.min_tier || null };
  return null;
}

// /macro local|საერთო <სახელი> := cmd1 ; cmd2 ; ...
// /macro ls
// /macro rm local|საერთო <სახელი>
async function _tmMacro(args) {
  var head0 = (args[0] || '').trim();

  if (head0 === 'ls') { _tmMacroLs(); return; }

  if (head0 === 'rm') {
    var scopeWord = (args[1] || '').trim();
    var rmName = args.slice(2).join(' ').trim();
    if (!rmName || (scopeWord !== 'local' && scopeWord !== 'საერთო')) {
      _tmL('ter', 'გამოყენება: /macro rm local|საერთო <სახელი>');
      return;
    }
    if (scopeWord === 'local') {
      var all = _tmMacroLocalAll();
      if (!all[rmName]) { _tmL('ter', 'local მაკრო ვერ მოიძებნა: "' + rmName + '"'); return; }
      delete all[rmName];
      _tmMacroLocalSave(all);
      _tmL('tok', '✗ 🔒 "' + rmName + '" წაიშალა');
    } else {
      if (typeof window.macroOverrideDelete !== 'function') { _tmL('ter', '✗ macroOverrideDelete ვერ მოიძებნა (runtime.js?)'); return; }
      var dres = await window.macroOverrideDelete(rmName);
      if (dres === true) _tmL('tok', '✗ 🌐 "' + rmName + '" წაიშალა');
      else _tmL('ter', '✗ Supabase: ' + (dres && dres.msg ? dres.msg : 'უცნობი'));
    }
    return;
  }

  var raw = args.join(' ');
  var assignIdx = raw.indexOf(':=');
  if (assignIdx < 0) {
    _tmL('tdm', _SEP);
    _tmL('tsy', '/macro ბრძანებები:');
    _tmL('tnf', '  local <სახელი> := cmd1 ; cmd2 ...   — პერსონალური შორთკატი');
    _tmL('tnf', '  საერთო <სახელი> := cmd1 ; cmd2 ...  — გაზიარებული შორთკატი');
    _tmL('tnf', '  საერთო <სახელი>@tier := ...         — (მხოლოდ shadow_admin) tier-whitelist');
    _tmL('tnf', '  ls                                  — ყველა შორთკატის სია');
    _tmL('tnf', '  rm local|საერთო <სახელი>            — წაშლა');
    _tmL('tdm', _SEP);
    return;
  }

  var head = raw.slice(0, assignIdx).trim();
  var body = raw.slice(assignIdx + 2).trim();
  var headParts = head.split(/\s+/);
  var scope = headParts[0];
  var namePart = headParts.slice(1).join(' ').trim();

  if (scope !== 'local' && scope !== 'საერთო') {
    _tmL('ter', 'მითხარი scope: /macro local <სახელი> := ...  ან  /macro საერთო <სახელი> := ...');
    return;
  }

  // optional "@tier" suffix — ONLY meaningful for საერთო, and only ever
  // takes effect if the DB trigger also agrees the caller is shadow_admin
  // (client-side check here is just to fail fast, not the real guard).
  var name = namePart;
  var minTier = null;
  var atIdx = namePart.indexOf('@');
  if (atIdx >= 0) {
    name = namePart.slice(0, atIdx).trim();
    minTier = namePart.slice(atIdx + 1).trim();
    if (scope !== 'საერთო') {
      _tmL('ter', '✗ "@tier" მხოლოდ საერთო მაკროებზეა შესაძლებელი');
      return;
    }
    if (['visitor', 'caretaker', 'resident', 'shadow_admin'].indexOf(minTier) < 0) {
      _tmL('ter', '✗ უცნობი tier: "' + minTier + '" — visitor/caretaker/resident/shadow_admin');
      return;
    }
    if (typeof window.myTier !== 'function' || window.myTier() !== 'shadow_admin') {
      _tmL('ter', '✗ მხოლოდ shadow_admin-ს შეუძლია მაკროზე tier-whitelist დაყენება');
      return;
    }
  }

  if (!name) { _tmL('ter', 'სახელი არ მიუთითე'); return; }
  if (_TM_RESERVED.indexOf(name) >= 0) { _tmL('ter', '✗ "' + name + '" დაცული სახელია — სხვა აარჩიე'); return; }

  // Bracket-aware split — same splitter live chains use (_tmSplitChain), NOT
  // a naive split(';'). A naive split tears apart any bundled command whose
  // own text contains a literal ";" (an /edit body, or plain Georgian prose),
  // which is why saved macros were coming out broken/malformed.
  var commands = _tmSplitChain(body).map(function (c) { return c.charAt(0) === '/' ? c : '/' + c; });
  if (!commands.length) { _tmL('ter', 'ბრძანებების ჩამონათვალი ცარიელია'); return; }

  // shared macros bundle only what the CREATOR already has standalone
  // access to — a macro is never a way to author your own escalation and
  // hope shadow_admin blesses it blind; shadow_admin's own macros trivially
  // pass this, since shadow_admin has access to everything.
  if (scope === 'საერთო') {
    for (var ci = 0; ci < commands.length; ci++) {
      var key = _tmCmdKeyFor(commands[ci]);
      if (_tmTierDenied(key)) {
        _tmL('ter', '✗ ვერ შეინახება — "' + commands[ci] + '" შენს tier-ს სცდება ("' + _TM_MIN_TIER[key] + '" სჭირდება)');
        return;
      }
    }
  }

  if (scope === 'local') {
    var locAll = _tmMacroLocalAll();
    locAll[name] = commands;
    _tmMacroLocalSave(locAll);
    _tmL('tok', '🔒 "' + name + '" შენახულია (' + commands.length + ' ბრძანება)');
  } else {
    if (typeof window.macroOverrideSave !== 'function') { _tmL('ter', '✗ macroOverrideSave ვერ მოიძებნა (runtime.js?)'); return; }
    var sres = await window.macroOverrideSave(name, commands, minTier);
    if (sres === true) {
      _tmL('tok', '🌐 "' + name + '" შენახულია — ყველა viewer-ს ეჩვენება' + (minTier ? ' (whitelist: ' + minTier + '+)' : ''));
    } else {
      _tmL('ter', '✗ Supabase: ' + (sres && sres.msg ? sres.msg : 'უცნობი'));
    }
  }
}

function _tmMacroLs() {
  var locals = _tmMacroLocalAll();
  var shared = window._tmMacroShared || {};
  _tmL('tdm', _SEP);
  var any = false;
  Object.keys(locals).forEach(function (n) {
    any = true;
    _tmL('tnf', '🔒 ' + n + '  (' + locals[n].length + ' ბრძანება)');
  });
  Object.keys(shared).forEach(function (n) {
    if (locals[n]) return; // local already shown, and takes precedence
    any = true;
    var s = shared[n];
    var badge = s.min_tier ? ('  🔓' + s.min_tier + '+') : '';
    _tmL('tnf', '🌐 ' + n + '  (' + (s.commands ? s.commands.length : 0) + ' ბრძანება)' + badge);
  });
  if (!any) _tmL('tdm', '(შორთკატები არ არსებობს)');
  _tmL('tdm', _SEP);
}

// Cross-file hook — e.g. a dialogue marker effect can call window.runMacro('name')
// to replay a saved shortcut from inside an NPC conversation. Same min_tier
// gate + scoped elevation as typing the macro name directly in the terminal.
window.runMacro = function (name) {
  var hit = _tmMacroResolve(name);
  if (!hit) { if (typeof _tmL === 'function') _tmL('ter', 'მაკრო ვერ მოიძებნა: "' + name + '"'); return false; }
  if (hit.minTier && !window._tierAtLeast(hit.minTier)) {
    if (typeof _tmL === 'function') _tmL('ter', '✗ "' + name + '" საჭიროებს "' + hit.minTier + '" ან უფრო მაღალ tier-ს');
    return false;
  }
  var wasElevated = _tmMacroElevated;
  if (hit.minTier) _tmMacroElevated = true;
  _tmRunChain(hit.commands).finally(function () { _tmMacroElevated = wasElevated; });
  return true;
};

// Expose raw command/chain execution for runtime.js (consensus terminal_cmd field).
// Accepts a single command or a semicolon-separated chain.
window.tmRun = function (raw) { if (raw) _tmRun(raw); };
