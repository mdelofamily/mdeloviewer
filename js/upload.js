// upload.js — media upload modal for text-item illustrations (segments[])
// injected inline by export-html.js assembler, AFTER runtime.js (needs SUPA_URL,
// SUPA_KEY, _MAP_ID, _authHeaders(), window.myDisplayName/_tierAtLeast) and
// BEFORE terminal.js (which calls window.mdMediaOpen()).
//
// Bucket: 'illustrations', path "{nick}/{timestamp}-{filename}".
// ⚠️ UNCONFIRMED (scope open item #4): bucket must exist with an authenticated
// INSERT policy (caretaker+) and a public SELECT/read policy — this is Supabase
// Dashboard config, nothing here can create or verify it. If uploads fail with
// a 400/403 from the /storage/v1/object/ call, check the bucket + its RLS
// policies first, not this file.
//
// window.mdMediaOpen() → Promise<Array<{type,url,name}> | null>
//   resolves with the uploaded file descriptors (type: 'image'|'audio'|'text'|'video'|'epub'|'pdf'),
//   or null if the person cancels / picks nothing. Never rejects — every
//   failure path resolves null after reporting the error in the modal itself,
//   so callers (terminal.js) never need a .catch().

var _MD_BUCKET       = 'illustrations';
var _MD_MAX_BYTES    = 40 * 1024 * 1024; // 40MB/file — matches the bucket's Dashboard file-size limit
var _MD_MAX_PER_MIN  = 5;               // client-side throttle only — NOT a security boundary,
                                         // the real backstop (if any) has to be a Storage/RLS-side limit
var _mdUploadTimes   = []; // in-memory sliding window, per page load

var _MD_TYPES = {
  'image/jpeg': 'image', 'image/jpg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'audio/mpeg': 'audio', 'audio/mp3': 'audio',
  'text/plain': 'text',
  'video/mp4': 'video',
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf'
};
var _MD_ACCEPT = Object.keys(_MD_TYPES).join(',');

function _mdDetectType(file) {
  if (_MD_TYPES[file.type]) return _MD_TYPES[file.type];
  // Some browsers/OSes send an empty/wrong .type (esp. mp3/txt/epub) — fall back to extension.
  var ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp') return 'image';
  if (ext === 'mp3') return 'audio';
  if (ext === 'txt') return 'text';
  if (ext === 'mp4') return 'video';
  if (ext === 'epub') return 'epub';
  if (ext === 'pdf') return 'pdf';
  return null;
}

function _mdValidateFile(file) {
  if (file.size > _MD_MAX_BYTES) return { ok: false, msg: 'ფაილი > 40MB: ' + file.name };
  if (!_mdDetectType(file)) return { ok: false, msg: 'მხარდაუჭერელი ტიპი: ' + file.name + ' (jpg/png/webp/mp3/txt/mp4/epub/pdf)' };
  return { ok: true };
}

function _mdThrottleOk() {
  var cut = Date.now() - 60000;
  _mdUploadTimes = _mdUploadTimes.filter(function (t) { return t > cut; });
  return _mdUploadTimes.length < _MD_MAX_PER_MIN;
}

// Storage keys reject non-ASCII outright (confirmed: a Georgian nick in the
// path 400'd with "InvalidKey") — so unlike a display name, this strips
// EVERYTHING but plain ASCII alnum + a few safe separators. Non-ASCII input
// collapses toward "_" — fine, since this is only ever used for the
// filename part; the folder segment uses a UUID instead, see _mdNick().
function _mdSanitizePathPart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 80) || 'x';
}

// The folder segment of the path. Prefers the real auth UUID (window.myUserId())
// over the caretaker's display name — always ASCII (no key-rejection risk for
// Georgian names) and collision-proof (two caretakers can share a display name).
// Falls back to a sanitized display name only if no session is available yet.
function _mdNick() {
  var uid = (typeof window.myUserId === 'function') ? window.myUserId() : null;
  if (uid) return uid;
  var raw = (typeof window.myDisplayName === 'function') ? window.myDisplayName() : (localStorage.getItem('mdelo_nick') || 'x');
  return _mdSanitizePathPart(raw);
}

// Uploads one already-validated file, returns {type, url, name} or throws.
async function _mdUploadOne(file) {
  var type = _mdDetectType(file);
  var path = _mdNick() + '/' + Date.now() + '-' + _mdSanitizePathPart(file.name);

  var r = await fetch(SUPA_URL + '/storage/v1/object/' + _MD_BUCKET + '/' + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': file.type || 'application/octet-stream' }, _authHeaders()),
    body: file
  });
  if (!r.ok) {
    var errBody = await r.text().catch(function () { return ''; });
    throw new Error('HTTP ' + r.status + ': ' + errBody.slice(0, 150));
  }
  // Assumes the bucket is public — see the ⚠️ note at the top of this file.
  var url = SUPA_URL + '/storage/v1/object/public/' + _MD_BUCKET + '/' + path;
  return { type: type, url: url, name: file.name };
}

