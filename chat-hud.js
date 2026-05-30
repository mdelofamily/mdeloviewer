// chat-hud.js — Quake-style incoming message overlay
// Shows last N chat lines bottom-left, fades out after timeout.
// No ES modules. Load after chat.js.

(function (global) {
  'use strict';

  var MAX_LINES   = 5;      // max visible lines
  var FADE_AFTER  = 6000;   // ms before fade starts
  var FADE_DUR    = 1200;   // fade transition ms

  var _el     = null;   // hud container
  var _lines  = [];     // { el, timer }

  // ── Build DOM ─────────────────────────────────────────────────────────────
  function _build() {
    if (_el) return;
    var style = document.createElement('style');
    style.textContent = [
      '#chatHud{',
        'position:fixed;',
        'top:60px;left:16px;',
        'z-index:9000;',
        'pointer-events:none;',
        'display:flex;flex-direction:column;gap:2px;',
        'max-width:340px;',
        'transition:opacity 0.2s;',
      '}',
      '#chatHud.hud-hidden{opacity:0;}',
      '.chud-line{',
        'font:13px/1.45 "Courier New",monospace;',
        'color:#e6edf3;',
        'text-shadow:0 1px 4px #000,0 0 8px #000;',
        'padding:1px 0;',
        'opacity:1;',
        'transition:opacity ' + FADE_DUR + 'ms ease;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      '}',
      '.chud-line.faded{opacity:0;}',
    ].join('');
    document.head.appendChild(style);

    _el = document.createElement('div');
    _el.id = 'chatHud';
    document.body.appendChild(_el);
  }

  // ── Add a line ─────────────────────────────────────────────────────────────
  function _addLine(html) {
    _build();

    // Remove oldest if over limit
    if (_lines.length >= MAX_LINES) {
      var old = _lines.shift();
      clearTimeout(old.timer);
      if (old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }

    var div = document.createElement('div');
    div.className = 'chud-line';
    div.innerHTML = html;
    _el.appendChild(div);

    var entry = { el: div, timer: null };
    _lines.push(entry);

    // Schedule fade
    entry.timer = setTimeout(function () {
      div.classList.add('faded');
      setTimeout(function () {
        if (div.parentNode) div.parentNode.removeChild(div);
        _lines = _lines.filter(function (l) { return l.el !== div; });
      }, FADE_DUR);
    }, FADE_AFTER);
  }

  // ── Override consolePrint ─────────────────────────────────────────────────
  var _origPrint = global.consolePrint;

  global.consolePrint = function (html, type) {
    if (typeof _origPrint === 'function') _origPrint(html, type);
    var termOpen = global._tmOpen;
    if (type === 'chat' && !termOpen) _addLine(html);
  };

  // ── Hide HUD when terminal opens, show when it closes ────────────────────
  function _syncHud() {
    if (!_el) return;
    _el.classList.toggle('hud-hidden', !!global._tmOpen);
  }

  // Poll until toggleTerm/closeTerm exist, then wrap them
  var _hookTries = 0;
  var _hookPoll = setInterval(function () {
    if (typeof global.toggleTerm === 'function' && typeof global.closeTerm === 'function') {
      clearInterval(_hookPoll);
      var origToggle = global.toggleTerm;
      var origClose  = global.closeTerm;
      global.toggleTerm = function () { origToggle.apply(this, arguments); setTimeout(_syncHud, 30); };
      global.closeTerm  = function () { origClose.apply(this, arguments);  setTimeout(_syncHud, 30); };
    } else if (++_hookTries > 40) {
      clearInterval(_hookPoll);
    }
  }, 150);

  // ── Public ────────────────────────────────────────────────────────────────
  global.chatHudAddLine = _addLine;

}(window));
