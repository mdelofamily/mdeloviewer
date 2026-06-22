// ============================================================
//  bulk-parser.js — Bulk DSL → dialogue[] converter
//  Depends on: nothing (pure functions)
//  Load order: after objects.js, before ui-palette.js
// ============================================================

//
// DSL syntax reference:
//   @N [marker] title        — node start  (marker: ! ? ...)
//   [speaker] text           — named speaker block
//   [] text                  — player name placeholder (runtime: mdelo_nick || "მოგზაური")
//   <> text                  — object speaker (runtime: ობიექტის სახელი = _dlgTitle)
//   <სახელი> text            — object speaker (კასტომ სახელი)
//   plain text               — narrator (სახელის გარეშე)
//   {atmosphere text}        — atmosphere / effect line
//   [[label|url]]            — external link (inline)
//   [[object name]]          — map object link (inline)
//   -> text =>N              — choice button, no notification
//   ->* text =>N             — choice + info notification
//   ->! text =>N             — choice + warning notification
//   ->~ text =>N             — choice + danger notification
//   ->+ text =>N             — choice + project notification
//   ->. text =>N             — choice + done notification
//   [$name]                  — button-level: run saved macro "name" on click
//                               (resolved via window.runMacro — local scope wins
//                               over საერთო on a name clash, same as /macro)
//
// speaker encoding in HTML:
//   <b class="spk-player">[]</b>        — [] player placeholder
//   <b class="spk-object">\x01name</b>  — <> object (\x01 = empty = use _dlgTitle)
//   <b class="spk-named">name</b>       — [name] named speaker
//
// Returns: { nodes: Array, title: string, marker: string }
//   nodes  — dialogue[] ready for _editingDialogue
//   title  — object title from @0 header (may be "")
//   marker — object marker from @0 header (! ? 💬 or "")
//

// ── OBJ_PREFIX: internal marker for object speakers ─────────
const _OBJ_PREFIX = '__OBJ__';

function parseBulkDSL(raw) {
  const lines  = raw.replace(/\r\n/g, '\n').split('\n');
  const result = [];

  let cur     = null;   // node being built
  let speaker = null;   // null=narrator | ""=player | "\x01name"=object | "name"=named
  let textBuf = [];     // accumulated lines for current text block

  let rootTitle  = '';
  let rootMarker = '';

  // flush accumulated text buffer into cur.text as HTML
  function flush() {
    if (!cur || !textBuf.length) { textBuf = []; return; }
    const block = textBuf.join(' ').trim();
    if (!block) { textBuf = []; return; }

    let html;
    if (speaker === null) {
      // narrator — plain text, no speaker label
      html = _esc(block);
    } else if (speaker === '') {
      // [] — player placeholder, resolved at runtime
      html = '<b class="spk-player">[]</b> ' + _esc(block);
    } else if (speaker.startsWith(_OBJ_PREFIX)) {
      // <> or <name> — object speaker
      // store raw name after prefix; empty = use _dlgTitle at runtime
      const objName = speaker.slice(_OBJ_PREFIX.length);
      html = '<b class="spk-object">' + _esc(_OBJ_PREFIX + objName) + '</b> ' + _esc(block);
    } else {
      // [name] — named speaker
      html = '<b class="spk-named">' + _esc(speaker) + '</b> ' + _esc(block);
    }

    cur.text += (cur.text ? '<br>' : '') + html;
    textBuf = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // ── @N node header ──────────────────────────────────────
    if (/^@\d/.test(line)) {
      if (cur) { flush(); result.push(cur); }

      const m      = line.match(/^@(\d+)\s*(\.\.\.|[!?])?\s*(.*)/);
      const idx    = m ? m[1] : '0';
      const mrkRaw = m ? (m[2] || '').trim() : '';
      const title  = m ? (m[3] || '').trim() : '';
      const marker = mrkRaw === '!'   ? '!'   :
                     mrkRaw === '?'   ? '?'   :
                     mrkRaw === '...' ? '...' : '';

      if (idx === '0') { rootTitle = title; rootMarker = marker; }

      cur     = { id: 'node_' + idx, text: '', buttons: [] };
      speaker = null;
      textBuf = [];
      continue;
    }

    if (!cur) continue;

    // ── #if flag =>N conditional redirect ───────────────────────
    if (/^>>\s/.test(line)) {
      const ifM = line.match(/^>>\s+(\S+)\s*=>(\d+)/);
      if (ifM) cur.condition = { flag: ifM[1], target: 'node_' + ifM[2] };
      continue;
    }

    // ── choice line ──────────────────────────────────────────
    if (/^->/.test(line)) {
      flush();
      const btn = _parseBtn(line);
      if (btn) {
        cur.buttons.push(btn);
      }
      continue;
    }

    // ── atmosphere {text} ────────────────────────────────────
    const atmM = line.match(/^\{(.+)\}$/);
    if (atmM) {
      flush();
      speaker = null;
      cur.text += (cur.text ? '<br>' : '') + '✦ ' + _esc(atmM[1].trim());
      continue;
    }

    // ── object speaker <> or <name> ──────────────────────────
    // must be checked BEFORE [] to avoid conflict
    const objM = line.match(/^<([^>]*)>(.*)/);
    if (objM) {
      flush();
      speaker = _OBJ_PREFIX + objM[1].trim();  // \x01 + name (empty = auto)
      const rest = objM[2].trim();
      if (rest) textBuf.push(rest);
      continue;
    }

    // ── player/named speaker [] or [name] ────────────────────
    const spkM = line.match(/^\[([^\]]*)\](.*)/);
    if (spkM) {
      flush();
      speaker    = spkM[1];           // "" = player, "name" = named
      const rest = spkM[2].trim();
      if (rest) textBuf.push(rest);
      continue;
    }

    // ── empty line → flush block, reset speaker ──────────────
    if (!line.trim()) {
      flush();
      speaker = null;
      continue;
    }

    // ── regular text line (narrator) ─────────────────────────
    textBuf.push(line.trim());
  }

  // finalize last node
  if (cur) { flush(); result.push(cur); }

  return { nodes: result, title: rootTitle, marker: rootMarker };
}

