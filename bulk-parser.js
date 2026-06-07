// ============================================================
//  bulk-parser.js — Bulk DSL → dialogue[] converter
//  Depends on: nothing (pure functions)
//  Load order: after objects.js, before ui-palette.js
// ============================================================

const _OBJ_PREFIX = '\x01';

function parseBulkDSL(raw) {
  const lines  = raw.replace(/\r\n/g, '\n').split('\n');
  const result = [];

  let cur     = null;
  let speaker = null;
  let textBuf = [];

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
      html = '<b class="spk-object">' + _esc(_OBJ_PREFIX + objName) + '</b> ' + _esc(block);
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
        cur.buttons.push(btn);
      }
      continue;
    }

    const atmM = line.match(/^\{(.+)\}$/);
    if (atmM) {
      flush();
      speaker = null;
      cur.text += (cur.text ? '<br>' : '') + '✦ ' + _esc(atmM[1].trim());
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

const _NOTIFY_TYPES = { '*': 'info', '!': 'warning', '~': 'danger', '+': 'project', '.': 'done' };

function _parseBtn(line) {
  let rest = line;
  let notify = false;
  let notifyType = '';

  if (rest.length > 2 && _NOTIFY_TYPES[rest[2]]) {
    notify     = true;
    notifyType = _NOTIFY_TYPES[rest[2]];
    rest       = rest.slice(3).trim();
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
  const sepIdx = rest.indexOf(' | ');
  if (notify && sepIdx >= 0) {
    notifyText = rest.slice(sepIdx + 3).trim();
    rest       = rest.slice(0, sepIdx).trim();
  }

  if (!rest) return null;
  return { label: rest, nextNode, notify, notifyType, notifyText, link: '' };
}

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
        .replace(/<b[^>]*class="spk-player"[^>]*>\[\]<\/b>\s*/gi, '[] ')
        .replace(/<b[^>]*class="spk-object"[^>]*>([^<]*)<\/b>\s*/gi, (_, inner) => {
          const raw = inner
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          const name = raw.startsWith(_OBJ_PREFIX) ? raw.slice(1) : raw;
          return '<' + name + '> ';
        })
        .replace(/<b[^>]*class="spk-named"[^>]*>([^<]*)<\/b>\s*/gi, (_, inner) => {
          const name = inner
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          return '[' + name + '] ';
        })
        .replace(/<b>\[\]<\/b>\s*/gi, '[] ')
        .replace(/<b>([^<]*)<\/b>\s*/gi, '[$1] ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g,  '<')
        .replace(/&gt;/g,  '>');
      plain.split('\n').forEach(l => {
        if (!l.trim()) return;
        const t = l.trim();
        if (t.startsWith('✦ ')) {
          lines.push('{' + t.slice(2) + '}');
        } else {
          lines.push(t);
        }
      });
    }

    const _TYPE_CHARS = { info: '*', warning: '!', danger: '~', project: '+', done: '.' };
    (node.buttons || []).forEach(btn => {
      if (!btn.label) return;
      const next = btn.nextNode ? ' =>' + btn.nextNode.replace('node_', '') : '';
      if (btn.notify) {
        const tc  = _TYPE_CHARS[btn.notifyType] || '*';
        const sep = btn.notifyText ? ' | ' + btn.notifyText : '';
        lines.push('->' + tc + ' ' + btn.label + sep + next);
      } else {
        lines.push('-> ' + btn.label + next);
      }
    });

    if (ni < nodes.length - 1) lines.push('');
  });

  return lines.join('\n');
}

window.parseBulkDSL    = parseBulkDSL;
window.unparseDialogue = unparseDialogue;
