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
//   ->! text =>N             — choice + notification (auto text)
//   -> text ->! notif =>N    — choice + explicit notification text
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
const _OBJ_PREFIX = '\x01';

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
      const objName = speaker.slice(1);
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

    // ── choice line ──────────────────────────────────────────
    if (/^->/.test(line)) {
      flush();
      const btn = _parseBtn(line);
      if (btn) {
        if (cur.buttons.length < 3) {
          cur.buttons.push(btn);
        }
        // silently drop 4th+ buttons (editor limit is 3)
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
function _parseBtn(line) {
  let rest   = line;
  let notify = false;

  // strip leading ->! or ->
  if (rest.startsWith('->!')) {
    notify = true;
    rest   = rest.slice(3).trim();
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

  // extract inline " ->! notif_text" separator
  let notifyText = '';
  const sep = rest.indexOf(' ->! ');
  if (sep >= 0) {
    notifyText = rest.slice(sep + 5).trim();
    rest       = rest.slice(0, sep).trim();
    notify     = true;
  }

  if (!rest) return null;
  return { label: rest, nextNode, notify, notifyText, link: '' };
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
          const name = raw.startsWith(_OBJ_PREFIX) ? raw.slice(1) : raw;
          return '<' + name + '> ';
        })
        // [name] named speaker
        .replace(/<b[^>]*class="spk-named"[^>]*>([^<]*)<\/b>\s*/gi, (_, inner) => {
          const name = inner
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          return '[' + name + '] ';
        })
        // legacy bold (editor-written, no class)
        .replace(/<b>\[\]<\/b>\s*/gi, '[] ')
        .replace(/<b>([^<]*)<\/b>\s*/gi, '[$1] ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g,  '<')
        .replace(/&gt;/g,  '>');
      plain.split('\n').forEach(l => { if (l.trim()) lines.push(l.trim()); });
    }

    // buttons
    (node.buttons || []).forEach(btn => {
      if (!btn.label) return;
      const next = btn.nextNode ? ' =>' + btn.nextNode.replace('node_', '') : '';
      if (btn.notify && !btn.notifyText) {
        lines.push('->!' + btn.label + next);
      } else if (btn.notify && btn.notifyText) {
        lines.push('-> ' + btn.label + ' ->! ' + btn.notifyText + next);
      } else {
        lines.push('-> ' + btn.label + next);
      }
    });

    if (ni < nodes.length - 1) lines.push('');
  });

  return lines.join('\n');
}

// ── WINDOW BINDINGS ────────────────────────────────────────
window.parseBulkDSL    = parseBulkDSL;
window.unparseDialogue = unparseDialogue;
