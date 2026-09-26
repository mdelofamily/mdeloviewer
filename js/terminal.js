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
var _tmEditLang = (typeof _mdeloLang !== 'undefined' && _mdeloLang === 'en') ? 'en' : 'ka'; // 'ka' | 'en' — session-wide dialogue/menu edit-language target,
                            // set by /ენა. Drives the prompt text (see _tmApplyLangPrompt) and
                            // will drive .ka/.en field routing in tmSend() once that lands.
var _tmFilesCache = [];    // last /ფაილები result — lets /play & /მუსიკა take an index or filename instead of a full URL
var _tmEditMediaBuf = [];  // [{items:[{type,url,name}...]}...] — files-segments captured via /მედია
                            // during the current 'text' menuItem session; [[მედია:N]] tokens in tmTa
                            // point into this by index. Cleared on every session open/close/save/cancel.
var _TMCMDS = ['/დახმარება','/გასუფთავება','/ინფო','/მასშტაბი','/ზონები','/არე','/ობიექტები','/დიალოგი','/წასვლა','/ლეგენდა','/მენიუ','/გახსნა','/შეყვანა','/სრული','/ისტორია','/ვადა','/ტექსტი','/შეტყობინება','/მარკერი','/დახურვა','/დროშა','/მეტსახელი','/მე','/ვინ','/ფერი','/help','/გზა','/ჩვ','/გად','/md','/წაშ','/რედ','/ფოთოლი','/მაკრო','/ლოგინი','/ლოგაუთი','/სახელი','/სესია','/სია','/იუზერი','/სურვილი','/შენახვა','/ჩატვირთვა','/სინქრონიზაცია','/შესრულება','/play','/მუსიკა','/ფაილები','/ფაილი','/ენა','/სექცია'];

function toggleTerm() { _tmOpen ? closeTerm() : _tmOpen_(); }
function _tmOpen_() {
  _tmOpen = true;
  document.getElementById('mdlTerm').classList.add('open');
  setTimeout(function () { document.getElementById('tmIn').focus(); }, 240);
  if (!_tmBooted) { _tmBooted = true; _tmBoot(); }
}
function closeTerm() {
  if (_tmEditMode === 'area') { _tmAreaCtx = null; if (window.areaPickClear) window.areaPickClear(); }
  // cancel edit mode silently on close
  if (_tmEditObj) { _tmMediaCleanupOnCancel(); _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = []; document.getElementById('tmTa').value = ''; if (_tmMulti) tmToggleMulti(); }
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
  // Session-lock: while an edit session is open (/რედ, /დიალოგი, /ლეგენდა),
  // _tmMenuEditOpen (etc.) already force multiline ON — the toggle button
  // has no legitimate job to do mid-session, and letting it fire would swap
  // to the single-line box, silently dropping the in-progress textarea
  // content while leaving _tmEditObj open underneath (orphaned session).
  if (_tmEditObj) return;
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
    if (_tmEditMode === 'menuItem')  { _tmSaveMenuItem(v); return; }
    if (_tmEditMode === 'menuTitle') { _tmSaveMenuTitle(v); return; }
    if (_tmEditMode === 'legend')    { _tmSaveLegend(v); return; }
    if (_tmEditMode === 'area')      { _tmSaveArea(v); return; }
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
  ta.addEventListener('input', function () {
    if (_tmMulti) _tmTaResize(ta);
    if (_tmEditMode === 'menuItem' && _tmEditMenuCtx && _tmEditMenuCtx.type === 'text') { _tmMediaCheckTrigger(ta); _tmYoutubeCheckTrigger(ta); }
  });
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
  _tmApplyLangPrompt();
}

// ── /ენა en|ka — session-wide dialogue/menu edit-language target ──
// Persists for the whole terminal session (not just one edit), until switched
// again. Currently drives only the prompt text below; tmSend() will read
// _tmEditLang to route input into .ka/.en fields once that lands.
function _tmApplyLangPrompt() {
  var pr = document.getElementById('tmPr');
  if (pr) pr.textContent = _tmEditLang === 'en' ? '~/mdelo' : '~/მდელო';
}

function _tmLangSwitch(args) {
  var target = (args[0] || '').trim().toLowerCase();
  if (target !== 'en' && target !== 'ka') {
    _tmL('ter', 'გამოყენება: /ენა en|ka — მიმდინარე: ' + _tmEditLang);
    return;
  }
  _tmEditLang = target;
  _tmApplyLangPrompt();
  // /ენა doubles as the visitor-facing display switcher — no separate UI —
  // so switching the edit-target also switches what dialogue/legend/menu
  // render as for THIS session (console access is the switcher).
  if (typeof _mdeloSetLang === 'function') _mdeloSetLang(target);
  _tmL('tok', 'ენა (რედაქტირება + ჩვენება): ' + (target === 'en' ? 'English' : 'ქართული'));
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
  'შესრულება':   'caretaker', // = todo, new name
  'ფოთოლი':      'caretaker', // leaf-level item add (text/indicator/todo) — caretaker's direct write scope
  'დიალოგი':     'resident',  // dialogue DSL authoring
  'არე':         'caretaker', // create/edit/delete map areas (area_overrides) — caretaker and above
  'md':          'resident',  // create menu branch — structural, not leaf
  'rm':          'resident',  // remove menu node — structural
  'წაშ':         'resident',  // = rm, new name
  'edit':        'resident',  // edit menu node/branch
  'რედ':         'resident',  // = edit, new name
  'macro':       'resident',  // author/manage shared macros
  'მაკრო':       'resident',  // = macro, new name
  'play':        'caretaker', // one-shot fullscreen video trigger
  'მუსიკა':      'caretaker', // background music playlist control
  'music':       'caretaker', // = მუსიკა, new name
  'ფაილები':     'caretaker', // list uploaded bucket files
  'files':       'caretaker', // = ფაილები, new name
  'ფაილი':       'resident',  // delete an arbitrary bucket file by index/name (same severity as /rm)
  'სია':         'shadow_admin', // list logged-in users (nickname/name/email/tier)
  'იუზერი':      'shadow_admin', // hard-delete a logged-in user (server re-checks in delete_user RPC)
  'ობიექტი':     'resident'  // place/delete a catalog object on the map (object_overrides)
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
  var isMacroDef = /^(macro|მაკრო)\s+(local|ჩემი|საერთო)\s+/.test(full) && full.indexOf(':=') >= 0;

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
  var todoPathM = full.match(/^(?:todo|შესრულება)\/(.+)$/);
  if (todoPathM) {
    if (_tmTierDenied('todo')) { _tmDenyMsg('todo'); return; }
    var tsegs = todoPathM[1].split('/').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!tsegs.length || !/^\d+$/.test(tsegs[tsegs.length - 1])) {
      _tmL('ter', 'გამოყენება: /შესრულება/სექცია/.../N');
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

  // /სექცია/<სექცია>/.../<სექცია> — edit that section's OWN title (rename in
  // ka, translate in en) — distinct from /md (create) and item-editing.
  var sectionPathM = full.match(/^სექცია\/(.+)$/);
  if (sectionPathM) {
    var ssegs = sectionPathM[1].split('/').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!ssegs.length) { _tmL('ter', 'გამოყენება: /სექცია/სახელი/.../სახელი'); return; }
    _tmMenuTitleEditOpen(ssegs);
    return;
  }

  // ── "/<obj-სახელი> შესვლა" — ინტერიერის სცენაში შესვლა (interior-scenes.js) ──
  // Dynamic-name command: obj/scene name comes FIRST, fixed keyword "შესვლა" last —
  // unlike every other command here, so it's matched before the parts[0]-keyed
  // dispatch table below (which would otherwise treat the name as an unknown cmd).
  // Matches interior_scenes.title_ka against the SAME name used to place/name the
  // outdoor object (objects.interior_scene_id linking is a separate, not-yet-built
  // sub-scope — this name-match is the v1 stand-in).
  var sceneEnterM = full.match(/^(.+?)\s+შესვლა$/);
  if (sceneEnterM) { await _tmSceneEnter(sceneEnterM[1].trim()); return; }

  var parts = full.split(/\s+/), cmd = parts[0], args = parts.slice(1);
  var map = {
    'დახმარება':   _tmHelp,
    'გასუფთავება': tmClear,
    'ინფო':        _tmInfo,
    'მასშტაბი':    _tmZoom,
    'ზონები':      _tmAreas,
    'არე':         _tmArea,
    'ობიექტები':   _tmObjects,
    'ობიექტი':     _tmObjectCmd,
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
    'დროშა':       _tmFlagDelegate,
    'pwd':         _tmMenuPwd,
    'გზა':         _tmMenuPwd,
    'ls':          _tmMenuLs,
    'ჩვ':          _tmMenuLs,
    'cd':          _tmMenuCd,
    'გად':         _tmMenuCd,
    'md':          _tmMenuMd,
    'rm':          _tmMenuRm,
    'წაშ':         _tmMenuRm,
    'edit':        _tmMenuEdit,
    'რედ':         _tmMenuEdit,
    'ფოთოლი':      _tmMenuLeaf,
    'macro':       _tmMacro,
    'მაკრო':       _tmMacro,
    'play':        _tmPlay,
    'მუსიკა':      _tmMusic,
    'music':       _tmMusic,
    'ფაილები':     _tmFiles,
    'files':       _tmFiles,
    'ფაილი':       _tmFileDelete,
    'marker':      _tmMarkerCmd,
    'მარკერი':     _tmMarkerCmd,
    'ლოგინი':      _tmLogin,
    'ლოგაუთი':     _tmLogout,
    'სახელი':      _tmSetName,
    'სტატუსი':     _tmResolveStatus,
    'სესია':       _tmDebug,
    'სია':         _tmUserList,
    'იუზერი':      _tmUserDelete,
    'დაწინაურება': _tmRequestTierUp,
    'სურვილი':     _tmRequestTierUp,
    'შენახვა':     _tmSavePending,
    'ჩატვირთვა':   _tmLoadPending,
    'სინქრონიზაცია': _tmSyncPending,
    'sync':        _tmSyncPending,
    'ენა':         _tmLangSwitch
  };
  var fn = map[cmd];
  if (fn) {
    if (_tmTierDenied(cmd)) { _tmDenyMsg(cmd); return; }
    await fn(args); return;
  }
  if (typeof chatHandleInput === 'function' && chatHandleInput(text)) return;
  _tmL('ter', 'უცნობი ბრძანება: "/' + cmd + '" — სცადე: /დახმარება');
}

// /<obj-სახელი> შესვლა — ინტერიერის სცენაში შესვლა. Tier-შეზღუდვის გარეშე
// (ნებისმიერ ვიზიტორს შეუძლია უკვე დახატულ სცენაში შესვლა/ნახვა — resident+
// მხოლოდ სცენის/hotspot-ის შექმნას/რედაქტირებას ეხება, ცალკე scope-ია).
async function _tmSceneEnter(name) {
  if (!name) { _tmL('ter', 'გამოყენება: /<სახელი> შესვლა'); return; }
  if (typeof window.sceneEnterByTitle !== 'function') {
    _tmL('ter', '✗ sceneEnterByTitle ვერ მოიძებნა (interior-scenes.js?)');
    return;
  }
  var res;
  try { res = await window.sceneEnterByTitle(name); }
  catch (e) { _tmL('ter', '✗ შეცდომა სცენის ჩატვირთვისას'); return; }
  if (res === true) { closeTerm(); }
  else if (res === false) { _tmL('tnf', 'სცენა ვერ მოიძებნა: ' + name); }
  else { _tmL('ter', '✗ ' + ((res && res.error) || 'შეცდომა')); }
}

