// unlock.js — Mdelo Viewer: Flag-based Unlock Engine
// No ES modules. Everything on window.
// Load after: chat.js (for _tmPrint fallback awareness)
// Provides: canTrigger, completeDialog, flagSet/Clear/Has/List/Reset,
//           unlockHandleCmd (/flag terminal commands), unlockInit

(function (global) {
  'use strict';

  var STORAGE_KEY = 'mdelo_flags';

  // Tier flags are mutually exclusive (a user is exactly one of these at a
  // time), unlike ordinary narrative flags which accumulate forever. They
  // live in their own single-value key so setting one can never leave a
  // stale lower tier sitting in the array alongside it.
  var TIER_KEY   = 'mdelo_tier';
  var TIER_FLAGS = ['სტუმარი', 'მეურვე', 'მაცხოვრებელი'];

  function _tierLoad() {
    try { return localStorage.getItem(TIER_KEY) || ''; } catch (e) { return ''; }
  }
  function _tierSave(name) {
    try {
      if (name) localStorage.setItem(TIER_KEY, name);
      else localStorage.removeItem(TIER_KEY);
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Flag storage (localStorage → JSON array of strings)
  // ─────────────────────────────────────────────────────────────────────────
  function _load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function _save(arr) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public Flag API
  // ─────────────────────────────────────────────────────────────────────────
  function flagSet(name) {
    name = String(name).trim();
    if (!name) return false;
    if (TIER_FLAGS.indexOf(name) !== -1) { _tierSave(name); return true; }
    var arr = _load();
    if (arr.indexOf(name) === -1) { arr.push(name); _save(arr); }
    return true;
  }

  function flagClear(name) {
    name = String(name).trim();
    if (TIER_FLAGS.indexOf(name) !== -1) {
      if (_tierLoad() !== name) return false;
      _tierSave('');
      return true;
    }
    var arr = _load();
    var idx = arr.indexOf(name);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    _save(arr);
    return true;
  }

  function flagHas(name) {
    name = String(name).trim();
    if (TIER_FLAGS.indexOf(name) !== -1) return _tierLoad() === name;
    return _load().indexOf(name) !== -1;
  }

  function flagList() {
    var arr = _load().slice();
    var t = _tierLoad();
    if (t) arr.push(t); // include the active tier so "/დროშა სია" stays complete
    return arr;
  }

  function flagReset() {
    _save([]);
    _tierSave('');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // canTrigger(dialog)
  // Returns true if all dialog.requires.flags are set.
  // An unlocked dialog also needs flag "dialog_unlocked:<id>" if it was
  // originally locked (i.e. it appears in another dialog's unlock_dialogs).
  // ─────────────────────────────────────────────────────────────────────────
  function canTrigger(dialog) {
    if (!dialog) return false;
    var req = dialog.requires;

    // If dialog has no requirements it's always available
    if (!req) return true;

    var stored = _load();

    // Check required flags
    var need = req.flags || [];
    for (var i = 0; i < need.length; i++) {
      if (stored.indexOf(need[i]) === -1) return false;
    }

    // Optional: min_level guard (level system TBD)
    // if (dialog.min_level && (global.playerLevel || 0) < dialog.min_level) return false;

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // completeDialog(dialog)
  // Applies dialog.on_complete: set_flags, unlock_areas, unlock_dialogs.
  // Fires CustomEvent "mdelo:dialog_complete" on document.
  // ─────────────────────────────────────────────────────────────────────────
  function completeDialog(dialog) {
    if (!dialog || !dialog.on_complete) return;
    var oc = dialog.on_complete;

    (oc.set_flags || []).forEach(function (f) { flagSet(f); });
    (oc.unlock_areas || []).forEach(function (areaId) { _unlockArea(areaId); });
    (oc.unlock_dialogs || []).forEach(function (dialogId) { flagSet('dialog_unlocked:' + dialogId); });

    // set_markers: #! ?კარიბჭე ~სახლი etc
    (oc.set_markers || []).forEach(function (m) {
      var el = document.querySelector('.hotspot[data-title="' + m.title + '"]:not(.hs-area)');
      if (!el) return;
      if (typeof _applyMarkerDom === 'function') _applyMarkerDom(el, m.mk);
      var oi = el.dataset.oi;
      if (oi != null && typeof _OBJS !== 'undefined' && _OBJS[+oi])
        _OBJS[+oi].marker = m.mk === '~' ? '...' : m.mk;
    });

    try {
      document.dispatchEvent(new CustomEvent('mdelo:dialog_complete', { detail: { dialog: dialog } }));
    } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // parseUnlockHeaders / unparseUnlockHeaders
  // Shared with runtime.js (_applyDlgOverride, dlgGetCurrentDsl)
  // ─────────────────────────────────────────────────────────────────────────
  function parseUnlockHeaders(raw) {
    var lines = raw.split('\n'), dslLines = [], requires = null, on_complete = null;
    lines.forEach(function(line) {
      var m;
      if ((m = line.match(/^#\?\s*(.+)/))) {
        var flags = m[1].split(/\s+/).map(function(s){ return s.trim(); }).filter(Boolean);
        if (flags.length) requires = { flags: flags };
      } else if ((m = line.match(/^#!\s*(.+)/))) {
        var tokens = m[1].split(/\s+/).filter(Boolean);
        var oc = { set_flags: [], unlock_dialogs: [], unlock_areas: [], set_markers: [] };
        tokens.forEach(function(t) {
          var ch = t.charAt(0);
          if      (ch === '>') oc.unlock_dialogs.push(t.slice(1));
          else if (ch === '*') oc.unlock_areas.push(t.slice(1));
          else if (ch === '!' || ch === '?' || ch === '~' || ch === '-')
            oc.set_markers.push({ mk: ch === '-' ? '' : ch, title: t.slice(1) });
          else oc.set_flags.push(t);
        });
        if (!oc.set_flags.length)      delete oc.set_flags;
        if (!oc.unlock_dialogs.length) delete oc.unlock_dialogs;
        if (!oc.unlock_areas.length)   delete oc.unlock_areas;
        if (!oc.set_markers.length)    delete oc.set_markers;
        if (Object.keys(oc).length)    on_complete = oc;
      } else { dslLines.push(line); }
    });
    return { dsl: dslLines.join('\n'), requires: requires, on_complete: on_complete };
  }

  function unparseUnlockHeaders(o) {
    var lines = [];
    if (o.requires && o.requires.flags && o.requires.flags.length)
      lines.push('#? ' + o.requires.flags.join(' '));
    if (o.on_complete) {
      var oc = o.on_complete, tokens = [];
      (oc.set_flags      || []).forEach(function(f){ tokens.push(f); });
      (oc.unlock_dialogs || []).forEach(function(f){ tokens.push('>'+f); });
      (oc.unlock_areas   || []).forEach(function(f){ tokens.push('*'+f); });
      (oc.set_markers    || []).forEach(function(m){ tokens.push((m.mk||'-')+m.title); });
      if (tokens.length) lines.push('#! ' + tokens.join(' '));
    }
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // isDialogUnlocked(dialogId)
  // True if another dialog's on_complete already called unlock_dialogs for it.
  // ─────────────────────────────────────────────────────────────────────────
  function isDialogUnlocked(dialogId) {
    return flagHas('dialog_unlocked:' + dialogId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Area unlock helpers
  // ─────────────────────────────────────────────────────────────────────────
  function _unlockArea(areaId) {
    flagSet('area_unlocked:' + areaId);
    // Activate any .hotspot[data-area-id] elements on the map
    var sel = '.hotspot[data-area-id="' + areaId + '"], .hs-area[data-area-id="' + areaId + '"]';
    var els = document.querySelectorAll(sel);
    els.forEach(function (el) {
      el.classList.remove('no-interact');
      // Add a dot marker if the element has no visible indicator yet
      if (!el.querySelector('.hs-marker') && !el.querySelector('.hs-dot')) {
        var dot = document.createElement('div');
        dot.className = 'hs-dot';
        el.appendChild(dot);
      }
    });
  }

  function isAreaUnlocked(areaId) {
    return flagHas('area_unlocked:' + areaId);
  }

  // Re-apply area unlocks on every page load (flags persist across sessions)
  function _restoreAreas() {
    _load().forEach(function (f) {
      if (f.indexOf('area_unlocked:') === 0) {
        _unlockArea(f.slice('area_unlocked:'.length));
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal /flag command handler
  //
  // Usage from terminal.js input handler:
  //   var parts = text.slice(1).split(/\s+/);
  //   if (parts[0] === 'flag') { unlockHandleCmd(parts); return; }
  //
  // Subcommands:
  //   /flag set <name>       — flag-ის დაყენება
  //   /flag clear <name>     — flag-ის წაშლა
  //   /flag check <name>     — flag-ის შემოწმება
  //   /flag list             — ყველა flag-ის სია
  //   /flag reset            — ყველა flag-ის გასუფთავება
  // ─────────────────────────────────────────────────────────────────────────
  function unlockHandleCmd(parts) {
    var sub = (parts[1] || '').toLowerCase();
    var arg = parts.slice(2).join(' ').trim();

    switch (sub) {
      case 'set':
      case 'დაყენება':
        if (!arg) { _pr('გამოყენება: /დროშა დაყენება <სახელი>', 'ter'); return true; }
        flagSet(arg);
        _pr('✓ flag დაყენდა: ' + arg, 'tok');
        return true;

      case 'clear':
      case 'del':
      case 'წაშლა':
        if (!arg) { _pr('გამოყენება: /დროშა წაშლა <სახელი>', 'ter'); return true; }
        if (flagClear(arg)) { _pr('✗ flag წაიშალა: ' + arg, 'tnf'); }
        else                { _pr('flag არ არსებობს: ' + arg, 'ter'); }
        return true;

      case 'check':
      case 'შემოწმება':
        if (!arg) { _pr('გამოყენება: /დროშა შემოწმება <სახელი>', 'ter'); return true; }
        _pr(arg + ': ' + (flagHas(arg) ? '✓ true' : '✗ false'),
            flagHas(arg) ? 'tok' : 'tnf');
        return true;

      case 'list':
      case 'ls':
      case 'სია':
        var fl = flagList();
        if (!fl.length) {
          _pr('flags: ცარიელი', 'tdm');
        } else {
          _pr('flags (' + fl.length + '):', 'tsy');
          fl.forEach(function (f) { _pr('  · ' + f, 'tdm'); });
        }
        return true;

      case 'reset':
      case 'გასუფთავება':
        flagReset();
        _pr('ყველა flag გასუფთავდა', 'tnf');
        return true;

      default:
        _pr('/დროშა  დაყენება|წაშლა|შემოწმება|სია|გასუფთავება', 'tsy');
        return true;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal print helper
  // Priority: tmPrint (terminal.js) → consolePrint (chat.js) → direct DOM
  // ─────────────────────────────────────────────────────────────────────────
  function _pr(msg, cls) {
    if (typeof global.tmPrint === 'function') {
      global.tmPrint(msg, cls || 'tdm');
      return;
    }
    // Direct DOM fallback (matches index.html terminal classes)
    var out = document.getElementById('tmOut');
    if (!out) return;
    var line = document.createElement('div');
    line.className = 'tl ' + (cls || 'tdm');
    line.textContent = msg;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: terminal.js now owns /flag dispatch directly (delegates to
  // unlockHandleCmd via _tmFlagDelegate) for both single-line and multiline
  // input. The old capture-phase #tmIn auto-hook was removed — it only
  // covered the single-line path and is now redundant/dead weight.
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────────────────
  function unlockInit() {
    _restoreAreas();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', unlockInit);
  } else {
    unlockInit();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────
  global.canTrigger            = canTrigger;
  global.completeDialog        = completeDialog;
  global.isDialogUnlocked      = isDialogUnlocked;
  global.isAreaUnlocked        = isAreaUnlocked;
  global.flagSet               = flagSet;
  global.flagClear             = flagClear;
  global.flagHas               = flagHas;
  global.flagList              = flagList;
  global.flagReset             = flagReset;
  global.unlockHandleCmd       = unlockHandleCmd;
  global.unlockInit            = unlockInit;
  global.parseUnlockHeaders    = parseUnlockHeaders;
  global.unparseUnlockHeaders  = unparseUnlockHeaders;

}(window));
