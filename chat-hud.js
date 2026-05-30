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
        'bottom:48px;left:16px;',
        'z-index:9000;',
        'pointer-events:none;',
        'display:flex;flex-direction:column;gap:2px;',
        'max-width:340px;',
      '}',
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
  // Wrap the existing one (terminal still gets it too)
  var _origPrint = global.consolePrint;

  global.consolePrint = function (html, type) {
    // Forward to terminal always
    if (typeof _origPrint === 'function') _origPrint(html, type);
    // HUD only when terminal is closed and message is real chat
    var termOpen = typeof _tmOpen !== 'undefined' && _tmOpen;
    if (type === 'chat' && !termOpen) _addLine(html);
  };

  // ── Re-hook if consolePrint is set later ─────────────────────────────────
  // (chat.js sets window.consolePrint at parse time — if chat-hud.js loads
  //  after, the reference above already captured it. Safe.)

  // ── Public ────────────────────────────────────────────────────────────────
  global.chatHudAddLine = _addLine;

}(window));