// ── choice line parser ──────────────────────────────────────
// notify type chars: * info  ! warning  ~ danger  + project  . done
//
// Full button DSL syntax:
//   -> label                     — close popup (or go to =>N)
//   -> label =>N                 — jump to node N
//   -> label |https://url        — open URL in new tab
//   -> label @@ზონის სახელი      — navigate map to area (fitAreas)
//   -> label [$macro_name]      — run saved macro (window.runMacro) on click
//   ->* label >> notify text    — sends "notify text" to the notification feed
//                                  instead of "label" (label stays on the button;
//                                  falls back to label if >> isn't used)
//   ->* label @@area |url =>N   — all modifiers can combine
//   notify prefix: ->*  ->!  ->~  ->+  ->.
//
const _NOTIFY_TYPES = { '*': 'info', '!': 'warning', '~': 'danger', '+': 'project', '.': 'done' };

function _parseBtn(line) {
  let rest = line;
  let notify = false;
  let notifyType = '';

  // detect ->X where X is a notify type char
  if (rest.length > 2 && _NOTIFY_TYPES[rest[2]]) {
    notify     = true;
    notifyType = _NOTIFY_TYPES[rest[2]];
    rest       = rest.slice(3).trim();
  } else {
    rest = rest.slice(2).trim();
  }

  // extract =>N at end
  let nextNode = '';
  const nxtM = rest.match(/^(.*?)\s*=>(\d+)\s*$/);
  if (nxtM) {
    rest     = nxtM[1].trim();
    nextNode = 'node_' + nxtM[2];
  }

  // bracket tokens [^..]/[+..]/[$..] — extracted BEFORE |url and @@area.
  // These regexes match anywhere in the string regardless of position, so
  // pulling them out first means a bracket token can sit before OR after
  // @@area / |url in the DSL line without being swallowed by their
  // end-anchored "\s*$" matching (which previously ate trailing brackets
  // as part of the area/url capture).

  // [^Xსახელი] marker effect tokens e.g. [^?კარიბჭე] [^~სახლი]
  const markers = [];
  rest = rest.replace(/\[\^([!?~-])([^\]]+)\]/g, function(_, mk, title) {
    markers.push({ mk: mk === '-' ? '' : mk === '~' ? '💬' : mk, title: title.trim() });
    return '';
  }).trim();

  // [+flag_name] — button-level flag set e.g. [+gate_entered]
  const flags = [];
  rest = rest.replace(/\[\+([^\]]+)\]/g, function(_, name) {
    flags.push(name.trim());
    return '';
  }).trim();

  // [$macro_name] — button-level: run saved macro on click (window.runMacro)
  const cmds = [];
  rest = rest.replace(/\[\$([^\]]+)\]/g, function(_, name) {
    cmds.push(name.trim());
    return '';
  }).trim();

  // extract trailing |url  (no spaces in URL)
  let link = '';
  const linkM = rest.match(/^(.*?)\s*\|(\S+)\s*$/);
  if (linkM) { link = linkM[2]; rest = linkM[1].trim(); }

  // extract trailing @@area name  (may contain spaces, must come after |url extraction)
  let area = '';
  const areaM = rest.match(/^(.*?)\s*@@(.+?)\s*$/);
  if (areaM) { area = areaM[2].trim(); rest = areaM[1].trim(); }

  // "label >> notify text" — separates the button's own caption from a
  // different message sent to the notification feed (runtime.js falls back
  // to the label itself when notifyText isn't set)
  let notifyText = '';
  const ntM = rest.match(/^(.*?)\s*>>\s*(.+)$/);
  if (ntM) { rest = ntM[1].trim(); notifyText = ntM[2].trim(); }

  if (!rest) return null;
  return { label: rest, nextNode, notify, notifyType, link, area, markers, flags, cmds, notifyText };
}