// ── modal DOM (built dynamically — index.html is never touched) ──
function _mdBuildModal(resolve) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  var box = document.createElement('div');
  box.style.cssText = 'background:var(--bg, #14181c);border:1px solid var(--border, #333);border-radius:10px;padding:16px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:10px;font-family:inherit;';

  var title = document.createElement('div');
  title.textContent = '📎 მედია ატვირთვა';
  title.style.cssText = 'font-size:14px;font-weight:600;color:var(--text, #eee);';

  var hint = document.createElement('div');
  hint.textContent = 'jpg / png / webp / mp3 / txt / mp4 / epub / pdf — მაქს. 40MB თითო ფაილზე';
  hint.style.cssText = 'font-size:11px;color:var(--muted, #9aa0a6);';

  var fileI = document.createElement('input');
  fileI.type = 'file'; fileI.accept = _MD_ACCEPT; fileI.multiple = true;
  // Visually hidden, not display:none — needs to stay a real, clickable,
  // change-firing input. The native filename text next to a plain file
  // input is OS-rendered chrome that ignores `color` (esp. Android Chrome,
  // black-on-dark) — so it's hidden and a fully custom button + label
  // (below) drive it instead.
  fileI.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;';

  var pickB = document.createElement('button');
  pickB.type = 'button';
  pickB.textContent = '📁 ფაილის არჩევა';
  pickB.style.cssText = 'background:none;border:1px dashed var(--border, #444);color:var(--text, #eee);font-size:12px;padding:10px;border-radius:6px;cursor:pointer;text-align:center;';
  pickB.onclick = function () { fileI.click(); };

  var chosenLabel = document.createElement('div');
  chosenLabel.textContent = 'ფაილი არ არის არჩეული';
  chosenLabel.style.cssText = 'font-size:11px;color:var(--muted, #9aa0a6);';

  var list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:11px;';

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';

  var cancelB = document.createElement('button');
  cancelB.textContent = 'გაუქმება';
  cancelB.style.cssText = 'background:none;border:1px solid var(--border, #444);color:var(--text, #eee);font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;';

  var uploadB = document.createElement('button');
  uploadB.textContent = 'ატვირთვა';
  uploadB.disabled = true;
  uploadB.style.cssText = 'background:var(--accent, #2e9e5b);border:none;color:#fff;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer;opacity:.5;';

  box.appendChild(title); box.appendChild(hint); box.appendChild(pickB); box.appendChild(fileI); box.appendChild(chosenLabel); box.appendChild(list);
  btnRow.appendChild(cancelB); btnRow.appendChild(uploadB);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  var done = false;
  function finish(result) {
    if (done) return; done = true;
    overlay.remove();
    resolve(result);
  }

  overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) finish(null); });
  cancelB.onclick = function () { finish(null); };

  fileI.onchange = function () {
    list.innerHTML = '';
    var files = Array.from(fileI.files || []);
    chosenLabel.textContent = files.length === 0 ? 'ფაილი არ არის არჩეული'
      : files.length === 1 ? files[0].name
      : files.length + ' ფაილი არჩეულია';
    var anyValid = false;
    files.forEach(function (f) {
      var v = _mdValidateFile(f);
      var row = document.createElement('div');
      row.style.cssText = 'color:' + (v.ok ? 'var(--muted, #9aa0a6)' : '#ff8080') + ';';
      row.textContent = (v.ok ? '✓ ' : '✗ ') + (v.ok ? f.name : v.msg);
      list.appendChild(row);
      if (v.ok) anyValid = true;
    });
    uploadB.disabled = !anyValid;
    uploadB.style.opacity = anyValid ? '1' : '.5';
  };

  uploadB.onclick = async function () {
    var files = Array.from(fileI.files || []).filter(function (f) { return _mdValidateFile(f).ok; });
    if (!files.length) return;
    if (!_mdThrottleOk()) {
      list.innerHTML = '';
      var warn = document.createElement('div');
      warn.style.cssText = 'color:#e05555;';
      warn.textContent = 'ძალიან ბევრი ატვირთვა ბოლო წუთში — მოიცადე ცოტა ხანს';
      list.appendChild(warn);
      return;
    }

    uploadB.disabled = true; cancelB.disabled = true;
    uploadB.textContent = 'იტვირთება...';

    var results = [], errors = [];
    for (var i = 0; i < files.length; i++) {
      try {
        _mdUploadTimes.push(Date.now());
        var res = await _mdUploadOne(files[i]);
        results.push(res);
      } catch (e) {
        errors.push(files[i].name + ': ' + e.message);
      }
    }

    if (errors.length) {
      list.innerHTML = '';
      errors.forEach(function (msg) {
        var row = document.createElement('div');
        row.style.cssText = 'color:#e05555;';
        row.textContent = '✗ ' + msg;
        list.appendChild(row);
      });
      uploadB.textContent = 'ხელახლა ცდა';
      uploadB.disabled = false; cancelB.disabled = false;
      if (!results.length) return; // nothing succeeded — let the person retry or cancel
    }

    finish(results.length ? results : null);
  };
}

