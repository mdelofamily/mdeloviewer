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

const _OBJ_PREFIX = '\x01';

function parseBulkDSL(raw) {
  const lines  = raw.replace(/\r\n/g, '\n').split('\n');
  const result = [];

  let cur     = null;   // node being built
  let speaker = null;   // null=narrator | ""=player | "\x01name"=object | "name"=named
  let textBuf = [];     // accumulated lines for current text block

  let rootTitle  = '';
  let rootMarker = '';

  function flush() {
    if (!cur || !textBuf.length) { textBuf = []; return; }
    const block = textBuf.join(' ').trim();
    if (!block) { textBuf = []; return; }

    let html;
    if (speaker === null) {
      html = _esc(block);
    } else if (speaker === '') {
      html = '<b class="spk-player">[]</b> ' + _esc(block);
    } else if (speaker.startsWith(_OBJ_PREFIX)) {
      const objName = speaker.slice(1);
      const finalName = objName || rootTitle || "";
      html = '<b class="spk-object">' + _esc(_OBJ_PREFIX + finalName) + '</b> ' + _esc(block);
    } else {
      html = '<b class="spk-named">' + _esc(speaker) + '</b> ' + _esc(block);
    }

    cur.text += (cur.text ? '<br>' : '') + html;
    textBuf = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

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

    if (/^->/.test(line)) {
      flush();
      const btn = _parseBtn(line);
      if (btn) {
        if (cur.buttons.length < 3) {
          cur.buttons.push(btn);
        }
      }
      continue;
    }

    const atmM = line.match(/^\{(.+)\}$/);
    if (atmM) {
      flush();
      speaker = null;
      cur.text += (cur.text ? '<br>' : '') + _esc(atmM[1].trim());
      continue;
    }

    const objM = line.match(/^<([^>]*)>(.*)/);
    if (objM) {
      flush();
      speaker = _OBJ_PREFIX + objM[1].trim();
      const rest = objM[2].trim();
      if (rest) textBuf.push(rest);
      continue;
    }

    const spkM = line.match(/^\[([^\]]*)\](.*)/);
    if (spkM) {
      flush();
      speaker    = spkM[1];
      const rest = spkM[2].trim();
      if (rest) textBuf.push(rest);
      continue;
    }

    if (!line.trim()) {
      flush();
      speaker = null;
      continue;
    }

    textBuf.push(line.trim());
  }

  if (cur) { flush(); result.push(cur); }

  return { nodes: result, title: rootTitle, marker: rootMarker };
}

function _parseBtn(line) {
  let rest   = line;
  let notify = false;

  if (rest.startsWith('->!')) {
    notify = true;
    rest   = rest.slice(3).trim();
  } else {
    rest = rest.slice(2).trim();
  }

  let nextNode = '';
  const nxtM = rest.match(/^(.*?)\s*=>(\d+)\s*$/);
  if (nxtM) {
    rest     = nxtM[1].trim();
    nextNode = 'node_' + nxtM[2];
  }

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

function unparseDialogue(o) {
  const nodes  = o.dialogue || [];
  const title  = o.title  || o.lb || '';
  const marker = o.marker || '';
  if (!nodes.length && !title) return '';

  const mrkSym = marker === '!' ? '!' : marker === '?' ? '?' : marker === '💬' ? '...' : '';
  const lines  = [];

  nodes.forEach((node, ni) => {
    const hdr = '@' + ni +
      (mrkSym && ni === 0 ? ' ' + mrkSym : '') +
      (title  && ni === 0 ? ' ' + title  : '');
    lines.push(hdr);

    if (node.text) {
      const plain = node.text
        .replace(/<br>/gi, '\n')