// ── built-in commands ──
function _tmHelp() {
  var list = [
    ['/დახმარება',        'ბრძანების სია'],
    ['/გასუფთავება',      'კონსოლის გასუფთავება'],
    ['/ინფო',             'რუკის ინფორმაცია'],
    ['/მასშტაბი [N]',     'zoom 0.25–6'],
    ['/ზონები',           'ზონების სია'],
    ['/არე [რედ|წაშ|აღდგენა|შევსება]', 'ზონები კონსოლიდან · /არე დახმარება'],
    ['/ობიექტები',        'ობიექტები + dialogue სტატუსი'],
    ['/ობიექტები კატალოგი', 'დასადებად ხელმისაწვდომი obj-ების სია'],
    ['/ობიექტი დადება <სახელი>', 'კატალოგის obj-ის დადება drag-ით (resident+)'],
    ['/ობიექტი წაშ <სახელი>',    'კონსოლ-obj-ის წაშლა (resident+)'],
    ['/დიალოგი [სახელი]', 'DSL რედაქტირება · Ctrl+Enter შესანახად'],
    ['/<სახელი> შესვლა', 'ინტერიერის სცენაში შესვლა (მაგ. /ბოსტანი შესვლა)'],
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
    ['/მარკერი დაყენება <სახელი> ?/!/~/-', 'მარკერი — ლოკალური (მხ. შენ)'],
    ['/მარკერი გადაყენება [სახელი]', 'მარკერი → საწყისზე (ერთი ან ყველა)'],
    ['/დახურვა',          'დახურვა  [Esc]'],
    ['/დროშა დაყენება/წაშლა/სია', 'flag სისტემა'],
    ['/მეტსახელი სახელი', 'ნიკნეიმის შეცვლა'],
    ['/მე ტექსტი',        '* აქშნის მესიჯი'],
    ['/ვინ',              'ონლაინ სია'],
    ['/ფერი #hex',        'ნიკნეიმის ფერი'],
    ['/გზა',              'მენიუს მიმდინარე გზა'],
    ['/ჩვ',               'მენიუს კვანძის შემცველობა'],
    ['/გად [სახელი|..|/|a/b/c]', 'ნავიგაცია — ერთი ნაბიჯი ან slash-path'],
    ['/md <სახელი> [ემოჯი]', 'ახალი ქვე-სექცია + ავტო-cd (default 📁)'],
    ['/ფოთოლი ტექსტი|ინდიკატორი [ემოჯი]|todo', 'item-ის დამატება მიმდინარე კვანძში'],
    ['/წაშ <სახელი|N>',    'სექციის (სახელით) ან item-ის (ინდექსით) წაშლა'],
    ['/რედ <N>',         'item [N] — multiline რედაქტირება'],
    ['/რედ <N> <...>',   'item [N] — სწრაფი ერთხაზიანი ედიტი'],
    ['/მაკრო ჩემი <სახელი> := ...',  'პერსონალური შორთკატის შექმნა'],
    ['/მაკრო საერთო <სახელი> := ...', 'გაზიარებული შორთკატის შექმნა'],
    ['/მაკრო ჩვ',         'ყველა შორთკატის სია'],
    ['/მაკრო წაშ ჩემი|საერთო <სახელი>', 'შორთკატის წაშლა'],
    ['/play [url|N|სახელი]', 'ვიდეო fullscreen-ში — N ან ფაილის სახელი /ფაილები-ს ბოლო სიიდან, url-ის გარეშე ხსნის ატვირთვის მოდალს'],
    ['/მუსიკა play <url|N|სახელი,...>', 'ფონური playlist, loop — ტოკენების გარეშე ხსნის მოდალს'],
    ['/მუსიკა stop | skip | volume <0-100>', 'მუსიკის კონტროლი'],
    ['/ფაილები [N]', 'bucket-ში ბოლო N ატვირთული ფაილის URL (default 20)'],
    ['/ფაილი წაშ <N|სახელი>', 'ცალკე bucket-ფაილის წაშლა — item-ზე მიბმულობის მიუხედავად'],
    ['/სია', 'დალოგინებული იუზერების სია (მხოლოდ shadow_admin)'],
    ['/იუზერი წაშ <email> [დიახ]', 'იუზერის სრული წაშლა — დიახ-ის გარეშე preview (მხოლოდ shadow_admin)'],
    ['/სურვილი', 'შემდეგი ტიერის თხოვნა კონსენსუსით (სტუმარი→მეურვე, მეურვე→მაცხოვრებელი)'],
    ['/შენახვა [ფაილის სახელი]', 'offline queue-ს გადმოწერა JSON ფაილად (მხოლოდ დაუსინქრონებელი ცვლილებები)'],
    ['/ჩატვირთვა', 'JSON ფაილიდან queue-ს ატვირთვა — ერთვის მიმდინარე queue-ს, ერთი და იმავე target-ის ჩანაწერი გადაიწერება'],
    ['/სინქრონიზაცია', 'queue-ს ხელით სინქრონიზაცია (session-refresh + flush) — automatic reconnect-ის alternative'],
    ['/ენა en|ka', 'რედაქტირების ენის switch — icon prompt-ში (~/mdelo=en, ~/მდელო=ka)'],
    ['/სექცია/ა/ბ', 'მენიუს სექციის საკუთარი სახელის რედაქტირება (rename ka-ში, თარგმანი en-ში)'],
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

function _tmObjects(args) {
  if (args && args[0] && (args[0] === 'კატალოგი' || args[0] === 'catalog')) {
    var cat = (_CFG.custom || []).filter(function (t) { return t.isObject; });
    if (!cat.length) { _tmL('tdm', 'obj-კატალოგი: ცარიელია'); return; }
    _tmL('tdm', _SEP);
    _tmL('tsy', 'obj-კატალოგი  [/ობიექტი დადება <სახელი>]');
    cat.forEach(function (t) {
      _tmL('tnf', '◇ ' + (t.lb || t.id) + '  (' + (t.cols || 1) + '×' + (t.rows || 1) + ')');
    });
    _tmL('tdm', _SEP);
    return;
  }
  var els = document.querySelectorAll('.hotspot:not(.hs-area):not(.no-interact)');
  if (!els.length) { _tmL('tdm', 'ობიექტები: ცარიელია'); return; }
  _tmL('tdm', _SEP);
  _tmL('tsy', 'ობიექტები  [/დიალოგი სახელი — რედაქტირება]');
  els.forEach(function (el) {
    var title = el.dataset.title || '(უსახელო)';
    var oi = el.dataset.oi;
    var obj = (oi != null && typeof _OBJS !== 'undefined' && _OBJS[+oi]) ? _OBJS[+oi] : null;
    var displayName = (obj && typeof _objDisplayName === 'function' ? _objDisplayName(obj) : '') || title;
    var suffix = '';
    if (obj && obj.dialogue && obj.dialogue.length) {
      suffix = ' [💬 ' + obj.dialogue.length + ']';
    }
    _tmL('tnf', '◆ ' + displayName + suffix);
  });
  _tmL('tdm', _SEP);
}

// /ობიექტი დადება <კატალოგის სახელი> — drag-and-drop placement (resident+).
// /ობიექტი წაშ <instance-სახელი>      — hard delete (resident+); დიალოგი ცალკე
//   ბრძანებით ემატება/იცვლება — /დიალოგი <instance-სახელი>, ისევე როგორც baked
//   obj-ებზე (იხ. _dlgTargetByTitle/runtime.js).
async function _tmObjectCmd(args) {
  var sub = (args[0] || '').toLowerCase();

  if (sub === 'დადება') {
    var name = args.slice(1).join(' ').trim();
    if (!name) { _tmL('ter', 'გამოყენება: /ობიექტი დადება <კატალოგის სახელი>'); return; }
    var tile = (_CFG.custom || []).find(function (t) { return t.isObject && (t.lb === name || t.id === name); });
    if (!tile) { _tmL('ter', 'კატალოგში ვერ მოიძებნა: "' + name + '"'); return; }
    if (typeof window.objectPickStart !== 'function') { _tmL('ter', '✗ objectPickStart ვერ მოიძებნა (runtime.js?)'); return; }
    _tmL('tdm', '🖐 ' + (tile.lb || tile.id) + ' — რუკაზე გადაადგილება ჩვეულებრივია, ადგილზე დაიჭირე და გადაათრიე, ✓ დასადებად, ✕ გასაუქმებლად');
    window.objectPickStart(tile, function (pos) {
      var instName = prompt('რა ვუწოდოთ ამ ' + (tile.lb || tile.id) + '-ს?');
      if (instName == null) { _tmL('ter', 'გაუქმდა — სახელი არ იყო მითითებული'); return; }
      instName = instName.trim();
      if (!instName) { _tmL('ter', 'გაუქმდა — სახელი ცარიელია'); return; }
      var objId = 'obj_console_' + Date.now();
      window.objectOverrideSave(objId, {
        tile_id: tile.id, x: pos.x, y: pos.y, cols: tile.cols || 1, rows: tile.rows || 1, title: instName
      }).then(function (res) {
        if (res === true) _tmL('tok', '✓ დაიდო: ' + instName + '  [/დიალოგი ' + instName + ' — დიალოგის მისაბმელად]');
        else _tmL('ter', '✗ ვერ შეინახა' + (res && res.msg ? (' — ' + res.msg) : ''));
      });
    }, function () { _tmL('tdm', 'გაუქმდა'); });
    return;
  }

  if (sub === 'წაშ') {
    var target = args.slice(1).join(' ').trim();
    if (!target) { _tmL('ter', 'გამოყენება: /ობიექტი წაშ <instance-სახელი>'); return; }
    var hs = document.querySelector('.hotspot.hs-object[data-title="' + target.replace(/"/g, '\\"') + '"]');
    if (!hs) { _tmL('ter', 'ვერ მოიძებნა კონსოლ-obj: "' + target + '" (ედიტორის obj-ების წაშლა ამ ბრძანებით არ ხდება)'); return; }
    var objId = hs.dataset.objId;
    var res = await window.objectOverrideDelete(objId);
    if (res === true) _tmL('tok', '✓ წაიშალა: ' + target);
    else _tmL('ter', '✗ ვერ წაიშალა' + (res && res.msg ? (' — ' + res.msg) : ''));
    return;
  }

  if (sub === 'debug') {
    var allEls = document.querySelectorAll('.hs-object');
    if (!allEls.length) { _tmL('ter', 'DOM-ში .hs-object არცერთი არაა — მაშინ /ობიექტი დადება საერთოდ ვერ ინახავს, ან loadObjectOverrides ვერ იტვირთება'); return; }
    _tmL('tdm', _SEP);
    allEls.forEach(function (el) {
      _tmL('tnf', '· title="' + (el.dataset.title || '') + '" cls=[' + el.className + '] obj-id=' + el.dataset.objId + ' tile-id=' + el.dataset.tileId + ' dlg-id=' + (el.dataset.dialogId || '-'));
    });
    _tmL('tdm', _SEP);
    return;
  }

  _tmL('ter', 'გამოყენება: /ობიექტი დადება <სახელი> | /ობიექტი წაშ <სახელი> | /ობიექტი debug');
}

// /ლოგინი — თუ უკვე ხარ ავტორიზებული (access token ახლახან დამოწმებული),
// სტატუსს აჩვენებს. თუ session საერთოდ არ არსებობს, ხსნის combined popup-ს
// (email + სახელი, runtime.js: showLoginModal). ცალკე "/ლოგინი email@x.com"
// ვარიანტი ამოღებულია — არაფერს ამარტივებდა, popup ისედაც ყოველთვის იხსნებოდა.
//
// შუალედური მდგომარეობა — session (refresh_token) არსებობს, მაგრამ
// isLoggedIn() მაინც false-ია — განზრახ ცალკეა გატარებული, არა
// შემთხვევით. ეს ზუსტად ის ვითარებაა, როცა ვინმე ხანგრძლივად ოფლაინაა და
// access token დროულად ამოეწურა: refresh_token ჯერ კიდევ სავსებით
// მართებულია, ონლაინზე დაბრუნებისთანავე ავტომატურად აღდგება — ანუ
// signup-popup-ის ჩვენება აქ არასწორი და შემაშფოთებელია (ისეთი შთაბეჭდილება
// იქმნება, თითქოს ანგარიში დაიკარგა, სინამდვილეში კი არაფერი შეცვლილა).
async function _tmLogin() {
  if (typeof window.isLoggedIn === 'function' && window.isLoggedIn()) {
    _tmL('tok', '✓ ავტორიზებული ხარ, როგორც ' + window.myDisplayName() + '  (tier: ' + window.myTier() + ')');
    return;
  }
  var sess = null;
  try { sess = JSON.parse(localStorage.getItem('mdelo_auth_session') || 'null'); } catch (e) {}
  if (sess && sess.user) {
    _tmL('tdm', '⏳ სესია არსებობს (' + (sess.user.email || sess.user.id) + '), მაგრამ token-ი ამჟამად ვერ დადასტურდა — სავარაუდოდ ოფლაინ ხარ. Refresh_token ხელუხლებელია, ონლაინზე დაბრუნებისთანავე ავტომატურად აღდგება, ახალი login არ სჭირდება.');
    _tmL('tdm', 'tier ლოკალურად კვლავ ' + (typeof window.myTier === 'function' ? window.myTier() : '?') + '-ია — ედიტ-ბრძანებები ჯერ კიდევ უნდა მუშაობდეს.');
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
    if (!r.ok) {
      var errBody = await r.text().catch(function () { return ''; });
      _tmL('tdm', 'tier ცვლილება ჯერ არ დამტკიცებულა (HTTP ' + r.status + ')');
      _tmL('ter', 'Supabase: ' + errBody.slice(0, 200));
      return;
    }
    var data = await r.json();
    if (data && data.ok) {
      _tmL('tok', '✓ tier შეიცვალა — ' + data.tier);
      if (typeof loadNotifs === 'function') loadNotifs();
      if (typeof window.onConsensusResolved === 'function') window.onConsensusResolved(notifId);
    } else {
      _tmL('tdm', 'tier ცვლილება ჯერ არ დამტკიცებულა (' + (data && data.reason ? data.reason : 'უცნობი') + ')');
    }
  } catch (e) { _tmL('ter', 'გამონაკლისი: ' + e.message); }
}

// /სახელი <ახალი სახელი> — შეცვლის display_name-ს ნებისმიერ დროს (არა მხოლოდ
// პირველ login-ზე). სასარგებლოა ზუსტად იმ შემთხვევისთვის, თუ პირველი login-ის
// popup-ში სახელი ცარიელი დარჩა (ძველი ბაგი — Enter email-ის ველში აგზავნიდა
// ფორმას სახელის ველამდე მისვლის გარეშე; ეს ახლა სავალდებულოა, მაგრამ ვინც
// ადრე დარეგისტრირდა ცარიელი სახელით, ამ ბრძანებით გაასწორებს, ლოგაუთის გარეშე).
// /სესია — mobile-friendly stand-in for devtools console; prints the raw
// auth state (session presence, tier row, etc.) straight into the terminal.
// (named /სესია, not /debug — chat.js already owns /debug for its own diagnostics)
// /სესია — debug status dump. /სესია ამოწურვა (testing only, shadow_admin
// affects only their own device) artificially backdates the LOCAL
// session's expires_at, so isLoggedIn()===false can be reproduced on
// demand instead of waiting ~1h for the access token to genuinely expire
// before testing an offline reload — refresh_token/session content itself
// is untouched, only the timestamp used for the local time-check.
async function _tmDebug(args) {
  if (args && (args[0] === 'ამოწურვა' || args[0] === 'expire')) {
    try {
      var s = JSON.parse(localStorage.getItem('mdelo_auth_session') || 'null');
      if (!s) { _tmL('ter', '✗ session ვერ მოიძებნა'); return; }
      s.expires_at = Date.now() - 1000;
      localStorage.setItem('mdelo_auth_session', JSON.stringify(s));
      _tmL('tok', '✓ access token ხელოვნურად "ვადაგასულად" მოინიშნა (testing) — refresh_token უცვლელია. ახლა დახურე/დარელოუდე გვერდი (ონლაინ ან ოფლაინ) და გაუშვი /სესია ისევ.');
    } catch (e) { _tmL('ter', '✗ ' + e.message); }
    return;
  }
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

  // Separate from window._myTier (in-memory, reset on every reload) — this
  // is what's actually sitting in localStorage as the offline-fallback
  // copy. Printing it directly is the fastest way to tell apart "cache was
  // never written" from "cache is fine, restore logic didn't fire".
  if (sess && sess.user) {
    var tcRaw = null;
    try { tcRaw = localStorage.getItem('mdelo_tier_cache_' + sess.user.id); } catch (e) {}
    _tmL('tdm', 'tier-cache (localStorage): ' + (tcRaw || '(ცარიელია — არასდროს ჩაწერილა)'));
  }

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

// ── /იუზერი — shadow_admin only ──
//   /იუზერი წაშ <email>        → preview (nothing is deleted)
//   /იუზერი წაშ <email> დიახ   → hard delete
// All logic (permissions, open-vote block, quorum numbers, the delete itself)
// lives in the `delete_user` SQL RPC (scope-user-removal.md); this only prints.
function _tmUserDeleteUsage() {
  _tmL('tdm', '  /იუზერი წაშ <email>          —  preview (არაფერი იშლება)');
  _tmL('tdm', '  /იუზერი წაშ <email> დიახ     —  სრული წაშლა (შეუქცევადია)');
}

// Prints refusals / errors. Returns true only when the RPC answered ok:true.
function _tmUserDeleteReport(res, email) {
  if (!res) { _tmL('ter', '✗ პასუხი ცარიელია'); return false; }
  // transport / HTTP error: { ok:false, status, msg } — has no .reason
  if (res.ok === false && res.reason === undefined) {
    _tmL('ter', '✗ Supabase: ' + (res.msg || ('status ' + res.status)));
    if (res.status === 404) _tmL('tdm', '(სავარაუდოდ `delete_user` RPC ჯერ არ არსებობს Supabase-ში)');
    return false;
  }
  if (res.ok === false) {
    if (res.reason === 'not_found') {
      _tmL('ter', '✗ იუზერი ვერ მოიძებნა: ' + email);
    } else if (res.reason === 'self') {
      _tmL('ter', '✗ საკუთარი თავის წაშლა აკრძალულია');
    } else if (res.reason === 'target_shadow_admin') {
      _tmL('ter', '✗ shadow_admin-ის წაშლა ამ ბრძანებით აკრძალულია (მხოლოდ ხელით Supabase-ში)');
    } else if (res.reason === 'open_votes') {
      (res.blocking_votes || []).forEach(function (b) {
        var txt = b.text ? '„' + b.text + '"' : '(უტექსტო)';
        if (b.kind === 'approved_pending') {
          _tmL('ter', '✗ დამტკიცებულია, მაგრამ ჯერ არ შესრულებულა: ' + txt + ' (id ' + b.id + ') — გახსენი ეს შეტყობინება და სცადე თავიდან');
        } else {
          _tmL('ter', '✗ ღია კენჭისყრაა: ' + txt + ' (' + b.votes + '/' + b.quorum + ', id ' + b.id + ') — ჯერ დასრულდეს');
        }
      });
    } else {
      _tmL('ter', '✗ უარი: ' + res.reason);
    }
    return false;
  }
  return true;
}

function _tmUserDeletePreview(res) {
  var t = res.target || {}, w = res.will_delete || {}, q = res.quorum || {};
  _tmL('tsy', (t.display_name || '(უსახელო)') + '  ·  ' + (t.email || '?') + '  ·  ' + (t.tier || 'visitor'));
  _tmL('tnf', 'წაიშლება: ანგარიში, tier-ჩანაწერი, ' + (w.own_tier_requests || 0) + ' საკუთარი განაცხადი');
  if (w.votes_kept_anonymized) _tmL('tnf', 'დარჩება (ანონიმურად): ' + w.votes_kept_anonymized + ' ხმა სხვა კენჭისყრებში');
  _tmL('tnf', 'კვორუმი (ახალი კენჭისყრებისთვის): ' + q.before + ' → ' + q.after);
}

async function _tmUserDelete(args) {
  if (args[0] !== 'წაშ' && args[0] !== 'წაშლა') { _tmUserDeleteUsage(); return; }
  var rest = args.slice(1);
  var last = rest[rest.length - 1];
  var confirmed = rest.length > 1 && (last === 'დიახ' || last === 'yes');
  var email = (confirmed ? rest.slice(0, -1) : rest).join(' ').trim();
  if (!email) { _tmUserDeleteUsage(); return; }
  if (typeof window.deleteUser !== 'function') { _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)'); return; }
  if (!navigator.onLine) { _tmL('ter', '✗ ოფლაინ — წაშლას ქსელი სჭირდება'); return; }

  var pv = await window.deleteUser(email, false); // always preview first
  if (!_tmUserDeleteReport(pv, email)) return;
  _tmUserDeletePreview(pv);
  if (!confirmed) { _tmL('tdm', 'დასადასტურებლად: /იუზერი წაშ ' + email + ' დიახ'); return; }

  _tmL('tdm', '↑ წაშლა: ' + email + ' — ვცდი...');
  var res = await window.deleteUser(email, true);
  if (!_tmUserDeleteReport(res, email)) return;
  if (res.mode !== 'deleted') { _tmL('ter', '✗ მოულოდნელი პასუხი (mode: ' + res.mode + ') — არაფერია დადასტურებული'); return; }
  _tmL('tok', '✓ იუზერი წაიშალა: ' + email);
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
      { value: 'caretaker', label: { ka: 'მეურვე', en: 'Caretaker' } },
      { value: 'resident', label: { ka: 'მაცხოვრებელი', en: 'Resident' } }
    ];
  } else if (myTier === 'caretaker') {
    tierOptions = [{ value: 'resident', label: { ka: 'მაცხოვრებელი', en: 'Resident' } }];
  } else {
    _tmL('tdm', 'შენი ტიერიდან (' + myTier + ') აღარაფერი მოითხოვება ავტომატურად ამ გზით.');
    return;
  }
  if (typeof window.showNotifyFormModal !== 'function' || typeof window.requestTierUp !== 'function') {
    _tmL('ter', '✗ auth engine ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var fres = await window.showNotifyFormModal({
    title: (typeof _i18n === 'function' ? _i18n({ ka: 'დაწინაურების განაცხადი', en: 'Promotion request' }) : 'დაწინაურების განაცხადი'),
    tierOptions: tierOptions,
    lockText: true,
    textForTier: function (tier) {
      var lbl = tier === 'caretaker' ? { ka: 'მეურვე', en: 'caretaker' } : { ka: 'მაცხოვრებელი', en: 'resident' };
      return (typeof _i18n === 'function' && _mdeloLang === 'en')
        ? (window.myDisplayName() + ' wants to become ' + lbl.en)
        : (window.myDisplayName() + '-ს სურს გახდეს ' + lbl.ka);
    }
  });
  if (!fres) { _tmL('tdm', 'გაუქმდა'); return; }
  var targetTier = fres.tier || tierOptions[0].value;
  var label = targetTier === 'caretaker' ? 'მეურვე' : 'მაცხოვრებელი';
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

// /შენახვა [ფაილის სახელი] — downloads the current offline pending-queue
// (dialogue/menu/legend edits made while disconnected, not yet synced to
// Supabase) as a portable JSON file. See scope-offline-viewer.md ნაწილი 3:
// this is the escape hatch for when the outage outlasts the refresh_token
// itself and pendingFlush() can no longer authenticate from this device.
function _tmSavePending(args) {
  if (typeof window.pendingExportDownload !== 'function') {
    _tmL('ter', '✗ pendingExportDownload ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var name = (args || []).join(' ').trim();
  if (!name) name = 'mdelo-pending-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  else if (!/\.json$/i.test(name)) name += '.json';
  var res = window.pendingExportDownload(name);
  if (res.ok) _tmL('tok', '✓ ჩამოტვირთულია: ' + name + ' (' + res.count + ' ცვლილება)');
  else _tmL('tdm', 'queue ცარიელია — შესანახი არაფერია');
}

// /ჩატვირთვა — opens the file picker, merges a previously-exported queue
// back into the local pending-queue. Doesn't flush automatically — the
// person still needs to be online + logged in, at which point the normal
// 'online' reconnect handler (runtime.js) or the next natural sync picks
// it up, same as any other queued entry.
async function _tmLoadPending() {
  if (typeof window.pendingImportPrompt !== 'function') {
    _tmL('ter', '✗ pendingImportPrompt ვერ მოიძებნა (runtime.js?)');
    return;
  }
  _tmL('tdm', 'ფაილის არჩევა...');
  var res = await window.pendingImportPrompt();
  if (res.ok) {
    _tmL('tok', '✓ ჩატვირთულია: ' + res.count + ' ცვლილება queue-ში დაემატა');
    if (typeof _MAP_ID !== 'undefined' && res.mapId && res.mapId !== _MAP_ID) {
      _tmL('tdm', '⚠ ფაილი სხვა რუკისთვისაა (' + res.mapId + ') — ' + _MAP_ID + '-ზე მაინც შეინახება queue-ში');
    }
    if (navigator.onLine && typeof window.isLoggedIn === 'function' && window.isLoggedIn() && typeof window.pendingFlush === 'function') {
      _tmL('tdm', '↑ ონლაინ ხარ — ვცდი დაუყოვნებლივ სინქრონიზაციას...');
      var flushRes = await window.pendingFlush();
      if (flushRes.flushed) _tmL('tok', '✓ ' + flushRes.flushed + ' ცვლილება დასინქრონდა');
      if (flushRes.remaining) _tmL('tdm', '⚠ კიდევ ' + flushRes.remaining + ' queue-ში დარჩა');
    }
  } else {
    _tmL('ter', '✗ ' + (res.msg || 'უცნობი შეცდომა'));
  }
}

// /სინქრონიზაცია — manual retry of the offline pending-queue. The
// automatic path (runtime.js's 'online' listener) already does this on
// reconnect, but that DOM event doesn't always fire reliably — the tab may
// have been open already when connectivity actually returned, or a flaky
// mobile network transition never crosses the browser's online/offline
// threshold at all. This lets someone force the same refresh-then-flush
// sequence by hand instead of waiting/reloading the page.
async function _tmSyncPending() {
  if (typeof window.pendingCount !== 'function' || window.pendingCount() === 0) {
    _tmL('tdm', 'queue ცარიელია — დასინქრონებელი არაფერია');
    return;
  }
  if (!navigator.onLine) {
    _tmL('ter', '✗ ჯერ კიდევ ოფლაინ ხარ (' + window.pendingCount() + ' queue-ში)');
    return;
  }
  _tmL('tdm', '↑ სინქრონიზაცია (' + window.pendingCount() + ')...');
  if (typeof _authMaybeRefresh === 'function') await _authMaybeRefresh();
  if (typeof window.isLoggedIn === 'function' && !window.isLoggedIn()) {
    _tmL('ter', '✗ სესია ვადაგასულია — /ლოგინი ხელახლა, ან /შენახვა queue-ს შესანარჩუნებლად');
    return;
  }
  if (typeof window.pendingFlush !== 'function') {
    _tmL('ter', '✗ pendingFlush ვერ მოიძებნა (runtime.js?)');
    return;
  }
  var res = await window.pendingFlush();
  if (res.flushed) _tmL('tok', '✓ ' + res.flushed + ' ცვლილება დასინქრონდა');
  if (res.remaining) {
    var em = res.error && res.error.msg ? (' — ' + res.error.msg) : '';
    _tmL('ter', '⚠ კიდევ ' + res.remaining + ' queue-ში დარჩა' + em);
  } else if (!res.flushed) {
    _tmL('tdm', 'queue ცარიელია');
  }
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
  if (p.dataset.fullRawKa == null) {
    // Nothing from Supabase yet (or an older export baked raw text in) —
    // derive the raw source from what's baked in the DOM (always Georgian,
    // export time), same fallback toggleQuest() uses.
    var derivedRaw = p.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    p.dataset.fullRawKa = derivedRaw;
    p.dataset.fullRawEn = p.dataset.fullRawEn || '';
  }

  if (_tmEditLang === 'en' && !p.dataset.fullRawKa) {
    _tmL('ter', '✗ ჯერ საჭიროა ქართული ლეგენდის შექმნა (/ენა ka), მერე — თარგმნა');
    return;
  }

  // Prefill with the raw source (>>flag syntax intact), not the resolved
  // per-viewer text — otherwise re-editing would silently drop whichever
  // flag blocks didn't match the currently logged-in author's own tier.
  // In en mode this is the en raw text, or the ka raw as a reference/
  // placeholder to translate from if no en exists yet.
  var current = (_tmEditLang === 'en') ? _i18n({ ka: p.dataset.fullRawKa, en: p.dataset.fullRawEn }) : p.dataset.fullRawKa;

  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = current;
  _tmTaResize();
  _tmEditObj   = '__legend__';
  _tmEditMode  = 'legend';
  _tmEditLabel = 'მთავარი ლეგენდა';

  _tmL('tsy', '─── მთავარი ლეგენდა ' + (_tmEditLang === 'en' ? '(EN)' : '') + ' ──────────────');
  if (_tmEditLang === 'en') {
    _tmL('tdm', 'EN რეჟიმი — >>flag ბლოკები არ ითარგმნება ცალკე, მთელი ტექსტი ერთიანად ითარგმნება');
  }
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Save the multiline editor content as the new legend text — updates the
// live popup immediately and pushes the override to Supabase for every viewer.
async function _tmSaveLegend(text) {
  var p = document.getElementById('questPopup');
  var oldKa = p ? (p.dataset.fullRawKa || '') : '';
  var oldEn = p ? (p.dataset.fullRawEn || '') : '';

  var newKa = oldKa, newEn = oldEn;
  if (_tmEditLang === 'en') {
    // Only record as translated if it actually differs from the ka
    // reference shown while editing — an untouched textarea (still
    // showing the ka fallback) must not be saved back as a false
    // "translation", same reasoning as the dialogue merge.
    if (text !== oldKa) newEn = text;
  } else {
    newKa = text; // ka authoritative — full rewrite, flag-blocks and all
  }

  if (p) {
    p.dataset.fullRawKa = newKa;
    p.dataset.fullRawEn = newEn;
    var raw = _i18n({ ka: newKa, en: newEn });
    var resolved = (typeof _legendResolveText === 'function') ? _legendResolveText(raw) : raw;
    p.dataset.full = resolved;
    // Button visibility was frozen at export time (hidden if the map had no
    // description then) — reflect the freshly-saved content now instead.
    var btn = document.getElementById('questBtn');
    if (btn) btn.style.display = (newKa && newKa.trim()) ? '' : 'none';
    if (p.style.display === 'block') {
      p.textContent = '';
      if (typeof _typewriter === 'function') _typewriter(p, resolved, 60); else p.textContent = resolved;
    }
  }

  var label = _tmEditLabel;
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();

  if (typeof window.legendOverrideSave !== 'function') {
    _tmL('ter', '✗ legendOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }
  if (!navigator.onLine) {
    window.pendingAdd('legend', '__legend__', label, { textKa: newKa, textEn: newEn });
    _tmL('tdm', '⚠ ოფლაინ — ' + label + ' ლოკალურად გამოიყენება, queue-შია (' + window.pendingCount() + ')');
    return;
  }
  _tmL('tdm', '↑ ' + label + ' — ვინახავ...');
  var res;
  try { res = await window.legendOverrideSave(newKa, newEn); }
  catch (e) {
    window.pendingAdd('legend', '__legend__', label, { textKa: newKa, textEn: newEn });
    _tmL('ter', '✗ ქსელის შეცდომა — queue-ში ჩავარდა (' + window.pendingCount() + '): ' + e.message);
    return;
  }
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
    node = nodes.find(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, segs[i]); });
    if (!node) { _tmL('ter', 'მენიუში ვერ მოიძებნა: "' + segs[i] + '"'); return null; }
    if (i < segs.length - 1) {
      if (!node.children || !node.children.length) { _tmL('ter', '"' + _i18n(node.title) + '" — ქვესექციები არ აქვს'); return null; }
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
    node = nodes.find(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, segs[i]); });
    if (!node) { _tmL('ter', 'მენიუში ვერ მოიძებნა: "' + segs[i] + '"'); return; }
    if (i < segs.length - 1) {
      if (!node.children || !node.children.length) { _tmL('ter', '"' + _i18n(node.title) + '" — ქვესექციები არ აქვს'); return; }
      path.push({ title: _i18n(node.title), nodes: node.children });
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
    _gmShowPanel(node.children, path.concat([{ title: _i18n(node.title), nodes: node.children }]));
  } else {
    _gmShowPanel(nodes, path);
  }
  _tmL('tok', '☰ → ' + segs.join('/') + (itemIdx != null ? '/' + itemIdx : ''));
}

function _tmOpenCmd() {
  if (!_tmOpen) _tmOpen_();
  _tmL('tok', 'ტერმინალი გახსნილია');
}

// ── /არე — map areas from the console (area_overrides) ──────────────────────────
//   /არე                          new area: console closes, hold to start painting cells like a
//                                 brush (plain swipe = pan), ✓ opens a text editor
//                                 (1st line = name, rest = tooltip)
//   /არე გაუქმება                 abort a pending creation
//   /არე რედ სახელი               edit name/tooltip (ka; in en mode: the translation)
//   /არე სახელი შევსება ფილა ვადა დღე   fill every rectangle of the name with an overlay tile
//                                 for N whole days (resident+); it then disappears by itself
//   /არე წაშ სახელი დიახ          soft-delete the WHOLE area (no DELETE policy); also drops the fill
//   /არე აღდგენა [სახელი | №]     list soft-deleted areas / restore a whole one (deleted=false)
// Areas are found by name — the same key /წასვლა uses. A brush-drawn area is saved as several
// rectangles sharing one name (= one group); edit/fill/delete/restore always act on the whole
// group. Geometry is structural (drawn once); name/tooltip are text. There is no per-rectangle
// addressing and no resize — delete the area and draw it again.
var _tmAreaCtx = null; // { kind:'new', rects:[{x1,y1,x2,y2}] } | { kind:'edit', ids, lang, ka:{label,tip} }

var _TM_AREA_USAGE = [
  ['/არე',                         'ახალი ზონა (ფუნჯით ხატვა რუკაზე)'],
  ['/არე რედ სახელი',              'სახელი/აღწერა (en რეჟიმში — თარგმანი)'],
  ['/არე სახელი შევსება ფილა ვადა დღე', 'ფილით შევსება დღეების ვადით (resident+)'],
  ['/არე წაშ სახელი დიახ',         'მთელი არეს წაშლა (ფილაც იშლება)'],
  ['/არე აღდგენა [სახელი | №]',     'წაშლილი არეს აღდგენა (სია: /არე აღდგენა)'],
  ['/არე გაუქმება',                'მიმდინარე შექმნის გაუქმება']
];
function _tmAreaUsage() { _TM_AREA_USAGE.forEach(function (r) { _tmL('tdm', '  ' + r[0] + '  —  ' + r[1]); }); }

// Every .hs-area rectangle, read from the DOM (same source /ზონები and /წასვლა use).
function _tmAreaRects() {
  var T = (typeof _TS !== 'undefined') ? _TS : 32;
  return [].slice.call(document.querySelectorAll('.hs-area')).map(function (el) {
    var ox = +el.dataset.ox, oy = +el.dataset.oy, ow = +el.dataset.ow, oh = +el.dataset.oh;
    var ft = el.dataset.fillTile || '', fd = +el.dataset.fillDays || 0, fa = el.dataset.filledAt || '';
    var frow = { fill_tile_id: ft || null, fill_days: fd || null, filled_at: fa || null };
    return {
      id: el.dataset.aid || '', ka: el.dataset.title || '', en: el.dataset.titleEn || '',
      tipKa: el.dataset.tooltip || '', tipEn: el.dataset.tooltipEn || '',
      x1: ox / T, y1: oy / T, x2: (ox + ow) / T, y2: (oy + oh) / T,
      // fill overlay: active = set and not yet expired (expiry evaluated in runtime.js)
      fill: { tile: ft, days: fd, at: fa, active: !!(ft && typeof window._areaFillActive === 'function' && window._areaFillActive(frow)) }
    };
  });
}

// Rectangles called `argsArr.join(' ')` (ka or en name) — the whole group. No per-rectangle
// index: an area is always addressed as a whole (a name may even end with a number).
function _tmAreaFind(argsArr) {
  var text = argsArr.join(' ').trim();
  var hits = _tmAreaRects().filter(function (a) { return a.ka === text || (a.en && a.en === text); });
  return { name: text, hits: hits };
}

// Shared guard for edit/fill/delete: found something, every rectangle has an id, network is up.
function _tmAreaTarget(argsArr) {
  if (!argsArr.length) { _tmAreaUsage(); return null; }
  var f = _tmAreaFind(argsArr);
  if (!f.hits.length) { _tmL('ter', '✗ ზონა ვერ მოიძებნა: "' + argsArr.join(' ') + '" (სია: /ზონები)'); return null; }
  if (f.hits.some(function (h) { return !h.id; })) {
    _tmL('ter', '✗ ამ ზონას id არ აქვს (ძველი export) — ედიტორში ხელახლა გააკეთე export, მერე ისევ სცადე'); return null;
  }
  if (typeof window.areaOverrideSaveMany !== 'function') { _tmL('ter', '✗ areaOverrideSaveMany ვერ მოიძებნა (runtime.js?)'); return null; }
  return f;
}
function _tmAreaBox(h) { return '(' + h.x1 + ',' + h.y1 + ')–(' + h.x2 + ',' + h.y2 + ')'; }
function _tmAreaSaveErr(res) {
  return '✗ ვერ შეინახა' + (res && res.status ? ' (' + res.status + ')' : '') + (res && res.msg ? ': ' + res.msg : '');
}

function _tmArea(args) {
  var sub = (args[0] || '').trim(), rest = args.slice(1);
  if (sub === 'გაუქმება' || sub === 'cancel') {
    _tmAreaCtx = null;
    if (typeof window.areaPickClear === 'function') window.areaPickClear();
    _tmL('tdm', 'არეალის შექმნა გაუქმდა');
    return;
  }
  if (_tmEditObj) { _tmL('ter', '✗ ჯერ დახურე ღია edit-სესია (Esc)'); return; }
  // "/არე <სახელი> შევსება <ფილა> ვადა <დღე>" — the name comes first (may be several words), so
  // this is recognised by its tail before the sub-command switch below.
  var fp = _tmAreaFillParse(args);
  if (fp) { _tmAreaFill(fp); return; }
  if (args.indexOf('შევსება') > 0) { _tmL('ter', '✗ გამოყენება: /არე სახელი შევსება ფილა ვადა დღე   (მაგ.: /არე ბაღი შევსება მოცელილი ვადა 18)'); return; }
  if (sub === 'დახმარება' || sub === 'help' || sub === '?')       { _tmAreaUsage(); return; }
  if (sub === 'რედ' || sub === 'რედაქტირება' || sub === 'edit') { _tmAreaEdit(rest); return; }
  if (sub === 'წაშ' || sub === 'წაშლა' || sub === 'rm')          { _tmAreaDelete(rest); return; }
  if (sub === 'აღდგენა' || sub === 'წაშლილები' || sub === 'restore') { _tmAreaRestore(rest); return; }
  if (sub) { _tmL('ter', '✗ უცნობი ქვე-ბრძანება: "' + sub + '"'); _tmAreaUsage(); return; }

  // ── new area ──
  if (_tmEditLang === 'en') { _tmL('ter', '✗ ახალი არეალი ქართულად იქმნება — ჯერ: /ენა ka'); return; }
  if (typeof window.areaPickStart !== 'function') { _tmL('ter', '✗ areaPickStart ვერ მოიძებნა (runtime.js?)'); return; }
  _tmL('tsy', '─── ახალი არეალი ──────────────');
  _tmL('tdm', 'კონსოლი დაიხურება — ხანგრძლივი შეხებით დაიწყე ხატვა (სვიპი ჩვეულებრივ გადააადგილებს რუკას); ✓ — დასრულება');
  closeTerm();
  window.areaPickStart(_tmAreaPicked, function () { _tmOpen_(); _tmL('tdm', 'არეალის შექმნა გაუქმდა'); });
}

// Open the name/tooltip editor for a new (kind:'new') or existing (kind:'edit') area.
function _tmAreaEditorOpen(ctx, label, prefill, lines) {
  _tmAreaCtx = ctx;
  _tmOpen_();
  if (!_tmMulti) tmToggleMulti();          // must run before _tmEditObj is set (it is locked during a session)
  document.getElementById('tmTa').value = prefill;
  _tmTaResize();
  _tmEditObj   = '__area__';
  _tmEditMode  = 'area';
  _tmEditLabel = label;
  _tmL('tsy', '─── ' + label + ' ──────────────');
  lines.forEach(function (l) { _tmL('tdm', l); });
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Drawing finished (✓) for a NEW area: r = { rects:[{x1,y1,x2,y2}], cells:N }. Reopen the console
// with the name/tooltip editor.
function _tmAreaPicked(r) {
  _tmAreaEditorOpen(
    { kind: 'new', rects: r.rects },
    'ახალი არეალი (' + r.cells + ' უჯრა)', '',
    ['უჯრა: ' + r.cells + ' · ნაწილი: ' + r.rects.length,
     'პირველი ხაზი — სახელი · დანარჩენი — აღწერა (tooltip, არასავალდებულო)']);
}

// /არე რედ სახელი — edit name/tooltip of every rectangle with that name.
function _tmAreaEdit(argsArr) {
  var f = _tmAreaTarget(argsArr); if (!f) return;
  var first = f.hits[0], en = (_tmEditLang === 'en');
  var name = en ? (first.en || first.ka) : first.ka;
  var tip  = en ? (first.tipEn || first.tipKa) : first.tipKa;
  var lines = [];
  if (f.hits.length > 1) lines.push(f.hits.length + ' ნაწილი განახლდება ერთად');
  lines.push(en ? 'EN რეჟიმი — ქართულის იდენტური ტექსტი თარგმანად არ შეინახება'
                : 'პირველი ხაზი — სახელი · დანარჩენი — აღწერა (ცარიელი აღწერა = წაიშლება)');
  _tmAreaEditorOpen(
    { kind: 'edit', ids: f.hits.map(function (h) { return h.id; }), lang: en ? 'en' : 'ka', ka: { label: first.ka, tip: first.tipKa } },
    'არეალი: ' + first.ka + (en ? ' (EN)' : ''), name + (tip ? '\n' + tip : ''), lines);
}

// ── /არე სახელი შევსება ფილა ვადა დღე — fill overlay ────────────────────────────
// Fills EVERY rectangle sharing the name (the name is the group) with an overlay tile that
// disappears by itself after N whole days. Visual only (map[][] is untouched). Rules:
//   · resident+ (the rest of /არე is caretaker+)
//   · known tiles only (_TM_FILL_TILES) and the tile must exist in data.js dualTiles
//   · two filled areas may not overlap; unfilled areas overlap freely
//   · running it again on a filled name restarts the timer
//   · there is no "remove fill": delete the area (/არე წაშ) and draw it again
var _TM_FILL_TILES = ['მოცელილი'];   // one tile so far; every future tile gets its own lifetimes
var _TM_FILL_MAX_DAYS = 365;

// args = [name…, 'შევსება', tile…, 'ვადა', days] → { nameArgs, tile, days } | null
function _tmAreaFillParse(args) {
  var n = args.length;
  if (n < 5 || args[n - 2] !== 'ვადა') return null;
  var si = args.lastIndexOf('შევსება', n - 4);   // ≥1 name word before it, ≥1 tile word after it
  if (si < 1) return null;
  return { nameArgs: args.slice(0, si), tile: args.slice(si + 1, n - 2).join(' '), days: args[n - 1] };
}

// Names of ACTIVE filled areas (other than `ownKa`) that overlap any of `rects` (half-open cell boxes).
function _tmAreaFillClash(rects, ownKa) {
  var names = [];
  _tmAreaRects().forEach(function (o) {
    if (!o.fill || !o.fill.active || o.ka === ownKa) return;
    var hit = rects.some(function (r) { return r.x1 < o.x2 && o.x1 < r.x2 && r.y1 < o.y2 && o.y1 < r.y2; });
    if (hit && names.indexOf(o.ka) < 0) names.push(o.ka);
  });
  return names;
}

function _tmAreaFill(fp) {
  if (typeof window._tierAtLeast === 'function' && !window._tierAtLeast('resident')) {
    _tmL('ter', '✗ ფილით შევსება საჭიროებს "resident" ან უფრო მაღალ tier-ს — შენი: ' + (typeof window.myTier === 'function' ? window.myTier() : 'visitor'));
    return;
  }
  if (!/^\d+$/.test(fp.days) || +fp.days < 1 || +fp.days > _TM_FILL_MAX_DAYS) {
    _tmL('ter', '✗ ვადა — მთელი დღეები, 1–' + _TM_FILL_MAX_DAYS + ' (მიიღე: "' + fp.days + '")'); return;
  }
  var days = +fp.days;
  if (_TM_FILL_TILES.indexOf(fp.tile) < 0) {
    _tmL('ter', '✗ უცნობი ფილა: "' + fp.tile + '" — ხელმისაწვდომი: ' + _TM_FILL_TILES.join(', ')); return;
  }
  if (!(_CFG.dualTiles || []).some(function (t) { return t.id === fp.tile; })) {
    _tmL('ter', '✗ ფილა "' + fp.tile + '" data.js-ში არ არის — ედიტორიდან თავიდან export და data.js-ის ატვირთვა'); return;
  }
  var f = _tmAreaTarget(fp.nameArgs); if (!f) return;
  var clash = _tmAreaFillClash(f.hits, f.hits[0].ka);
  if (clash.length) { _tmL('ter', '✗ "' + f.name + '" გადაფარავს ფილიან არეს: ' + clash.join(', ') + ' — ორი ფილიანი არე ვერ გადაფარავს ერთმანეთს'); return; }
  if (!navigator.onLine) { _tmL('ter', '✗ ოფლაინ — შევსებას ქსელი სჭირდება'); return; }
  var now = new Date();
  _tmL('tdm', '↑ ' + f.name + ' — ' + fp.tile + ', ' + days + ' დღე — ვინახავ...');
  window.areaOverrideSaveMany(f.hits.map(function (h) { return h.id; }),
    { fill_tile_id: fp.tile, fill_days: days, filled_at: now.toISOString() }).then(function (res) {
    if (res === true) {
      _tmL('tok', 'არეალი "' + f.name + '" — ' + fp.tile + ' ✓ (' + f.hits.length + ' მართკუთხედი, იწურება: ' +
        new Date(now.getTime() + days * 86400000).toISOString().slice(0, 10) + ')');
    } else _tmL('ter', _tmAreaSaveErr(res));
  }, function (e) { _tmL('ter', _tmAreaSaveErr({ msg: e.message })); });
}

// /არე წაშ სახელი დიახ — soft delete of the whole area (deleted=true). Without the final "დიახ" it only previews.
function _tmAreaDelete(argsArr) {
  var confirmed = argsArr.length > 1 && (argsArr[argsArr.length - 1] === 'დიახ' || argsArr[argsArr.length - 1] === 'yes');
  var nameArgs = confirmed ? argsArr.slice(0, -1) : argsArr;
  var f = _tmAreaTarget(nameArgs); if (!f) return;
  var desc = '"' + f.name + '" — ' + f.hits.length + ' ნაწილი';
  // a filled area loses its fill (tile + lifetime) with it; restoring brings the area back without the fill
  var hasFill = f.hits.some(function (h) { return h.fill && h.fill.tile; });
  var delFields = { deleted: true };
  if (hasFill) { delFields.fill_tile_id = null; delFields.fill_days = null; delFields.filled_at = null; }
  if (!confirmed) {
    _tmL('ter', 'წაიშლება ' + desc + (hasFill ? ' (ფილაც წაიშლება)' : ''));
    _tmL('tdm', 'დასადასტურებლად: /არე წაშ ' + nameArgs.join(' ') + ' დიახ');
    return;
  }
  if (!navigator.onLine) { _tmL('ter', '✗ ოფლაინ — წაშლას ქსელი სჭირდება'); return; }
  _tmL('tdm', '↑ წაშლა: ' + desc + ' — ვინახავ...');
  window.areaOverrideSaveMany(f.hits.map(function (h) { return h.id; }), delFields).then(function (res) {
    if (res === true) _tmL('tok', 'არეალი "' + f.name + '" — წაშლილია ✓ (აღდგენა: deleted=false Supabase-ში)');
    else _tmL('ter', _tmAreaSaveErr(res));
  }, function (e) { _tmL('ter', _tmAreaSaveErr({ msg: e.message })); });
}

// /არე აღდგენა — no args: list soft-deleted areas (one line per AREA, not per rectangle); with a
// name (ka or en) or a list number: restore that whole area (deleted=false). A restored area comes
// back WITHOUT its fill. Realtime shows it to every open viewer.
function _tmAreaRestore(argsArr) {
  var list = (typeof window.areaDeletedList === 'function') ? window.areaDeletedList() : [];
  if (typeof window.areaOverrideSaveMany !== 'function') { _tmL('ter', '✗ areaOverrideSaveMany ვერ მოიძებნა (runtime.js?)'); return; }
  if (!list.length) { _tmL('tdm', 'წაშლილი არეალი არ არის'); return; }
  // group the deleted rectangles by name — a brush-drawn area is many rows
  var groups = [], gi = {};
  list.forEach(function (a) {
    var key = a.label || ('#' + a.id);
    if (!Object.prototype.hasOwnProperty.call(gi, key)) { gi[key] = groups.length; groups.push({ label: a.label, en: a.en, hits: [] }); }
    groups[gi[key]].hits.push(a);
  });
  var text = argsArr.join(' ').trim();
  if (!text) {
    _tmL('tsy', '─── წაშლილი არეალები ──────────────');
    groups.forEach(function (g, i) { _tmL('tdm', '  ' + (i + 1) + ': ' + (g.label || '(უსახელო)') + ' (' + g.hits.length + ' ნაწილი)'); });
    _tmL('tdm', 'აღსადგენად: /არე აღდგენა სახელი  ან  /არე აღდგენა №');
    return;
  }
  var g = groups.filter(function (x) { return x.label === text || (x.en && x.en === text); })[0];
  if (!g && /^\d+$/.test(text)) {
    var k = +text;
    if (k < 1 || k > groups.length) { _tmL('ter', '✗ სიაში ' + groups.length + ' წაშლილია (მოითხოვე: ' + k + ')'); return; }
    g = groups[k - 1];
  }
  if (!g) { _tmL('ter', '✗ წაშლილებში ვერ მოიძებნა: "' + text + '" (სია: /არე აღდგენა)'); return; }
  if (!navigator.onLine) { _tmL('ter', '✗ ოფლაინ — აღდგენას ქსელი სჭირდება'); return; }
  var desc = '"' + (g.label || '(უსახელო)') + '" — ' + g.hits.length + ' ნაწილი';
  _tmL('tdm', '↑ აღდგენა: ' + desc + ' — ვინახავ...');
  window.areaOverrideSaveMany(g.hits.map(function (h) { return h.id; }), { deleted: false }).then(function (res) {
    if (res === true) _tmL('tok', 'არეალი აღდგენილია ✓ ' + desc + ' (ფილის გარეშე)');
    else _tmL('ter', _tmAreaSaveErr(res));
  }, function (e) { _tmL('ter', _tmAreaSaveErr({ msg: e.message })); });
}

// Save from the editor (new or edit). Any failure keeps the editor and its text open, so the
// same Ctrl+Enter can simply be retried; the session closes only on success.
async function _tmSaveArea(text) {
  var c = _tmAreaCtx;
  if (!c) { _tmEditCancel(); return; }
  var lines = text.split('\n');
  var label = lines[0].trim();
  var tip = lines.slice(1).join('\n').trim();
  var ids, fields, dup = false, inherited = false;

  var items = null;   // new area: [{ id, fields }] — one row per rectangle
  if (c.kind === 'new') {
    if (!label) { _tmL('ter', '✗ სახელი ცარიელია — პირველ ხაზზე ჩაწერე არეალის სახელი'); return; }
    dup = _tmAreaRects().some(function (a) { return a.ka === label; });
    // every row carries the SAME keys (PostgREST bulk insert requires it)
    var common = { label: label };
    if (tip) common.tooltip = tip;
    // same name = same group: an active fill of the group extends to the new rectangles (same tile,
    // same filled_at, so the whole group expires together) — unless it would overlap another filled area
    var grp = _tmAreaRects().filter(function (a) { return a.ka === label && a.fill && a.fill.active; });
    if (grp.length) {
      var clash = _tmAreaFillClash(c.rects, label);
      if (clash.length) {
        _tmL('ter', '✗ ახალი არეალი გადაფარავს ფილიან არეს: ' + clash.join(', ') + ' — შეცვალე სახელი (ფილის გარეშე შეინახება) ან Esc და თავიდან დახატე');
        return;
      }
      common.fill_tile_id = grp[0].fill.tile; common.fill_days = grp[0].fill.days; common.filled_at = grp[0].fill.at;
      inherited = true;
    }
    var stamp = Date.now();
    items = c.rects.map(function (rc, i) {
      return { id: 'area_' + stamp + '_' + ('00' + i).slice(-3),
               fields: Object.assign({ x1: rc.x1, y1: rc.y1, x2: rc.x2, y2: rc.y2 }, common) };
    });
    ids = items.map(function (it) { return it.id; });
  } else if (c.lang === 'en') {
    // Only what differs from the ka reference shown while editing counts as a translation —
    // an untouched field must never be saved back as a false one (same rule as legend/dialogue).
    ids = c.ids; fields = {};
    if (label !== c.ka.label) fields.label_en = label;
    if (tip !== c.ka.tip) fields.tooltip_en = tip;
    if (!Object.keys(fields).length) {
      _tmAreaSessionClose();
      _tmL('tdm', 'ცვლილება არ არის — ტექსტი ქართულის იდენტურია, თარგმანად არ შეინახა');
      return;
    }
  } else {
    if (!label) { _tmL('ter', '✗ სახელი ცარიელია — პირველ ხაზზე ჩაწერე არეალის სახელი'); return; }
    ids = c.ids; fields = { label: label, tooltip: tip };
  }

  if (typeof window.areaOverrideSaveMany !== 'function' || (items && typeof window.areaOverrideSaveRows !== 'function')) { _tmL('ter', '✗ areaOverrideSaveMany/SaveRows ვერ მოიძებნა (runtime.js?)'); return; }
  if (!navigator.onLine) { _tmL('ter', '✗ ოფლაინ — შენახვას ქსელი სჭირდება (ტექსტი რედაქტორშია)'); return; }
  _tmL('tdm', '↑ ' + (label || c.ka.label) + ' — ვინახავ...');
  var res;
  try { res = items ? await window.areaOverrideSaveRows(items) : await window.areaOverrideSaveMany(ids, fields); }
  catch (e) { res = { ok: false, status: 0, msg: e.message }; }

  if (res !== true) { _tmL('ter', _tmAreaSaveErr(res) + ' — ტექსტი რედაქტორშია, სცადე ისევ Ctrl+Enter'); return; }
  _tmAreaSessionClose();
  if (c.kind === 'new') {
    _tmL('tok', 'არეალი "' + label + '" — შენახულია ✓ (ყველა viewer-ს ეჩვენება)' + (items && items.length > 1 ? ' · ' + items.length + ' ნაწილი' : '') + (inherited ? ' · ჯგუფის ფილა გავრცელდა' : ''));
    if (dup) _tmL('tdm', 'ℹ ამ სახელით არეალი უკვე არსებობდა — ისინი ერთ ჯგუფად ჩაითვლება (ერთად ინათებს, /წასვლა ორივეს პოულობს)');
  } else {
    _tmL('tok', 'არეალი "' + c.ka.label + '" — განახლდა ✓' + (ids.length > 1 ? ' (' + ids.length + ' ნაწილი)' : '') + ' (ყველა viewer-ს ეჩვენება)');
    if (c.lang === 'ka' && label !== c.ka.label) _tmL('tdm', 'ℹ ახალი სახელი: "' + label + '" — /წასვლა და #area= ბმულები ახლა ამ სახელით მუშაობს');
  }
}
function _tmAreaSessionClose() {
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
  _tmAreaCtx = null;
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();
  if (typeof window.areaPickClear === 'function') window.areaPickClear();
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
  if (_tmEditMode === 'menuItem')  { _tmSaveMenuItem(v); return; }
  if (_tmEditMode === 'menuTitle') { _tmSaveMenuTitle(v); return; }
  if (_tmEditMode === 'legend')    { _tmSaveLegend(v); return; }
  if (_tmEditMode === 'area')      { _tmSaveArea(v); return; }
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

  if (sub === 'set' || sub === 'დაყენება') {
    var rest = args.slice(1).join(' ').trim();
    var m = rest.match(/^([\s\S]+?)\s+([?!~-])$/);
    if (!m) {
      _tmL('ter', 'გამოყენება: /მარკერი დაყენება <სახელი> ?|!|~|-');
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

  if (sub === 'reset' || sub === 'გადაყენება') {
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

  _tmL('ter', 'გამოყენება: /მარკერი დაყენება|გადაყენება <სახელი> [?|!|~|-]');
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

// /play [url] — no arg opens the same upload modal as /მედია and plays
// whatever comes back immediately; a url plays it directly. One-shot,
// fullscreen, no attached data model — exactly "just play this file",
// per design: no separate cinematic engine.
// Resolves a /play or /მუსიკა token against the last /ფაილები listing —
// a bare index ("3"), an exact filename, or a unique substring of one — so
// caretakers don't have to paste the full Storage URL every time. Anything
// that doesn't match falls through unchanged (treated as a literal URL, the
// original behavior). Returns null (having already reported the reason) if
// the token is ambiguous — callers must check for that and abort.
function _tmResolveMediaRef(tok) {
  tok = (tok || '').trim();
  if (!tok) return tok;
  if (/^\d+$/.test(tok) && _tmFilesCache[+tok]) return _tmFilesCache[+tok].url;
  if (_tmFilesCache.length) {
    var lower = tok.toLowerCase();
    var exact = _tmFilesCache.find(function (f) { return f.name.toLowerCase() === lower; });
    if (exact) return exact.url;
    var partial = _tmFilesCache.filter(function (f) { return f.name.toLowerCase().indexOf(lower) !== -1; });
    if (partial.length === 1) return partial[0].url;
    if (partial.length > 1) {
      _tmL('ter', '✗ "' + tok + '" ემთხვევა ' + partial.length + ' ფაილს — დააკონკრეტე: ' + partial.map(function (f) { return f.name; }).join(', '));
      return null;
    }
  }
  return tok; // no cache match — treat as a literal URL, unchanged
}

async function _tmPlay(args) {
  var raw = args.join(' ').trim();
  var url = raw;
  if (raw) {
    url = _tmResolveMediaRef(raw);
    if (url === null) return; // ambiguous — already reported
  } else {
    if (typeof window.mdMediaOpen !== 'function') { _tmL('ter', '✗ mdMediaOpen ვერ მოიძებნა (upload.js ჩატვირთულია?)'); return; }
    var files = await window.mdMediaOpen();
    if (!files || !files.length) return;
    url = files[0].url;
  }
  if (typeof window._gmVideoPlay !== 'function') { _tmL('ter', '✗ _gmVideoPlay ვერ მოიძებნა (runtime.js ჩატვირთულია?)'); return; }
  window._gmVideoPlay(url);
  _tmL('tok', '▶ გაეშვა');
}

// /მუსიკა play <url1,url2,...> | /მუსიკა stop | /მუსიკა skip | /მუსიკა volume <0-100>
// Each comma-separated token also accepts an index or filename (see
// _tmResolveMediaRef) — "play" is the default when the first arg isn't a
// recognized subcommand, so `/მუსიკა <urls>` and `/მუსიკა play <urls>` both
// work; no-arg opens the upload picker (audio only makes sense there, but
// nothing stops picking something else — it'll just fail to play).
async function _tmMusic(args) {
  var sub = (args[0] || '').toLowerCase();
  if (sub === 'stop') {
    if (typeof window._gmMusicStop === 'function') window._gmMusicStop();
    _tmL('tok', '⏹ მუსიკა გაჩერდა');
    return;
  }
  if (sub === 'skip') {
    if (typeof window._gmMusicSkip === 'function') window._gmMusicSkip();
    _tmL('tok', '⏭ შემდეგი ტრეკი');
    return;
  }
  if (sub === 'volume' || sub === 'ხმა') {
    var v = parseInt(args[1], 10);
    if (isNaN(v)) { _tmL('ter', 'გამოყენება: /მუსიკა volume <0-100>'); return; }
    v = Math.max(0, Math.min(100, v));
    if (typeof window._gmMusicVolume === 'function') window._gmMusicVolume(v / 100);
    _tmL('tok', '🔊 ხმა: ' + v + '%');
    return;
  }

  var rest = (sub === 'play') ? args.slice(1).join(' ').trim() : args.join(' ').trim();
  var urls;
  if (rest) {
    var toks = rest.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    urls = toks.map(_tmResolveMediaRef);
    if (urls.indexOf(null) !== -1) return; // ambiguous — already reported
  } else {
    if (typeof window.mdMediaOpen !== 'function') { _tmL('ter', '✗ mdMediaOpen ვერ მოიძებნა (upload.js ჩატვირთულია?)'); return; }
    var files = await window.mdMediaOpen();
    if (!files || !files.length) return;
    urls = files.map(function (f) { return f.url; });
  }
  if (typeof window._gmMusicPlay !== 'function') { _tmL('ter', '✗ _gmMusicPlay ვერ მოიძებნა (runtime.js ჩატვირთულია?)'); return; }
  window._gmMusicPlay(urls);
  _tmL('tok', '🎵 playlist დაიწყო (' + urls.length + ' ტრეკი)');
}

// /ფაილები [N] — lists the N most recent uploads in the bucket (default 20),
// newest first, each with a copyable public URL — for finding a URL to feed
// into /play or /მუსიკა without leaving the app. Also caches the result so
// /play and /მუსიკა can reference these by index or filename instead.
// /ფაილი წაშ <N|სახელი|url> — deletes a file straight out of the bucket,
// independent of the item/segments data model. Exists because /play and
// /მუსიკა upload files that never get attached to any item's segments[] —
// the /rm-based cleanup only ever reaches files it can find referenced in
// segments, so these would otherwise sit in storage forever.
async function _tmFileDelete(args) {
  var sub = (args[0] || '').toLowerCase();
  var isDelSub = (sub === 'წაშ' || sub === 'delete' || sub === 'rm');
  var tok = (isDelSub ? args.slice(1) : args).join(' ').trim();
  if (!tok) { _tmL('ter', 'გამოყენება: /ფაილი წაშ <N|სახელი|url>'); return; }

  var url = _tmResolveMediaRef(tok);
  if (url === null) return; // ambiguous — already reported
  if (!/^https?:\/\//.test(url)) { _tmL('ter', '✗ "' + tok + '" ვერ ვიპოვე ბოლო /ფაილები-ს სიაში — jer /ფაილები გაუშვი'); return; }
  if (typeof window.mdMediaDelete !== 'function') { _tmL('ter', '✗ mdMediaDelete ვერ მოიძებნა (upload.js ჩატვირთულია?)'); return; }

  var ok = await window.mdMediaDelete([url]);
  if (!ok) { _tmL('ter', '✗ წაშლა ჩავარდა'); return; }
  _tmFilesCache = _tmFilesCache.filter(function (f) { return f.url !== url; }); // keep indices/cache in sync
  _tmL('tok', '✗ წაიშალა: ' + tok);
}

async function _tmFiles(args) {
  var n = parseInt(args[0], 10); if (isNaN(n) || n <= 0) n = 20;
  if (typeof window.mdMediaList !== 'function') { _tmL('ter', '✗ mdMediaList ვერ მოიძებნა (upload.js ჩატვირთულია?)'); return; }
  _tmL('tdm', 'ფაილები იტვირთება...');
  var res = await window.mdMediaList(n);
  if (!res.ok) { _tmL('ter', '✗ ვერ ჩამოვთვალე: ' + res.error); return; }
  if (!res.files.length) {
    _tmFilesCache = [];
    _tmL('ter', 'ფაილები ვერ მოიძებნა.');
    if (res.debug && res.debug.length) _tmL('tdm', 'root-ში ' + res.debug.length + ' ჩანაწერი: ' + res.debug.join(', '));
    else _tmL('tdm', 'root-ში 0 ჩანაწერი — LIST API ცარიელს აბრუნებს');
    return;
  }
  _tmFilesCache = res.files;
  res.files.forEach(function (f, i) {
    var kb = f.size ? Math.round(f.size / 1024) + 'KB' : '';
    _tmL('tdm', '[' + i + '] ' + f.name + (kb ? ' — ' + kb : ''));
    _tmL('tdm', '    ' + f.url);
  });
}

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
    var typeLabelPair = { '*': { ka: 'ინფო', en: 'Info' }, '!': { ka: 'გაფრთხილება', en: 'Warning' }, '~': { ka: 'საფრთხე', en: 'Danger' }, '^': { ka: 'კონსენსუსი', en: 'Consensus' }, '+': { ka: 'პროექტი', en: 'Project' }, '.': { ka: 'დასრულება', en: 'Done' }, '': { ka: 'ინფო', en: 'Info' } }[typeChar] || { ka: 'ინფო', en: 'Info' };
    var fres = await window.showNotifyFormModal({ title: (typeof _i18n === 'function' ? _i18n({ ka: 'შეტყობინება (' + typeLabelPair.ka + ')', en: 'Notification (' + typeLabelPair.en + ')' }) : 'შეტყობინება (' + typeLabelPair.ka + ')') });
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
        // OS-level push (Scope C) — same gap as /სურვილი had: without this,
        // anyone whose app is closed never finds out until they reopen it.
        fetch(SUPA_URL + '/functions/v1/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': 'sb_publishable_soE_2V-VW_fIu0DyM6QdzQ_TOvYNxF2' },
          body: JSON.stringify({ map_id: _MAP_ID, title: 'მდელო', body: rest, url: area ? ('#area=' + encodeURIComponent(area)) : '/' })
        }).catch(() => {});
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
      // OS-level push (Scope C) — same gap as the consensus branch above.
      fetch(SUPA_URL + '/functions/v1/send-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': 'sb_publishable_soE_2V-VW_fIu0DyM6QdzQ_TOvYNxF2' },
        body: JSON.stringify({ map_id: _MAP_ID, title: 'მდელო', body: rest, url: area ? ('#area=' + encodeURIComponent(area)) : '/' })
      }).catch(() => {});
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

  // verify object exists — try data-title first, then obj.lb (renamed objects); baked
  // (_OBJS by oi) or console-placed (window._consoleObjs, by object_id) — both covered.
  var hs = document.querySelector('.hotspot[data-title="' + title.replace(/"/g, '\\"') + '"]:not(.hs-area):not(.no-interact)');
  if (!hs && typeof _OBJS !== 'undefined') {
    for (var _i = 0; _i < _OBJS.length; _i++) {
      if (_OBJS[_i] && typeof _lbMatches === 'function' && _lbMatches(_OBJS[_i].lb, title)) {
        var _c = document.querySelector('.hotspot[data-oi="' + _i + '"]:not(.hs-area):not(.no-interact)');
        if (_c) { hs = _c; break; }
      }
    }
  }
  if (!hs && window._consoleObjs) {
    window._consoleObjs.forEach(function (co, cid) {
      if (hs) return;
      if (typeof _lbMatches === 'function' && _lbMatches(co.lb, title)) {
        var _c2 = document.querySelector('.hotspot.hs-object[data-obj-id="' + cid + '"]');
        if (_c2) hs = _c2;
      }
    });
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
  if (typeof dlgGetCurrentDsl === 'function') dsl = dlgGetCurrentDsl(objKey, _tmEditLang);

  var tgtForLb = (typeof _dlgTargetByTitle === 'function') ? _dlgTargetByTitle(objKey) : null;
  var dispLabel = (tgtForLb && tgtForLb.obj && typeof _objDisplayName === 'function' ? _objDisplayName(tgtForLb.obj) : '') || objKey;

  // fallback template if no dialogue exists yet — only valid in ka mode:
  // ka is authoritative, so a translation pass needs something to translate.
  if (!dsl) {
    if (_tmEditLang === 'en') {
      _tmL('ter', '✗ ჯერ საჭიროა ქართული დიალოგის შექმნა (/ენა ka), მერე — თარგმნა');
      return;
    }
    dsl = '@0 ' + dispLabel + '\n\n<> \n\n-> ';
  }

  // switch to multiline mode and load DSL
  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = dsl;
  _tmTaResize();
  _tmEditObj = objKey;
  _tmEditMode = 'dlg';
  _tmEditLabel = dispLabel;

  _tmL('tsy', '─── ' + dispLabel + ' — DSL ' + (_tmEditLang === 'en' ? '(EN)' : '') + ' ──────────────');
  if (_tmEditLang === 'en') {
    _tmL('tdm', 'EN რეჟიმი — მხოლოდ ტექსტი/ღილაკები ითარგმნება; =>, >>, კვანძების რაოდენობა იგნორირდება');
  }
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Cancel edit mode without saving
function _tmEditCancel() {
  var label = _tmEditLabel || _tmEditObj;
  if (_tmEditMode === 'area') { _tmAreaCtx = null; if (window.areaPickClear) window.areaPickClear(); }
  _tmMediaCleanupOnCancel();
  _tmEditObj = null;
  _tmEditMode = null;
  _tmEditMenuCtx = null;
  _tmEditLabel = null;
  _tmEditBuf = null; _tmEditMediaBuf = [];
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();
  _tmL('tdm', label + ' — გაუქმდა');
}

// Merge freshly-parsed DSL nodes into the existing {ka,en} structure, per
// the active edit-language:
//  - ka: authoritative — full structural replace (new nodes/buttons/
//        conditions win, this is where nodes get created/reordered/removed),
//        but .text/.label carry the OTHER language's translation forward
//        instead of wiping it. This is also where the lazy string→{ka,en}
//        migration happens, on first save.
//  - en: translation-only merge — structure (conditions, node ids, button
//        targets/area/link/cmds, node/button COUNT) is NEVER touched here;
//        only .text.en and each button's .label.en are written, matched
//        onto the existing node by id and button by position. A parsed node
//        id with no existing match is a hard error (aborts the save —
//        it would otherwise silently need brand-new, untranslated
//        structure). A button-count mismatch is a soft warning only.
function _tmMergeDlgNodes(existingNodes, freshNodes, lang) {
  if (lang === 'en') {
    var byId = {};
    var merged = (existingNodes || []).map(function (n) {
      // clone (incl. lazy string→{ka,en} upgrade) so _OBJS isn't touched
      // until the save actually succeeds
      var oldText = n.text;
      var text = (typeof oldText === 'string') ? { ka: oldText, en: '' } : Object.assign({ ka: '', en: '' }, oldText);
      var buttons = (n.buttons || []).map(function (b) {
        var oldLabel = b.label;
        var label = (typeof oldLabel === 'string') ? { ka: oldLabel, en: '' } : Object.assign({ ka: '', en: '' }, oldLabel);
        return Object.assign({}, b, { label: label });
      });
      var clone = Object.assign({}, n, { text: text, buttons: buttons });
      byId[clone.id] = clone;
      return clone;
    });

    var warnings = [];
    var touched = {};
    for (var i = 0; i < freshNodes.length; i++) {
      var fn = freshNodes[i];
      var target = byId[fn.id];
      if (!target) return { error: 'კვანძი ' + fn.id.replace('node_', '@') + ' არ არსებობს ქართულ ვერსიაში — en-რეჟიმში ახალი კვანძი ვერ იქმნება' };
      touched[fn.id] = true;
      // Only write .en if it actually differs from .ka — an untouched
      // node/button still shows its ka text as a reference/placeholder
      // while editing (see _tmDlgEdit), and saving that back verbatim
      // would wrongly record the ka text as if it were the translation.
      var fnText = fn.text || '';
      if (fnText !== target.text.ka) target.text.en = fnText;
      var fb = fn.buttons || [];
      if (fb.length !== target.buttons.length) {
        warnings.push('კვანძი ' + fn.id.replace('node_', '@') + ': ღილაკების რაოდენობა არ ემთხვევა (' + fb.length + ' ≠ ' + target.buttons.length + ') — მხოლოდ ემთხვევადი ითარგმნა');
      }
      var n2 = Math.min(fb.length, target.buttons.length);
      for (var j = 0; j < n2; j++) {
        var fbLabel = fb[j].label || '';
        if (fbLabel !== target.buttons[j].label.ka) target.buttons[j].label.en = fbLabel;
      }
    }
    // Existing nodes the person didn't include in this en-pass (e.g. deleted
    // the @N header, or just left it out) are NOT removed — ka structure is
    // authoritative and en can't delete nodes — but their translation is
    // also NOT touched, so flag it instead of silently doing nothing.
    merged.forEach(function (n) {
      if (!touched[n.id]) warnings.push('კვანძი ' + n.id.replace('node_', '@') + ': ამ პასში არ იყო — თარგმანი უცვლელი დარჩა (structure არ შეცვლილა)');
    });
    return { nodes: merged, warnings: warnings };
  }

  // ka mode — structural replace; carry forward existing .en by matching id/index
  var oldById = {};
  (existingNodes || []).forEach(function (n) { oldById[n.id] = n; });
  var mergedKa = freshNodes.map(function (fn) {
    var old = oldById[fn.id];
    var oldEn = (old && old.text && typeof old.text === 'object') ? (old.text.en || '') : '';
    var newNode = Object.assign({}, fn, { text: { ka: fn.text || '', en: oldEn } });
    newNode.buttons = (fn.buttons || []).map(function (b, bi) {
      var oldBtn = old && old.buttons && old.buttons[bi];
      var oldLabelEn = (oldBtn && oldBtn.label && typeof oldBtn.label === 'object') ? (oldBtn.label.en || '') : '';
      return Object.assign({}, b, { label: { ka: b.label || '', en: oldLabelEn } });
    });
    return newNode;
  });
  return { nodes: mergedKa };
}

// Merges the object's display name into {ka,en}, mirroring the node-text
// model: ka mode is a structural rename (authoritative, replaces .ka
// outright); en mode only records a translation if the typed value
// actually differs from the ka reference shown while editing — an
// untouched header line must not get saved back as a false "translation".
function _tmMergeDlgTitle(existingLb, freshTitle, lang) {
  var oldKa = (typeof existingLb === 'string') ? existingLb : ((existingLb && existingLb.ka) || '');
  var oldEn = (existingLb && typeof existingLb === 'object') ? (existingLb.en || '') : '';
  var ft = freshTitle || '';
  if (lang === 'en') {
    return { ka: oldKa, en: (ft && ft !== oldKa) ? ft : oldEn };
  }
  return { ka: ft || oldKa, en: oldEn };
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

  var tgt = (typeof _dlgTargetByTitle === 'function') ? _dlgTargetByTitle(title) : null;
  var existingNodes = (tgt && tgt.obj && Array.isArray(tgt.obj.dialogue)) ? tgt.obj.dialogue : [];

  var merge = _tmMergeDlgNodes(existingNodes, nodes, _tmEditLang);
  if (merge.error) {
    _tmL('ter', '✗ ' + merge.error);
    return;
  }
  nodes = merge.nodes;
  if (merge.warnings) merge.warnings.forEach(function (w) { _tmL('ter', '⚠ ' + w); });

  // Persisted dsl is always the ka-canonical structure — never the raw
  // en-pass text the person just typed, which would corrupt future title/
  // marker extraction and future ka edits sourced from this same field.
  var dslToSave = (_tmEditLang === 'en' && typeof dlgGetCurrentDsl === 'function') ? (dlgGetCurrentDsl(title, 'ka') || dsl) : dsl;

  var existingLb = (tgt && tgt.obj) ? tgt.obj.lb : '';
  var titleMerge = _tmMergeDlgTitle(existingLb, result.title, _tmEditLang);
  var titleEnToSave = titleMerge.en;

  var label = _tmEditLabel;

  // Offline: apply the parsed nodes locally right away (same effect
  // dlgOverrideSave has on success — _applyDlgOverride patches _OBJS so the
  // edit is immediately visible/testable) and queue the Supabase write for
  // when the connection comes back, instead of letting fetch() itself fail
  // with a generic network error.
  if (!navigator.onLine) {
    if (typeof _applyDlgOverride === 'function') _applyDlgOverride({ obj_title: title, nodes_json: nodes, dsl: dslToSave, title_en: titleEnToSave });
    window.pendingAdd('dlg', title, label, { title: title, nodes: nodes, dsl: dslToSave, titleEn: titleEnToSave });
    _tmEditObj = null; _tmEditMode = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    _tmL('tdm', '⚠ ოფლაინ — ' + label + ' ლოკალურად გამოიყენება, queue-შია (' + window.pendingCount() + ')');
    return;
  }

  _tmL('tdm', '↑ ' + title + ' — ვინახავ...');

  if (typeof dlgOverrideSave !== 'function') {
    _tmL('ter', '✗ dlgOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }

  var ok = false, okResult = null;
  try {
    okResult = await dlgOverrideSave(title, nodes, dslToSave, titleEnToSave); ok = okResult === true;
  } catch (e) {
    // Connection dropped mid-request (not just a stale navigator.onLine
    // flag) — queue it the same as the upfront offline check above, rather
    // than discarding the edit.
    if (typeof _applyDlgOverride === 'function') _applyDlgOverride({ obj_title: title, nodes_json: nodes, dsl: dslToSave, title_en: titleEnToSave });
    window.pendingAdd('dlg', title, label, { title: title, nodes: nodes, dsl: dslToSave, titleEn: titleEnToSave });
    _tmEditObj = null; _tmEditMode = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    _tmL('ter', '✗ ქსელის შეცდომა — queue-ში ჩავარდა (' + window.pendingCount() + '): ' + e.message);
    return;
  }

  if (ok) {
    _tmEditObj = null; _tmEditMode = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    _tmL('tok', label + ' — შენახულია ✓  (ყველა viewer განახლდება)');
  } else {
    // Real server-side rejection (we got an HTTP response, connectivity is
    // fine) — NOT queued, since replaying the same payload later would just
    // fail again the same way. Leave it in the textarea to fix and retry.
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
  var parts = _tmMenuStack.map(function (n) { return _i18n(n.title) || '(უსახელო)'; });
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
    _tmL('tnf', (n.icon || '📁') + ' ' + (_i18n(n.title) || '(უსახელო)') + (hasKids ? '/' : ''));
  });
  items.forEach(function (it, idx) {
    var itObj = typeof it === 'string' ? { type: 'text', emoji: '•', label: it } : it;
    if (itObj.type === 'progress') {
      _tmL('tnf', '  [' + idx + '] ინდიკატორი: "' + (_i18n(itObj.label) || '') + '" (' + (itObj.value != null ? itObj.value : 0) + '%)');
    } else {
      var lbl = (_i18n(itObj.label) || '').replace(/\n/g, ' ');
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
  var found = list.find(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, name); });
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
    var found = children.find(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, seg); });
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
  if (list.find(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, name); })) {
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
    var removedIt = node.items[idx];
    if (removedIt && typeof removedIt === 'object' && removedIt.segments && typeof window.mdMediaDelete === 'function') {
      var itUrls = _tmSegmentFileUrls(removedIt.segments);
      if (itUrls.length) window.mdMediaDelete(itUrls);
    }
    node.items.splice(idx, 1);
    _tmL('tok', '✗ item [' + idx + '] წაიშალა');
    await _tmMenuSaveNode(node.id, { items_json: node.items });
  } else {
    var list = _tmMenuCwdList();
    var fIdx = list.findIndex(function (n) { return typeof _lbMatches === 'function' && _lbMatches(n.title, arg); });
    if (fIdx < 0) { _tmL('ter', 'ვერ მოიძებნა: "' + arg + '" — /ls'); return; }
    var removed = list[fIdx];
    if (typeof window.mdMediaDelete === 'function') {
      var subtreeUrls = _tmCollectMediaUrls(removed);
      if (subtreeUrls.length) window.mdMediaDelete(subtreeUrls);
    }
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

// Placeholder token for a files-segment inside the plain-text editor buffer.
// Points into _tmEditMediaBuf[n] by index — never carries the file data
// itself inline, keeps the textarea readable.
function _tmSegmentFileUrls(segments) {
  var urls = [];
  (segments || []).forEach(function (seg) {
    if (seg.type === 'files') (seg.items || []).forEach(function (f) { if (f && f.url) urls.push(f.url); });
  });
  return urls;
}

// Walks a node and every descendant child, collecting every media URL any
// text-item in the subtree is carrying — used by section-level /rm so a
// whole-branch delete doesn't orphan the illustrations of everything nested inside it.
function _tmCollectMediaUrls(node) {
  var urls = [];
  (node.items || []).forEach(function (it) {
    if (it && typeof it === 'object' && it.segments) urls = urls.concat(_tmSegmentFileUrls(it.segments));
  });
  (node.children || []).forEach(function (child) { urls = urls.concat(_tmCollectMediaUrls(child)); });
  return urls;
}

function _tmMediaToken(n) { return '[[მედია:' + n + ']]'; }

// Fire-and-forget cleanup for a cancelled session: only touches buffer
// entries uploaded THIS session (_preexisting:false) — media rehydrated from
// an item's already-saved segments[] is never deleted just because the
// caretaker hit Esc.
function _tmMediaCleanupOnCancel() {
  if (typeof window.mdMediaDelete !== 'function') return;
  var urls = [];
  (_tmEditMediaBuf || []).forEach(function (buf) {
    if (buf._preexisting) return;
    (buf.items || []).forEach(function (f) { if (f && f.url) urls.push(f.url); });
  });
  if (urls.length) window.mdMediaDelete(urls);
}

// Serialize an item into editable plain text for the multiline textarea.
// Line 1 is a tagged "[emoji: X]" line so it can't be confused with real
// label content — progress items also keep their value on a trailing "NN%" line.
// For text items carrying segments[], each files-segment is rehydrated into
// _tmEditMediaBuf and represented inline as a [[მედია:N]] token, so re-editing
// an already-illustrated item doesn't lose its images.
function _tmMenuItemToEditText(itObj) {
  var emoji = itObj.emoji || (itObj.type === 'progress' ? '📊' : '•');
  var head  = '[emoji: ' + emoji + ']';
  var lbl   = _i18n(itObj.label);
  if (itObj.type === 'progress') {
    return head + '\n' + lbl + '\n\n' + (itObj.value != null ? itObj.value : 0) + '%';
  }
  if (itObj.type === 'text' && itObj.segments && itObj.segments.length) {
    var body = itObj.segments.map(function (seg) {
      if (seg.type === 'files') {
        var n = _tmEditMediaBuf.length;
        _tmEditMediaBuf.push({ items: seg.items || [], _preexisting: true });
        return _tmMediaToken(n);
      }
      return _i18n(seg.value) || '';
    }).join('\n');
    return head + '\n' + body;
  }
  return head + '\n' + lbl;
}

// Parse text-editor lines (emoji tag already stripped) into segments[] + a
// flattened plain-text label fallback (for old render code, and for search/
// display anywhere segments aren't understood yet). [[მედია:N]] tokens
// resolve against _tmEditMediaBuf, populated live during this session by
// /მედია (or rehydrated on open, see above). A token pointing past the
// buffer's end is left as literal text rather than silently dropped —
// should never happen in normal use, but a visible stray bracket beats a
// vanished upload.
function _tmParseTextSegments(rest) {
  var raw = rest.join('\n');
  var segments = [];
  var re = /\[\[მედია:(\d+)\]\]/g;
  var lastIdx = 0, m;
  function pushText(s) {
    var v = s.replace(/^\n+|\n+$/g, '');
    if (v.trim()) segments.push({ type: 'text', value: v });
  }
  while ((m = re.exec(raw))) {
    var n = +m[1];
    pushText(raw.slice(lastIdx, m.index));
    if (_tmEditMediaBuf[n]) segments.push({ type: 'files', items: _tmEditMediaBuf[n].items || [] });
    else pushText(m[0]);
    lastIdx = re.lastIndex;
  }
  pushText(raw.slice(lastIdx));

  var label = segments.map(function (s) { return s.type === 'text' ? s.value : '📎'; }).join(' ').trim();
  return { segments: segments, label: label };
}

// Parse the textarea content back into { emoji, label, value, segments } on
// save. If line 1 isn't a valid "[emoji: X]" tag (e.g. accidentally edited
// away), `fallbackEmoji` (the item's current emoji) is kept instead of
// guessing — nothing gets silently swallowed into the label.
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

  if (type === 'text') {
    var ts = _tmParseTextSegments(rest);
    return { emoji: emoji, label: ts.label, value: null, segments: ts.segments };
  }

  return { emoji: emoji, label: rest.join('\n').trim(), value: null };
}

// Open the multiline editor for a menu SECTION's own title (not an item) —
// triggered by /სექცია/<path>. ka mode renames (authoritative, full
// rewrite); en mode translates only, guarded the same way as items/dialogue.
function _tmMenuTitleEditOpen(segs) {
  var node = (typeof _tmFindMenuNodeByPath === 'function') ? _tmFindMenuNodeByPath(segs) : null;
  if (!node) return; // _tmFindMenuNodeByPath already logged the "not found" error

  var oldTitle = node.title;
  var oldKa = (typeof oldTitle === 'string') ? oldTitle : ((oldTitle && oldTitle.ka) || '');
  var oldEn = (oldTitle && typeof oldTitle === 'object') ? (oldTitle.en || '') : '';

  if (_tmEditLang === 'en' && !oldKa) {
    _tmL('ter', '✗ ჯერ საჭიროა ქართული სახელის დაყენება (/ენა ka), მერე — თარგმნა');
    return;
  }

  var current = (_tmEditLang === 'en') ? (oldEn || oldKa) : oldKa;

  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = current;
  _tmTaResize();
  _tmEditObj     = node.id;
  _tmEditMode    = 'menuTitle';
  _tmEditMenuCtx = { node: node };
  _tmEditLabel   = 'სექცია: ' + oldKa;

  _tmL('tsy', '─── სექციის სახელი ' + (_tmEditLang === 'en' ? '(EN)' : '') + ' ──────────────');
  if (_tmEditLang === 'en') {
    _tmL('tdm', 'EN რეჟიმი — მხოლოდ სახელის თარგმანი, structure/items უცვლელია');
  }
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Save the section-title edit — merges into {ka,en}, same reference-text
// guard as dialogue/legend/items: an untouched en-mode textarea (still
// showing the ka fallback) is never saved back as a false translation.
async function _tmSaveMenuTitle(text) {
  var ctx = _tmEditMenuCtx;
  if (!ctx || !ctx.node) { _tmEditCancel(); return; }
  var node = ctx.node;

  var oldTitle = node.title;
  var oldKa = (typeof oldTitle === 'string') ? oldTitle : ((oldTitle && oldTitle.ka) || '');
  var oldEn = (oldTitle && typeof oldTitle === 'object') ? (oldTitle.en || '') : '';

  var newKa = oldKa, newEn = oldEn;
  if (_tmEditLang === 'en') {
    if (text && text !== oldKa) newEn = text;
  } else {
    newKa = text || oldKa;
  }
  node.title = { ka: newKa, en: newEn };

  var label = _tmEditLabel;
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();

  _tmL('tdm', '↑ ' + label + ' — ვინახავ...');
  await _tmMenuSaveNode(node.id, { title: newKa, title_en: newEn });
  _tmL('tok', label + ' — შენახულია ✓');
}

// Open the multiline editor for item [idx] of `node`.
function _tmMenuEditOpen(node, idx, itObj) {
  _tmEditMediaBuf = []; // fresh scope for this session — _tmMenuItemToEditText repopulates from existing segments, if any
  if (!_tmMulti) tmToggleMulti();
  document.getElementById('tmTa').value = _tmMenuItemToEditText(itObj);
  _tmTaResize();
  _tmEditObj     = node.id;
  _tmEditMode    = 'menuItem';
  _tmEditMenuCtx = { node: node, idx: idx, type: itObj.type || 'text' };
  var nodeTitle  = _i18n(node.title) || '';
  _tmEditLabel   = '[' + idx + '] ' + nodeTitle;

  _tmL('tsy', '─── [' + idx + '] ' + nodeTitle + ' ' + (_tmEditLang === 'en' ? '(EN)' : '') + ' ──────────────');
  if (_tmEditLang === 'en') {
    _tmL('tdm', 'EN რეჟიმი — მხოლოდ ტექსტი ითარგმნება, emoji/სტრუქტურა უცვლელია');
  }
  _tmL('tdm', 'ხაზი 1 — [emoji: X], მხოლოდ X გამოცვალე');
  if (itObj.type === 'text' || !itObj.type) {
    _tmL('tdm', 'ახალ ხაზზე დაწერე "/მედია" — jpg/png/webp/mp3/txt/mp4/epub/pdf ატვირთვისთვის');
    _tmL('tdm', '"/youtube <url> " (space ბოლოში) — YouTube thumbnail-ისთვის');
  }
  _tmL('tdm', 'Ctrl+Enter — შენახვა · Esc — გაუქმება');
}

// Detects a freshly-typed "/მედია" trigger line inside the multiline textarea
// (the ONLY "/"-command recognized while a menuItem/text edit-session is
// open — everything else about the terminal is locked to this session by
// this point, see tmToggleMulti's guard) and opens the upload modal. Only
// wired up for text-type menuItem sessions — see the input listener below.
function _tmMediaCheckTrigger(ta) {
  var pos = ta.selectionStart;
  var before = ta.value.slice(0, pos);
  if (!/(^|\n)\/მედია$/.test(before)) return;
  var cut = before.replace(/\/მედია$/, '');
  ta.value = cut + ta.value.slice(pos);
  ta.setSelectionRange(cut.length, cut.length);
  _tmTaResize(ta);
  _tmMediaOpen(ta, cut.length);
}

// Detects "/youtube <url> " (note the trailing space — it's the terminator;
// without one, this would fire on every keystroke of the url itself, since
// any partial url still matches \S+). Fires once, right when that space is
// typed.
function _tmYoutubeCheckTrigger(ta) {
  var pos = ta.selectionStart;
  var before = ta.value.slice(0, pos);
  var m = /(^|\n)\/(?:youtube|იუთუბი) (\S+) $/.exec(before);
  if (!m) return;
  var cut = before.slice(0, before.length - m[0].length) + m[1];
  ta.value = cut + ta.value.slice(pos);
  ta.setSelectionRange(cut.length, cut.length);
  _tmTaResize(ta);
  _tmYoutubeInsert(ta, cut.length, m[2]);
}

// Shared by /მედია and /youtube — pushes `items` as a new files-segment onto
// the session's media buffer and drops a [[მედია:N]] token at `insertAt`,
// padding with newlines only where the surrounding text needs it.
function _tmInsertMediaToken(ta, insertAt, items) {
  var n = _tmEditMediaBuf.length;
  _tmEditMediaBuf.push({ items: items, _preexisting: false });
  var v     = ta.value;
  var pad   = (insertAt > 0 && v.charAt(insertAt - 1) !== '\n') ? '\n' : '';
  var padAf = (v.charAt(insertAt) !== '\n' && v.charAt(insertAt) !== '') ? '\n' : '';
  var chunk = pad + _tmMediaToken(n) + padAf;
  ta.value = v.slice(0, insertAt) + chunk + v.slice(insertAt);
  var caretAt = insertAt + chunk.length;
  ta.focus();
  ta.setSelectionRange(caretAt, caretAt);
  _tmTaResize(ta);
}

// Opens upload.js's modal (mdMediaOpen, reused as-is — no index.html change),
// and on a successful upload inserts a [[მედია:N]] token at `insertAt`,
// pushing the returned file descriptors onto _tmEditMediaBuf[N]. A cancelled
// upload (falsy/empty return) inserts nothing — the trigger text is already
// gone by this point, so cancelling just leaves the cursor where it was.
// ⚠️ ASSUMED contract: window.mdMediaOpen() returns a Promise resolving to
// an array of {type, url, name} (or null/[] on cancel) — unconfirmed against
// the actual upload.js, which hasn't been reviewed in this chat yet.
async function _tmMediaOpen(ta, insertAt) {
  if (typeof window.mdMediaOpen !== 'function') {
    _tmL('ter', '✗ mdMediaOpen ვერ მოიძებნა (upload.js ჩატვირთულია?)');
    return;
  }
  var files;
  try {
    files = await window.mdMediaOpen();
  } catch (e) {
    _tmL('ter', '✗ ატვირთვა ჩავარდა: ' + e.message);
    return;
  }
  if (!files || !files.length) return;
  _tmInsertMediaToken(ta, insertAt, files);
  _tmL('tok', '📎 მედია დაემატა (' + files.length + ' ფაილი)');
}

// Extracts the 11-ish char video ID out of any common YouTube URL shape —
// watch?v=, youtu.be/, /shorts/, /embed/ — and ignores whatever comes after
// (extra query params like &t=90s, playlist context, etc).
function _tmYoutubeId(url) {
  var m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,15})/);
  return m ? m[1] : null;
}

// No upload involved — just parses the ID, builds a thumbnail-only 'youtube'
// item (opens the real YouTube link on click, never embeds a player — the
// caretaker doesn't want an in-app cinematic experience for these, per
// design, only for self-uploaded /play-style video) and inserts the token
// the same way /მედია does.
function _tmYoutubeInsert(ta, insertAt, url) {
  var id = _tmYoutubeId(url);
  if (!id) { _tmL('ter', '✗ ვერ ამოვიცანი YouTube ID: ' + url); return; }
  _tmInsertMediaToken(ta, insertAt, [{ type: 'youtube', videoId: id, url: 'https://www.youtube.com/watch?v=' + id, name: id }]);
  _tmL('tok', '▶ YouTube thumbnail დაემატა');
}

// Save the multiline editor content back into the item + push to Supabase.
async function _tmSaveMenuItem(text) {
  var ctx = _tmEditMenuCtx;
  if (!ctx) { _tmEditCancel(); return; }
  var node = ctx.node, idx = ctx.idx;
  if (!node.items || !node.items[idx]) {
    _tmL('ter', '✗ item [' + idx + '] აღარ არსებობს');
    _tmMediaCleanupOnCancel();
    _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
    document.getElementById('tmTa').value = '';
    if (_tmMulti) tmToggleMulti();
    return;
  }

  var existing      = node.items[idx];
  var currentEmoji  = (existing && typeof existing === 'object' && existing.emoji) ? existing.emoji : (ctx.type === 'progress' ? '📊' : '•');
  var parsed        = _tmParseMenuEditText(text, ctx.type, currentEmoji);
  var itObj         = typeof existing === 'string' ? { type: ctx.type } : existing;

  var oldLabel   = itObj.label;
  var oldLabelKa = (typeof oldLabel === 'string') ? oldLabel : ((oldLabel && oldLabel.ka) || '');
  var oldLabelEn = (oldLabel && typeof oldLabel === 'object') ? (oldLabel.en || '') : '';

  itObj.type  = ctx.type;
  itObj.emoji = parsed.emoji;
  // Only record as translated if it actually differs from the ka reference
  // shown while editing — untouched text must not be saved back as a false
  // "translation" (same reasoning as dialogue/legend).
  if (_tmEditLang === 'en') {
    itObj.label = { ka: oldLabelKa, en: (parsed.label && parsed.label !== oldLabelKa) ? parsed.label : oldLabelEn };
  } else {
    itObj.label = { ka: parsed.label || '', en: oldLabelEn };
  }

  if (ctx.type === 'text') {
    if (parsed.segments && parsed.segments.length) {
      var oldSegs = itObj.segments || [];
      if (oldSegs.length && oldSegs.length !== parsed.segments.length) {
        _tmL('ter', '⚠ სეგმენტების რაოდენობა შეიცვალა (' + oldSegs.length + ' → ' + parsed.segments.length + ') — თარგმანის მიბმა შესაძლოა არასწორად მოხდეს');
      }
      itObj.segments = parsed.segments.map(function (seg, si) {
        if (seg.type === 'files') return seg; // structure/media never changes via translation
        var oldSeg   = oldSegs[si];
        var oldValKa = oldSeg ? ((typeof oldSeg.value === 'string') ? oldSeg.value : ((oldSeg.value && oldSeg.value.ka) || '')) : '';
        var oldValEn = (oldSeg && oldSeg.value && typeof oldSeg.value === 'object') ? (oldSeg.value.en || '') : '';
        if (_tmEditLang === 'en') {
          return { type: 'text', value: { ka: oldValKa, en: (seg.value && seg.value !== oldValKa) ? seg.value : oldValEn } };
        }
        return { type: 'text', value: { ka: seg.value || '', en: oldValEn } };
      });
    }
    else delete itObj.segments; // nothing left but plain text — label-only fallback
  }
  if (ctx.type === 'progress' && parsed.value != null) itObj.value = parsed.value;
  node.items[idx] = itObj;

  // Orphan cleanup: covers both a token deleted from an already-saved item's
  // text AND a file uploaded-then-deleted again within this same session
  // before ever being saved — either way, if a URL the session ever held
  // isn't in the final saved segments, it's not referenced anywhere anymore.
  if (ctx.type === 'text' && typeof window.mdMediaDelete === 'function') {
    var everUrls = [];
    (_tmEditMediaBuf || []).forEach(function (buf) { (buf.items || []).forEach(function (f) { if (f && f.url) everUrls.push(f.url); }); });
    var finalUrls   = _tmSegmentFileUrls(itObj.segments);
    var removedUrls = everUrls.filter(function (u) { return finalUrls.indexOf(u) === -1; });
    if (removedUrls.length) window.mdMediaDelete(removedUrls);
  }

  var label = _tmEditLabel;
  _tmEditObj = null; _tmEditMode = null; _tmEditMenuCtx = null; _tmEditLabel = null; _tmEditBuf = null; _tmEditMediaBuf = [];
  document.getElementById('tmTa').value = '';
  if (_tmMulti) tmToggleMulti();

  _tmL('tdm', '↑ ' + label + ' — ვინახავ...');
  await _tmMenuSaveNode(node.id, { items_json: node.items });
  _tmL('tok', label + ' — შენახულია ✓');
}

// Partial upsert into menu_overrides — only the given fields get written/replaced server-side.
// The caller (_tmSaveMenuItem) already mutated the in-memory node.items
// locally before calling this, so there's nothing extra to "apply" here on
// the offline path — only the persistence step needs guarding.
async function _tmMenuSaveNode(nodeId, fields) {
  if (typeof window.menuOverrideSave !== 'function') {
    _tmL('ter', '✗ menuOverrideSave ვერ მოიძებნა (runtime.js?)');
    return;
  }
  if (!navigator.onLine) {
    window.pendingAdd('menuItem', nodeId, 'მენიუ item', { nodeId: nodeId, fields: fields });
    _tmL('tdm', '⚠ ოფლაინ — ლოკალურად გამოიყენება, queue-შია (' + window.pendingCount() + ')');
    return;
  }
  var res;
  try { res = await window.menuOverrideSave(nodeId, fields); }
  catch (e) {
    window.pendingAdd('menuItem', nodeId, 'მენიუ item', { nodeId: nodeId, fields: fields });
    _tmL('ter', '✗ ქსელის შეცდომა — queue-ში ჩავარდა (' + window.pendingCount() + '): ' + e.message);
    return;
  }
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
var _TM_RESERVED = ['macro','მაკრო','marker','მარკერი','cd','გად','md','rm','წაშ','ls','ჩვ','pwd','გზა','edit','რედ','ფოთოლი','flag','დროშა','nick','მეტსახელი','me','მე','who','ვინ','color','ფერი','help','play','მუსიკა','music','ფაილები','files','ფაილი',
  'დახმარება','გასუფთავება','ინფო','მასშტაბი','ზონები','არე','ობიექტები','ობიექტი','დიალოგი','წასვლა','ლეგენდა','მენიუ','გახსნა','შეყვანა','სრული','ისტორია','ვადა','ტექსტი','შეტყობინება','დახურვა','სია','იუზერი','დაწინაურება','სურვილი','შენახვა','ჩატვირთვა','სინქრონიზაცია','sync','შესრულება'];

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
  if (/^(todo|შესრულება)\//.test(c)) return 'todo';
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

  if (head0 === 'ls' || head0 === 'ჩვ') { _tmMacroLs(); return; }

  if (head0 === 'rm' || head0 === 'წაშ') {
    var scopeWord = (args[1] || '').trim();
    var rmName = args.slice(2).join(' ').trim();
    if (!rmName || (scopeWord !== 'local' && scopeWord !== 'ჩემი' && scopeWord !== 'საერთო')) {
      _tmL('ter', 'გამოყენება: /მაკრო წაშ ჩემი|საერთო <სახელი>');
      return;
    }
    if (scopeWord === 'local' || scopeWord === 'ჩემი') {
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
    _tmL('tsy', '/მაკრო ბრძანებები:');
    _tmL('tnf', '  ჩემი <სახელი> := cmd1 ; cmd2 ...    — პერსონალური შორთკატი');
    _tmL('tnf', '  საერთო <სახელი> := cmd1 ; cmd2 ...  — გაზიარებული შორთკატი');
    _tmL('tnf', '  საერთო <სახელი>@tier := ...         — (მხოლოდ shadow_admin) tier-whitelist');
    _tmL('tnf', '  ჩვ                                  — ყველა შორთკატის სია');
    _tmL('tnf', '  წაშ ჩემი|საერთო <სახელი>            — წაშლა');
    _tmL('tdm', _SEP);
    return;
  }

  var head = raw.slice(0, assignIdx).trim();
  var body = raw.slice(assignIdx + 2).trim();
  var headParts = head.split(/\s+/);
  var scope = headParts[0];
  var namePart = headParts.slice(1).join(' ').trim();

  if (scope !== 'local' && scope !== 'ჩემი' && scope !== 'საერთო') {
    _tmL('ter', 'მითხარი scope: /მაკრო ჩემი <სახელი> := ...  ან  /მაკრო საერთო <სახელი> := ...');
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

  if (scope === 'local' || scope === 'ჩემი') {
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
