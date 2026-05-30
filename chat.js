// chat.js — Mdelo Viewer Live Chat
// mIRC-style over Supabase Realtime (Broadcast + Presence)
// No ES modules. Everything on window.
// Load AFTER: supabase CDN script, viewer console script.

(function (global) {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  // Injected by export-html.js at export time:
  //   window.SUPABASE_URL      = "https://xxx.supabase.co"
  //   window.SUPABASE_ANON_KEY = "eyJ..."
  //   window.MDELO_ROOM_ID     = "map_<slug>"   (per-map room)
8
  var CFG = {
    url    : global.SUPABASE_URL      || '',
    key    : global.SUPABASE_ANON_KEY || '',
    roomId : global.MDELO_ROOM_ID     || 'mdelo-global',
  };

  // ── Nick colour palette (mIRC-inspired) ───────────────────────────────────
  var PALETTE = [
    '#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff',
    '#c77dff', '#ff9a3c', '#00cfff', '#ff6eb4',
    '#a8ff78', '#ff8c00', '#7ee8fa', '#b8e986',
  ];

  // ── Slash-command help strings ────────────────────────────────────────────
  var CMD_HELP = [
    '/nick &lt;სახელი&gt;   — nickname-ის შეცვლა',
    '/me &lt;action&gt;    — action message (*nick does something*)',
    '/color &lt;#hex&gt;   — nickname-ის ფერი',
    '/who              — ონლაინ მომხმარებლები',
    '/clear            — ეკრანის გასუფთავება',
    '/help             — ეს სია',
  ];

  // ── Runtime state ─────────────────────────────────────────────────────────
  var _sbClient   = null;   // supabase client
  var _channel    = null;   // realtime channel
  var _ready      = false;  // true once SUBSCRIBED
  var _online     = {};     // nick → { color }  (others only)

  // ── Nickname (persisted in localStorage) ─────────────────────────────────
  var _nick = {
    get name()  { return localStorage.getItem('mdelo_nick')  || _makeGuest(); },
    set name(v) { localStorage.setItem('mdelo_nick', v); },
    get color() { return localStorage.getItem('mdelo_color') || _hashColor(this.name); },
    set color(c){ localStorage.setItem('mdelo_color', c); },
  };

  function _makeGuest() {
    var n = 'visitor_' + (Math.random() * 9000 + 1000 | 0);
    localStorage.setItem('mdelo_nick', n);
    return n;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function _hash(s) {
    var h = 0, i;
    for (i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
    return h;
  }

  function _hashColor(nick) {
    return PALETTE[Math.abs(_hash(nick)) % PALETTE.length];
  }

  function _ts() {
    var d = new Date();
    return (d.getHours() % 12 || 12) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Print to console ──────────────────────────────────────────────────────
  // Priority: window.consolePrint(html) → DOM #consoleLog → silent
  function _print(html, type) {
    if (typeof global.consolePrint === 'function') {
      global.consolePrint(html, type || 'sys');
    }
  }

  function _sys(msg) {
    _print(
      '<span style="color:#666">[' + _ts() + ']</span>' +
      ' <span style="color:#999">* ' + msg + '</span>',
      'sys'
    );
  }

  function _err(msg) {
    _print('<span style="color:#ff4444">⚠ ' + _esc(msg) + '</span>', 'sys');
  }

  function _printMsg(nick, color, text, isAction) {
    var t  = '<span style="color:#888">[' + _ts() + ']</span> ';
    var n  = '<span style="font-weight:bold;color:' + color + '">' + _esc(nick) + '</span>';
    var tx = '<span style="color:#ddd">' + _esc(text) + '</span>';

    if (isAction) {
      _print(t + '<span style="color:#bbb">* ' + n + ' ' + tx + '</span>', 'chat');
    } else {
      _print(t + '&lt;' + n + '&gt; ' + tx, 'chat');
    }
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  function _cmdNick(args) {
    if (!args[0]) { _err('გამოყენება: /nick <სახელი>'); return; }
    // Allow Georgian + latin + digits + underscore, max 24 chars
    var val = args[0].replace(/[^a-zA-Z0-9_\u10d0-\u10ff]/g, '').slice(0, 24);
    if (!val) { _err('არასწორი სახელი (latin/ქართული/_ ნებადართულია)'); return; }
    var old = _nick.name;
    _nick.name  = val;
    _nick.color = _hashColor(val);       // reset to hash; /color overrides later
    _sys(
      'სახელი: <b>' + _esc(old) + '</b> → ' +
      '<b style="color:' + _nick.color + '">' + _esc(val) + '</b>'
    );
    _updatePresence();
  }

  function _cmdColor(args) {
    var c = args[0] || '';
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) {
      _err('გამოყენება: /color #rgb ან /color #rrggbb');
      return;
    }
    _nick.color = c;
    _sys('ფერი: <span style="color:' + c + '">■■■ ' + c + '</span>');
    _updatePresence();
  }

  function _cmdMe(args) {
    if (!args.length) return;
    var text = args.join(' ');
    _broadcast({ type: 'action', text: text });
    _printMsg(_nick.name, _nick.color, text, true);   // optimistic
  }

  function _cmdWho() {
    var entries = Object.keys(_online);
    if (!entries.length) {
      _sys('ონლაინ: <b>მხოლოდ შენ</b>');
      return;
    }
    _sys('ონლაინ (' + (entries.length + 1) + '):');
    // Own nick first
    _print(
      '  <span style="color:' + _nick.color + '">● ' +
      _esc(_nick.name) + '</span> <span style="color:#555">(შენ)</span>'
    );
    entries.forEach(function (nick) {
      var c = _online[nick] ? _online[nick].color : '#888';
      _print('  <span style="color:' + c + '">● ' + _esc(nick) + '</span>');
    });
  }

  function _cmdClear() {
    if (typeof global.consoleClear === 'function') { global.consoleClear(); return; }
    var log = document.getElementById('consoleLog')
           || document.getElementById('console-log')
           || document.querySelector('.console-log');
    if (log) log.innerHTML = '';
  }

  function _cmdHelp() {
    _sys('─── Chat ───────────────────────');
    CMD_HELP.forEach(function (line) {
      _print('<span style="color:#4d96ff;font-family:monospace">  ' + line + '</span>');
    });
    _sys('────────────────────────────────');
  }

  // ── Public input handler ──────────────────────────────────────────────────
  // Call this from your console's input handler BEFORE processing own commands.
  // Returns true  → chat handled it, do not process further.
  // Returns false → unknown /command, let console handle it.
  function chatHandleInput(raw) {
    var text = (raw || '').trim();
    if (!text) return false;

    if (text.charAt(0) === '/') {
      var parts = text.slice(1).split(/\s+/);
      var cmd   = parts[0].toLowerCase();
      var args  = parts.slice(1);

      switch (cmd) {
        case 'nick':  _cmdNick(args);  return true;
        case 'color': _cmdColor(args); return true;
        case 'me':    _cmdMe(args);    return true;
        case 'who':   _cmdWho();       return true;
        case 'debug':
          _sys('=== chat debug ===');
          _sys('url: ' + (CFG.url ? CFG.url.slice(0,30)+'...' : 'EMPTY'));
          _sys('key: ' + (CFG.key ? CFG.key.slice(0,12)+'...' : 'EMPTY'));
          _sys('room: ' + CFG.roomId);
          _sys('ready: ' + _ready);
          _sys('sdk: ' + (typeof global.supabase));
          _sys('channel: ' + (_channel ? _channel.state || 'exists' : 'null'));
          return true;
        case 'clear': _cmdClear();     return true;
        case 'help':  _cmdHelp();      return true;
        default: return false;   // pass to console
      }
    }

    // Plain text → broadcast as chat message
    if (!_ready) {
      _err('ჩატი არ არის დაკავშირებული — შეამოწმე Supabase config.');
      return true;
    }
    _broadcast({ type: 'msg', text: text });
    _printMsg(_nick.name, _nick.color, text, false);  // optimistic echo
    return true;
  }

  // ── Supabase broadcast helpers ────────────────────────────────────────────
  function _broadcast(payload) {
    if (!_channel) return;
    _channel.send({
      type    : 'broadcast',
      event   : 'chat',
      payload : Object.assign({
        nick  : _nick.name,
        color : _nick.color,
        ts    : Date.now(),
      }, payload),
    });
  }

  function _updatePresence() {
    if (!_channel) return;
    _channel.track({
      nick      : _nick.name,
      color     : _nick.color,
      online_at : new Date().toISOString(),
    });
  }

  // ── Realtime event handlers ───────────────────────────────────────────────
  function _onBroadcast(evt) {
    var p = evt.payload;
    if (!p || p.nick === _nick.name) return;  // skip own (self:false but safety)
    if (p.type === 'msg')    _printMsg(p.nick, p.color, p.text, false);
    if (p.type === 'action') _printMsg(p.nick, p.color, p.text, true);
  }

  function _onPresenceSync() {
    var state = _channel.presenceState();
    _online = {};
    Object.keys(state).forEach(function (ref) {
      state[ref].forEach(function (p) {
        if (p.nick && p.nick !== _nick.name) {
          _online[p.nick] = { color: p.color || '#888' };
        }
      });
    });
  }

  function _onPresenceJoin(evt) {
    (evt.newPresences || []).forEach(function (p) {
      if (!p.nick || p.nick === _nick.name) return;
      _online[p.nick] = { color: p.color || '#888' };
      _sys(
        '<span style="color:' + (p.color || '#888') + '">' +
        _esc(p.nick) + '</span> შემოვიდა'
      );
    });
  }

  function _onPresenceLeave(evt) {
    (evt.leftPresences || []).forEach(function (p) {
      if (!p.nick || p.nick === _nick.name) return;
      var c = (_online[p.nick] || {}).color || '#666';
      delete _online[p.nick];
      _sys(
        '<span style="color:' + c + '">' +
        _esc(p.nick) + '</span> გავიდა'
      );
    });
  }

  // ── Supabase init ─────────────────────────────────────────────────────────
  function _initSupabase() {
    if (!CFG.url || !CFG.key) {
      _sys('⚠ Supabase config არ არის. ჩატი გამორთულია.');
      return;
    }

    var sb = global.supabase;
    if (!sb || typeof sb.createClient !== 'function') {
      _err('Supabase SDK ვერ ჩაიტვირთა.');
      return;
    }

    _sys('SDK მზადაა, ვქმნით კლიენტს...');

    try {
      // Always create a fresh client — never reuse notification client
      _sbClient = sb.createClient(CFG.url, CFG.key);
    } catch (e) {
      _err('createClient შეცდომა: ' + e.message);
      return;
    }

    _sys('კლიენტი შეიქმნა, ვუკავშირდებით channel-ს...');

    try {
      _channel = _sbClient
        .channel(CFG.roomId, {
          config: {
            broadcast : { self: false },
            presence  : { key: '' },
          },
        })
        .on('broadcast', { event: 'chat' }, _onBroadcast)
        .on('presence',  { event: 'sync'  }, _onPresenceSync)
        .on('presence',  { event: 'join'  }, _onPresenceJoin)
        .on('presence',  { event: 'leave' }, _onPresenceLeave)
        .subscribe(function (status, err) {
          _sys('Realtime status → ' + status + (err ? ' [' + err.message + ']' : ''));
          if (status === 'SUBSCRIBED') {
            _ready = true;
            _updatePresence();
            _sys(
              'ჩატი მზადაა &nbsp;|&nbsp; ' +
              '<span style="color:' + _nick.color + '">' + _esc(_nick.name) + '</span>' +
              ' &nbsp;|&nbsp; <span style="color:#555">/help</span>'
            );
          } else if (status === 'CHANNEL_ERROR') {
            _ready = false;
            _err('CHANNEL_ERROR' + (err ? ': ' + err.message : '') + ' — გადატვირთე.');
          } else if (status === 'TIMED_OUT') {
            _ready = false;
            _err('TIMED_OUT — კავშირი ვერ დამყარდა.');
          } else if (status === 'CLOSED') {
            _ready = false;
            _sys('CLOSED — კავშირი დაიხურა.');
          }
        });
    } catch (e) {
      _err('channel შეცდომა: ' + e.message);
      return;
    }

    _sys('subscribe გაგზავნილია, ველოდებით...');
  }

  // ── chatInit ──────────────────────────────────────────────────────────────
  // Call once the page is ready (DOMContentLoaded or end-of-body).
  function chatInit() {
    // Poll for Supabase CDN (async script may still be loading)
    if (typeof global.supabase === 'undefined') {
      var tries = 0;
      var poll  = setInterval(function () {
        if (typeof global.supabase !== 'undefined') {
          clearInterval(poll);
          _initSupabase();
        } else if (++tries > 30) {
          clearInterval(poll);
          _err('Supabase SDK 7.5წმ-ში ვერ ჩაიტვირთა.');
        }
      }, 250);
    } else {
      _initSupabase();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  global.chatInit        = chatInit;
  global.chatHandleInput = chatHandleInput;   // call from console input handler
  global.chatGetNick     = function () { return _nick.name;  };
  global.chatGetColor    = function () { return _nick.color; };
  global.chatIsReady     = function () { return _ready;      };

 // 🔥 ავტომატური ინიციალიზაცია ჩატვირთვისთანავე
  chatInit();

}(window));