// Derives the storage path from a public URL this file generated, so callers
// only ever need to hand back URLs (what they already have in segments[]),
// never raw paths.
function _mdPathFromUrl(url) {
  var prefix = SUPA_URL + '/storage/v1/object/public/' + _MD_BUCKET + '/';
  if (typeof url === 'string' && url.indexOf(prefix) === 0) return url.slice(prefix.length);
  return null;
}

// Best-effort orphan cleanup (scope open item #2). Never throws, never blocks
// the caller — a failed delete just leaves a stray file in the bucket, which
// is a storage-cost problem, not a data-integrity one. Silently ignores any
// URL it didn't generate (e.g. already null/foreign), so it's always safe to
// call with a mixed or partially-empty list.
window.mdMediaDelete = async function (urls) {
  var paths = (urls || []).map(_mdPathFromUrl).filter(Boolean);
  if (!paths.length) return true;
  try {
    var r = await fetch(SUPA_URL + '/storage/v1/object/' + _MD_BUCKET, {
      method: 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _authHeaders()),
      body: JSON.stringify({ prefixes: paths })
    });
    return r.ok;
  } catch (e) { return false; }
};

// Lists the most recent files in the bucket, newest first. Storage's list
// API is non-recursive (like `ls` in a single directory) and every file
// lives under a per-user UUID folder (see _mdNick()), so this lists the
// folder level first, then each folder's contents, and merges + sorts the
// result. Fine for a small caretaker team; would need pagination for a
// bucket with many hundreds of uploaders.
async function _mdListOne(prefix) {
  var r = await fetch(SUPA_URL + '/storage/v1/object/list/' + _MD_BUCKET, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, _authHeaders()),
    body: JSON.stringify({ prefix: prefix, limit: 1000, sortBy: { column: 'created_at', order: 'desc' } })
  });
  if (!r.ok) {
    var body = await r.text().catch(function () { return ''; });
    throw new Error('HTTP ' + r.status + ': ' + body.slice(0, 150));
  }
  return await r.json();
}

// Returns {ok, files, error} — never throws — so callers (the /ფაილები
// terminal command) can show the real failure reason instead of a generic
// "nothing found", which was indistinguishable from an actually-empty bucket.
window.mdMediaList = async function (limit) {
  limit = limit || 20;
  try {
    var root = await _mdListOne('');
    var all = [];
    var debug = root.map(function (e) { return e.name + '(meta=' + (e.metadata ? 'yes' : 'no') + ')'; });
    for (var i = 0; i < root.length; i++) {
      var entry = root[i];
      if (entry.metadata) {
        // a file sitting directly at the bucket root (not expected given
        // _mdNick()'s per-user-folder layout, but handle it rather than skip it)
        all.push({
          path: entry.name,
          url: SUPA_URL + '/storage/v1/object/public/' + _MD_BUCKET + '/' + entry.name,
          name: entry.name,
          size: entry.metadata.size,
          created_at: entry.created_at
        });
      } else {
        // no metadata → a folder — recurse one level
        var files = await _mdListOne(entry.name + '/');
        files.forEach(function (file) {
          if (!file.metadata) return; // nested folder — not expected, skip
          var path = entry.name + '/' + file.name;
          all.push({
            path: path,
            url: SUPA_URL + '/storage/v1/object/public/' + _MD_BUCKET + '/' + path,
            name: file.name,
            size: file.metadata.size,
            created_at: file.created_at
          });
        });
      }
    }
    all.sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    return { ok: true, files: all.slice(0, limit), debug: debug };
  } catch (e) {
    return { ok: false, files: [], error: e.message };
  }
};

window.mdMediaOpen = function () {
  // Defensive only — the real gate is the Storage bucket's own INSERT policy.
  // Fails open if the auth engine isn't loaded yet, same philosophy as
  // terminal.js's _tmTierDenied, so this never blocks local dev/testing.
  if (typeof window._tierAtLeast === 'function' && !window._tierAtLeast('caretaker')) {
    return Promise.resolve(null);
  }
  return new Promise(function (resolve) { _mdBuildModal(resolve); });
};