// ── minimal HTML escape ─────────────────────────────────────
function _esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── dialogue[] → DSL serializer ────────────────────────────
function unparseDialogue(o) {
  const nodes  = o.dialogue || [];
  const title  = o.title  || o.lb || '';
  const marker = o.marker || '';
  if (!nodes.length && !title) return '';

  const mrkSym = marker === '!' ? '!' : marker === '?' ? '?' : marker === '💬' ? '...' : '';
  const lines  = [];

  nodes.forEach((node, ni) => {
    // node header
    const hdr = '@' + ni +
      (mrkSym && ni === 0 ? ' ' + mrkSym : '') +
      (title  && ni === 0 ? ' ' + title  : '');
    lines.push(hdr);

    // >> flag =>N condition
    if (node.condition) {
      lines.push('>> ' + node.condition.flag + ' =>' + node.condition.target.replace('node_', ''));
    }

    // text — strip HTML back to DSL
    if (node.text) {
      const plain = node.text
        .replace(/<br>/gi, '\n')
        // [] player placeholder
        .replace(/<b[^>]*class="spk-player"[^>]*>\[\]<\/b>\s*/gi, '[] ')
        // <> object speaker: extract stored name after \x01
        .replace(/<b[^>]*class="spk-object"[^>]*>([^<]*)<\/b>\s*/gi, (_, inner) => {
          // inner is escaped \x01name — unescape &lt; etc then strip \x01
          const raw = inner
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          const name = raw.startsWith(_OBJ_PREFIX) ? raw.slice(_OBJ_PREFIX.length) : raw;
          return '<' + name + '> ';
        })
        // [name] named speaker
        .replace(/<b[^>]*class="spk-named"[^>]*>([^<]*)<\/b>\s*/gi, (_, inner) => {
          const name = inner
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          return '[' + name + '] ';
        })
        // legacy bold (editor-written, no class) — uses a function callback here
        // (not a literal replacement string), since this file's raw text gets
        // embedded by export-html.js via tmpl.replace(/{{BULK_PARSER_JS}}/g, ...),
        // and a dollar sign directly followed by a digit in a *string*
        // replacement argument is a special capture-group token there — it
        // would get silently swallowed in the exported output.
        .replace(/<b>\[\]<\/b>\s*/gi, '[] ')
        .replace(/<b>([^<]*)<\/b>\s*/gi, (_, name) => '[' + name + '] ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g,  '<')
        .replace(/&gt;/g,  '>');
      plain.split('\n').forEach(l => {
        if (!l.trim()) return;
        const t = l.trim();
        if (t.startsWith('✦ ')) {
          lines.push('{' + t.slice(2) + '}');  // restore atmosphere syntax
        } else {
          lines.push(t);
        }
      });
    }

    // buttons
    const _TYPE_CHARS = { info: '*', warning: '!', danger: '~', project: '+', done: '.' };
    (node.buttons || []).forEach(btn => {
      if (!btn.label) return;
      const next     = btn.nextNode ? ' =>' + btn.nextNode.replace('node_', '') : '';
      const areaPart = btn.area ? ' @@' + btn.area : '';
      const linkPart = btn.link ? ' |'  + btn.link : '';
      const mkPart   = (btn.markers || []).map(m => ' [^' + (m.mk || '-') + m.title + ']').join('');
      const flagPart = (btn.flags   || []).map(f => ' [+' + f + ']').join('');
      // NOTE: built via fromCharCode(36), not a literal dollar sign next to a
      // quote — export-html.js embeds this whole file as a *string*
      // replacement (tmpl.replace(/{{BULK_PARSER_JS}}/g, bulkParserJS)), and a
      // dollar sign directly followed by an apostrophe in that string is a
      // special JS replace-token (inserts the text after the match) — it
      // would splice the rest of the HTML template into the middle of this
      // script and corrupt the export.
      const cmdPart  = (btn.cmds || []).map(c => ' [' + String.fromCharCode(36) + c + ']').join('');
      // "label >> notify text" — must sit between the label and the
      // area/link/bracket/=>N suffix, since _parseBtn strips those first and
      // only then splits whatever remains on '>>'
      const ntPart   = btn.notifyText ? ' >> ' + btn.notifyText : '';
      const suffix   = areaPart + linkPart + mkPart + flagPart + cmdPart + next;
      if (btn.notify) {
        const tc = _TYPE_CHARS[btn.notifyType] || '*';
        lines.push('->' + tc + ' ' + btn.label + ntPart + suffix);
      } else {
        lines.push('-> ' + btn.label + ntPart + suffix);
      }
    });

    if (ni < nodes.length - 1) lines.push('');
  });

  return lines.join('\n');
}

// ── WINDOW BINDINGS ────────────────────────────────────────
window.parseBulkDSL    = parseBulkDSL;
window.unparseDialogue = unparseDialogue;
