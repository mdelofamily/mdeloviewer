// runtime.js — viewer zoom, pan, hotspots, popups, menu, dialogue, notifications
// injected inline by export-html.js assembler
// depends on: _CFG, _OBJS, _W, _H, _TS (set in viewer.html data block)

// ── zoom / pan ──
const wrap = document.getElementById('mapWrap'),
      inner = document.getElementById('mapInner'),
      sizer = document.getElementById('sizer');
let scale = 1;

function applyScale(s, ox, oy) {
  const prev = scale;
  const minS = Math.max(wrap.clientWidth / _W, wrap.clientHeight / _H);
  scale = Math.max(minS, Math.min(8, s));
  const ratio = scale / prev;
  wrap.scrollLeft = (wrap.scrollLeft + ox) * ratio - ox;
  wrap.scrollTop  = (wrap.scrollTop  + oy) * ratio - oy;
  inner.style.transform = 'scale(' + scale + ')';
  sizer.style.width  = (_W * scale) + 'px';
  sizer.style.height = (_H * scale) + 'px';
}

wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  applyScale(scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

let p0 = null, pDist = 0, pScale = 1;
wrap.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    wrap.style.touchAction = 'none';
    p0 = e.touches[0];
    const p1 = e.touches[1];
    pDist = Math.hypot(p1.clientX - p0.clientX, p1.clientY - p0.clientY);
    pScale = scale;
    e.preventDefault();
  }
}, { passive: false });
wrap.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const a = e.touches[0], b = e.touches[1];
    const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const r = wrap.getBoundingClientRect();
    applyScale(pScale * (d / pDist), (a.clientX + b.clientX) / 2 - r.left, (a.clientY + b.clientY) / 2 - r.top);
    e.preventDefault();
  }
}, { passive: false });
wrap.addEventListener('touchend', e => {
  if (e.touches.length < 2) wrap.style.touchAction = 'pan-x pan-y';
}, { passive: true });

// ── Supabase credentials ──
const SUPA_URL = 'https://miqenmsgwkkmtxwwbxzo.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pcWVubXNnd2trbXR4d3dieHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDc0NzYsImV4cCI6MjA5NDg4MzQ3Nn0.VfJgVoPC-ZbjlcuwMriYrNXb-3E2OgC92nOR9hOPgKI';
window.SUPABASE_URL = SUPA_URL; window.SUPABASE_ANON_KEY = SUPA_KEY; window.MDELO_ROOM_ID = 'mdelo-chat';

// ══════════════════════════════════════════════════════════════
// ── auth (magic link, PKCE) — raw GoTrue REST, no supabase-js ──
// PKCE (not implicit/hash flow) is deliberate: the redirect lands with
// ?code=... in the query string, never in the URL hash — so it can never
// collide with this app's existing #area=/#spot= hash navigation
// (see applyAreaHash/applySpotHash below).
// All map exports live on one origin (mdeloviewer), so one localStorage
// session is visible from every page/map without any cross-tab relay.
// ══════════════════════════════════════════════════════════════
const AUTH_URL = SUPA_URL + '/auth/v1';
const _AUTH_SESSION_KEY  = 'mdelo_auth_session';   // {access_token, refresh_token, expires_at, user}
const _TIER_RANK = { visitor: 0, caretaker: 1, resident: 2, shadow_admin: 3 };

function _authGetSession() {
  try { return JSON.parse(localStorage.getItem(_AUTH_SESSION_KEY) || 'null'); } catch (e) { return null; }
}
function _authSetSession(sess) {
  try { sess ? localStorage.setItem(_AUTH_SESSION_KEY, JSON.stringify(sess)) : localStorage.removeItem(_AUTH_SESSION_KEY); } catch (e) {}
}
window.isLoggedIn = function () {
  const s = _authGetSession();
  return !!(s && s.access_token && s.expires_at > Date.now());
};

// Headers for Supabase calls — real user JWT when logged in, anon key otherwise.
// `to authenticated` RLS policies reject the anon key outright by design:
// a logged-out visitor simply can't write, which matches the UI-gating model
// (the button/command never appears for them in the first place).
function _authHeaders() {
  const s = _authGetSession();
  const tok = (s && s.access_token) ? s.access_token : SUPA_KEY;
  return { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + tok };
}
window._authHeaders = _authHeaders;

// Sends the magic-link email. redirectTo = current page (origin + path, no
// query/hash) so the person lands back exactly where they clicked from.
// NOTE: the Supabase "Magic Link" email template must be edited (Dashboard →
// Authentication → Email Templates) to point to {{ .RedirectTo }}?token_hash=
// {{ .TokenHash }}&type=email — the *default* template uses Supabase's own
// hosted /verify redirect, which never lands back on our page with a usable
// query param at all, so none of this works until that template is changed.
window.requestMagicLink = async function (email) {
  try {
    const redirectTo = window.location.origin + window.location.pathname;
    const r = await fetch(AUTH_URL + '/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY },
      body: JSON.stringify({
        email: email,
        create_user: true,
        options: { email_redirect_to: redirectTo }
      })
    });
    if (r.ok) return true;
    const body = await r.text().catch(() => '');
    return { ok: false, status: r.status, msg: body.slice(0, 150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// Exchanges the token_hash (from the magic-link redirect, once the email
// template points back here) for a real session — POST /verify returns the
// session directly in the response body, no separate code/verifier step.
async function _authVerifyTokenHash(token_hash, type) {
  try {
    const r = await fetch(AUTH_URL + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY },
      body: JSON.stringify({ type: type || 'email', token_hash: token_hash })
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function _authRefresh(refresh_token) {
  try {
    const r = await fetch(AUTH_URL + '/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY },
      body: JSON.stringify({ refresh_token: refresh_token })
    });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function _authStoreFromTokenResponse(data) {
  if (!data || !data.access_token) return null;
  const sess = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
    user: data.user
  };
  _authSetSession(sess);
  return sess;
}

window.signOut = function () {
  _authSetSession(null);
  window._myTier = null;
  if (typeof toast === 'function') toast('გამოხვედი სისტემიდან');
};

// Small custom modal — email + name together in one form (prompt() only
// supports a single field, so a real DOM popup is needed for both at once).
// Resolves { email, name } on submit, or null if the person cancels/closes.
window.showLoginModal = function (prefillEmail) {
  return new Promise((resolve) => {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#161b22;border:1px solid rgba(88,166,255,0.4);border-radius:12px;padding:20px;width:min(90vw,320px);color:#e6edf3;font-family:inherit;">' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:14px;">შესვლა</div>' +
        '<input id="_loginEmail" type="email" placeholder="ელფოსტა" style="width:100%;box-sizing:border-box;height:36px;margin-bottom:10px;padding:0 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e6edf3;font-size:14px;" />' +
        '<input id="_loginName" type="text" placeholder="სახელი (გამოჩნდება დიალოგებში)" style="width:100%;box-sizing:border-box;height:36px;margin-bottom:14px;padding:0 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e6edf3;font-size:14px;" />' +
        '<div style="display:flex;gap:8px;">' +
          '<button id="_loginCancel" style="flex:1;height:36px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:8px;font-size:13px;cursor:pointer;">გაუქმება</button>' +
          '<button id="_loginSubmit" style="flex:1;height:36px;background:rgba(88,166,255,0.25);border:1px solid rgba(88,166,255,0.6);color:#e6edf3;border-radius:8px;font-size:13px;cursor:pointer;">გაგზავნა</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var emailEl = wrap.querySelector('#_loginEmail');
    var nameEl  = wrap.querySelector('#_loginName');
    if (prefillEmail) { emailEl.value = prefillEmail; nameEl.focus(); } else { emailEl.focus(); }

    function done(result) { wrap.remove(); resolve(result); }
    wrap.querySelector('#_loginCancel').onclick = () => done(null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    function trySubmit() {
      var email = emailEl.value.trim();
      var name = nameEl.value.trim();
      if (!email) { emailEl.focus(); return; }
      done({ email: email, name: name });
    }
    wrap.querySelector('#_loginSubmit').onclick = trySubmit;
    [emailEl, nameEl].forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') trySubmit(); });
    });
  });
};

// Popup form for sending a /შეტყობინება notification or consensus request —
// collects the message text + optional detail from the person. The sender
// name is taken automatically (myDisplayName()) and shown read-only, never
// re-typed by hand. Used by terminal.js's _tmNotify when the command is run
// bare (no text) — e.g. from inside a low-tier-whitelisted macro that bundles
// a "/შეტყობინება^" consensus request without hardcoding its wording.
// Resolves { text, detail } on submit, or null if cancelled.
window.showNotifyFormModal = function (opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
    var name = (typeof window.myDisplayName === 'function') ? window.myDisplayName() : 'მოგზაური';
    var hasTierChoice = opts.tierOptions && opts.tierOptions.length > 1;
    var tierRowHtml = '';
    if (hasTierChoice) {
      tierRowHtml = '<div id="_nfTierRow" style="display:flex;gap:6px;margin-bottom:12px;">' +
        opts.tierOptions.map(function (t, i) {
          return '<button type="button" data-tier="' + t.value + '" style="flex:1;height:34px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid rgba(88,166,255,' + (i === 0 ? '0.7' : '0.25') + ');background:rgba(88,166,255,' + (i === 0 ? '0.22' : '0.05') + ');color:#e6edf3;">' + t.label + '</button>';
        }).join('') +
      '</div>';
    }
    wrap.innerHTML =
      '<div style="background:#161b22;border:1px solid rgba(88,166,255,0.4);border-radius:12px;padding:20px;width:min(92vw,360px);color:#e6edf3;font-family:inherit;">' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">' + (opts.title || 'შეტყობინება') + '</div>' +
        '<div style="font-size:12px;opacity:0.6;margin-bottom:12px;">👤 ' + name + '</div>' +
        tierRowHtml +
        '<textarea id="_nfText" placeholder="რას აცხადებ?" rows="3" style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e6edf3;font-size:14px;font-family:inherit;resize:vertical;"></textarea>' +
        '<textarea id="_nfDetail" placeholder="დეტალი (არასავალდებულო)" rows="2" style="width:100%;box-sizing:border-box;margin-bottom:14px;padding:8px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e6edf3;font-size:14px;font-family:inherit;resize:vertical;"></textarea>' +
        '<div style="display:flex;gap:8px;">' +
          '<button id="_nfCancel" style="flex:1;height:36px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#e6edf3;border-radius:8px;font-size:13px;cursor:pointer;">გაუქმება</button>' +
          '<button id="_nfSubmit" style="flex:1;height:36px;background:rgba(88,166,255,0.25);border:1px solid rgba(88,166,255,0.6);color:#e6edf3;border-radius:8px;font-size:13px;cursor:pointer;">გაგზავნა</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var textEl = wrap.querySelector('#_nfText');
    var detailEl = wrap.querySelector('#_nfDetail');
    var selectedTier = opts.tierOptions && opts.tierOptions[0] ? opts.tierOptions[0].value : null;
    var lastAutoText = null;
    if (typeof opts.textForTier === 'function' && selectedTier && !opts.presetText) {
      lastAutoText = opts.textForTier(selectedTier);
      textEl.value = lastAutoText;
    } else if (opts.presetText) {
      textEl.value = opts.presetText;
    }
    if (opts.presetDetail) detailEl.value = opts.presetDetail;
    if (hasTierChoice) {
      var tierBtns = wrap.querySelectorAll('#_nfTierRow button');
      tierBtns.forEach(function (b) {
        b.onclick = function () {
          selectedTier = b.getAttribute('data-tier');
          tierBtns.forEach(function (o) {
            var active = o === b;
            o.style.border = '1px solid rgba(88,166,255,' + (active ? '0.7' : '0.25') + ')';
            o.style.background = 'rgba(88,166,255,' + (active ? '0.22' : '0.05') + ')';
          });
          // only refresh the template if the person hasn't typed their own text yet
          if (typeof opts.textForTier === 'function' && (textEl.value === lastAutoText || !textEl.value.trim())) {
            lastAutoText = opts.textForTier(selectedTier);
            textEl.value = lastAutoText;
          }
        };
      });
    }
    textEl.focus();
    if (textEl.value) textEl.setSelectionRange(textEl.value.length, textEl.value.length);

    function done(result) { wrap.remove(); resolve(result); }
    wrap.querySelector('#_nfCancel').onclick = () => done(null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    function trySubmit() {
      var text = textEl.value.trim();
      if (!text) { textEl.focus(); return; }
      done({ text: text, detail: detailEl.value.trim(), tier: selectedTier });
    }
    wrap.querySelector('#_nfSubmit').onclick = trySubmit;
    textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) trySubmit(); });
    detailEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) trySubmit(); });
  });
};

// ── tier cache (one row per user in user_tiers) ──
window._myTier = null; // { user_id, tier, view_mode, display_name } once loaded

async function _authLoadTier() {
  const s = _authGetSession();
  if (!s || !s.user) { window._myTier = null; return null; }
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/user_tiers?user_id=eq.' + s.user.id + '&select=*', { headers: _authHeaders() });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      if (typeof toast === 'function') toast('✗ tier GET ჩავარდა (' + r.status + '): ' + errBody.slice(0, 100));
      window._myTier = null;
      return null;
    }
    const rows = await r.json();
    if (rows[0]) { window._myTier = rows[0]; return rows[0]; }
    // first login for this account — create the row; DB default tier='visitor'
    const c = await fetch(SUPA_URL + '/rest/v1/user_tiers', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHeaders()),
      body: JSON.stringify({ user_id: s.user.id })
    });
    if (!c.ok) {
      const errBody = await c.text().catch(() => '');
      if (typeof toast === 'function') toast('✗ tier POST ჩავარდა (' + c.status + '): ' + errBody.slice(0, 100));
      window._myTier = null;
      return null;
    }
    const created = await c.json();
    window._myTier = created[0] || null;
    return window._myTier;
  } catch (e) {
    if (typeof toast === 'function') toast('✗ tier load exception: ' + e.message);
    window._myTier = null;
    return null;
  }
}
window.myRealTier = function () { return window._myTier ? window._myTier.tier : 'visitor'; };
window.myTier = function () {
  const real = window.myRealTier();
  if (real === 'shadow_admin') {
    const dev = localStorage.getItem('mdelo_dev_view_tier');
    if (dev && _TIER_RANK.hasOwnProperty(dev)) return dev;
  }
  return real;
};
window.myUserId = function () { const s = _authGetSession(); return (s && s.user && s.user.id) || null; };
window.myDisplayName = function () {
  return (window._myTier && window._myTier.display_name) || localStorage.getItem('mdelo_nick') || 'მოგზაური';
};
// tier-order check used by dialogue buttons / menu gating — e.g. _tierAtLeast('resident')
window._tierAtLeast = function (min) { return (_TIER_RANK[window.myTier()] || 0) >= (_TIER_RANK[min] || 0); };

// shadow_admin only (checked against the REAL tier, never the overridden
// view — otherwise there'd be no way back). Sets/clears the local
// dev-view-tier override and (re)draws the "test mode" banner.
window.setDevViewTier = function (tier) {
  if (window.myRealTier() !== 'shadow_admin') return { ok: false, reason: 'not_shadow_admin' };
  if (!_TIER_RANK.hasOwnProperty(tier)) return { ok: false, reason: 'unknown_tier' };
  localStorage.setItem('mdelo_dev_view_tier', tier);
  _renderDevViewBanner();
  if (typeof scheduleRender === 'function') scheduleRender();
  return { ok: true };
};
window.clearDevViewTier = function () {
  localStorage.removeItem('mdelo_dev_view_tier');
  _renderDevViewBanner();
  if (typeof scheduleRender === 'function') scheduleRender();
};
function _renderDevViewBanner() {
  var old = document.getElementById('_devViewBanner');
  if (old) old.remove();
  if (window.myRealTier() !== 'shadow_admin') return;
  var dev = localStorage.getItem('mdelo_dev_view_tier');
  if (!dev || !_TIER_RANK.hasOwnProperty(dev)) return;
  var bar = document.createElement('div');
  bar.id = '_devViewBanner';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#a34d00;color:#fff;font-size:12px;padding:6px 10px;display:flex;align-items:center;justify-content:center;gap:10px;font-family:inherit;';
  bar.innerHTML = '🎭 ტესტ რეჟიმი — UI ხედავს როგორც: <b>' + dev + '</b> (რეალურად შენ shadow_admin ხარ) &nbsp; <span id="_devViewOff" style="text-decoration:underline;cursor:pointer;">გამორთვა</span>';
  document.body.prepend(bar);
  document.getElementById('_devViewOff').onclick = function () { window.clearDevViewTier(); };
}

// Sets display_name on first login — replaces /nick for authenticated users.
// (Anonymous /nick in terminal.js is untouched for now; that consolidation
// is a separate, later step.)
window.setDisplayName = async function (name) {
  const s = _authGetSession();
  if (!s || !s.user || !name) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/user_tiers?user_id=eq.' + s.user.id, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHeaders()),
      body: JSON.stringify({ display_name: name })
    });
    if (r.ok && window._myTier) window._myTier.display_name = name;
    return r.ok;
  } catch (e) { return false; }
};

// shadow_admin only — returns [{ user_id, display_name, email, tier }, ...]
// for every account with a user_tiers row. Backed by the `list_users` SQL
// RPC (SECURITY DEFINER, joins auth.users for email — never exposed via
// plain PostgREST) which re-validates the caller is shadow_admin server-side;
// this client-side gate is just fail-fast, same pattern as macro @tier checks.
window.listUsers = async function () {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/list_users', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, _authHeaders()),
      body: '{}'
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return { ok: false, status: r.status, msg: errBody.slice(0, 150) };
    }
    return await r.json();
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// Handles the ?token_hash=...&type=... redirect on load, or silently
// refreshes/restores an existing session. Awaited from
// window.addEventListener('load', ...) below, before anything that might
// want to know the person's tier.
async function _authBoot() {
  const params = new URLSearchParams(window.location.search);
  const tokenHash = params.get('token_hash');
  let data = null;
  if (tokenHash) {
    data = await _authVerifyTokenHash(tokenHash, params.get('type'));
    if (data) _authStoreFromTokenResponse(data);
    params.delete('token_hash');
    params.delete('type');
    const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
    history.replaceState(null, '', clean);
    if (typeof toast === 'function') toast(data ? '✓ ავტორიზებული ხარ' : '✗ login ბმული აღარ არის ვალიდური');
  } else {
    const s = _authGetSession();
    if (s && s.refresh_token && s.expires_at < Date.now() + 60000) {
      const refreshed = await _authRefresh(s.refresh_token);
      if (refreshed) _authStoreFromTokenResponse(refreshed); else _authSetSession(null);
    }
  }
  if (window.isLoggedIn()) {
    await _authLoadTier();
    // fresh login (token_hash just verified) + no name yet → apply the name
    // that was collected up-front at /ლოგინი time; only ask again if it's
    // not there (e.g. the magic link was opened on a different device)
    if (data && window._myTier && !window._myTier.display_name) {
      let name = null;
      try { name = localStorage.getItem('mdelo_pending_name'); } catch (e) {}
      if (!name) name = prompt('პირველად ხარ! რა გქვია? (ეს სახელი გამოჩნდება დიალოგებში)');
      if (name && name.trim()) await window.setDisplayName(name.trim());
      try { localStorage.removeItem('mdelo_pending_name'); } catch (e) {}
    }
  }
}
window._authBoot = _authBoot;

// ── link parser ──
function parseLinks(t) {
  let o = '', i = 0;
  while (i < t.length) {
    const s = t.indexOf('[[', i);
    if (s < 0) { o += t.slice(i); break; }
    o += t.slice(i, s);
    const e = t.indexOf(']]', s + 2);
    if (e < 0) { o += t.slice(s); break; }
    const inner2 = t.slice(s + 2, e);
    const p = inner2.indexOf('|');
    if (p < 0) { o += inner2; }
    else {
      const lbl = inner2.slice(0, p), url = inner2.slice(p + 1).trim();
      if (url.startsWith('menu:')) {
        const slug = url.slice(5).trim();
        o += '<a href="#" class="gm-link" data-menu-slug="' + _escAttr(slug) + '" style="color:#58a6ff;">' + lbl + '</a>';
      } else {
        const safe = (url.startsWith('http') || url.startsWith('//') || url.startsWith('/')) ? url : '#';
        o += '<a href="' + safe + '" target="_blank" style="color:#58a6ff;">' + lbl + '</a>';
      }
    }
    i = e + 2;
  }
  return o.replace(/\n/g, '<br>');
}

function _escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* slug -> {id, nodes, path} resolved from _gmCfg.menu, built lazily and cached.
   nodes/path here mean: the siblings array + breadcrumb path TO the panel containing this node
   (mirrors what _gmShowPanel/_gmOpenOverlay expect). */
var _gmSlugCache = null;
function _gmSlugify(title) {
  return (title || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[|[\]#]/g, '');
}
function _gmBuildSlugIndex() {
  const index = new Map(); // slug -> {node, nodes, path}
  const seen  = new Map(); // base slug -> count
  function walk(nodes, path) {
    nodes.forEach(node => {
      const base  = _gmSlugify(node.title) || node.id;
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      const slug  = count === 1 ? base : base + '-' + count;
      index.set(slug, { node, nodes, path });
      if (node.children && node.children.length) {
        walk(node.children, [...path, {title: node.title, nodes: node.children}]);
      }
    });
  }
  walk((_gmCfg && _gmCfg.menu) || [], []);
  return index;
}
function _gmResolveSlug(slug) {
  if (!_gmCfg) _gmCfg = _CFG;
  if (!_gmSlugCache) _gmSlugCache = _gmBuildSlugIndex();
  return _gmSlugCache.get(slug) || null;
}
/* Navigate to a menu node by slug — opens the burger menu if closed, then drills/overlays to it. */
function _gmGoToSlug(slug) {
  const hit = _gmResolveSlug(slug);
  if (!hit) { toast('⚠️ მენიუს ბმული ვერ მოიძებნა'); return; }
  const gm = document.getElementById('gameMenu');
  if (!gm.classList.contains('open')) {
    gm.classList.add('open');
    wrap.style.overflow = 'hidden';
    if (!window._cfgLoaded) { window._cfgLoaded = true; _gmCfg = _CFG; }
  }
  const hasChildren = hit.node.children && hit.node.children.length > 0;
  if (hasChildren) {
    _gmShowPanel(hit.node.children, [...hit.path, {title: hit.node.title, nodes: hit.node.children}]);
  } else {
    _gmOpenOverlay(hit.node, hit.nodes, hit.path);
  }
}
// global click dispatcher for internal menu links rendered by parseLinks
document.addEventListener('click', e => {
  const a = e.target.closest('.gm-link');
  if (!a) return;
  e.preventDefault();
  _gmGoToSlug(a.getAttribute('data-menu-slug'));
});

// ── hotspot click dispatcher ──
wrap.addEventListener('click', e => {
  if (e.target.closest('#menuBtn') || e.target.closest('#gameMenu')) return;
  const hs = e.target.closest('.hotspot');
  if (hs && !hs.classList.contains('no-interact')) {
    closeHsPopup(); closeAreaPopup();
    if (hs.classList.contains('hs-area')) {
      const t = hs.dataset.title || '', grp = hs.dataset.group || '';
      blinkAreasByGroupOrTitle(grp, t);
      if (t) openAreaPopup(t, hs.dataset.tooltip || '');
    } else {
      const oi = hs.dataset.oi;
      const objData = (oi != null && _OBJS[+oi]) ? _OBJS[+oi] : null;
      const displayTitle = (objData && (objData.title || objData.lb)) || hs.dataset.title || '';
      const _dlgId = hs.dataset.dialogId;
      const _dlgEntry = (_dlgId && window.DIALOGS) ? window.DIALOGS[_dlgId] : null;
      if (_dlgEntry && typeof canTrigger === 'function' && !canTrigger(_dlgEntry)) return;
      _dlgActive = _dlgEntry || null;
      openHsPopup(hs, displayTitle, hs.dataset.tooltip || '', objData);
    }
    return;
  }
  if (!e.target.closest('#hsPopup') && !e.target.closest('#areaPopup')) {
    closeHsPopup(); closeAreaPopup();
  }
});

// ── object marker blink ──
let _objBlinkRaf = null, _objBlinkMarker = null;
function _startObjBlink(el) {
  _stopObjBlink();
  var _mk = el.querySelector('.hs-marker');
  var _dt = el.querySelector('.hs-dot');
  _objBlinkMarker = (_mk && _mk.style.display !== 'none') ? _mk : _dt;
  if (!_objBlinkMarker) return;
  let t = 0;
  function frame() {
    t += 0.06;
    const s = (1.2 + 0.3 * Math.sin(t * 3)).toFixed(2);
    const a = (0.7 + 0.3 * Math.sin(t * 3)).toFixed(2);
    _objBlinkMarker.style.transform = 'translate(-50%,-50%) scale(' + s + ')';
    _objBlinkMarker.style.opacity = a;
    _objBlinkRaf = requestAnimationFrame(frame);
  }
  frame();
}
function _stopObjBlink() {
  if (_objBlinkRaf) { cancelAnimationFrame(_objBlinkRaf); _objBlinkRaf = null; }
  if (_objBlinkMarker) {
    _objBlinkMarker.style.transform = 'translate(-50%,-50%) scale(1)';
    _objBlinkMarker.style.opacity = '1';
    _objBlinkMarker = null;
  }
}

// ── popups ──
function closeHsPopup() {
  const p = document.getElementById('hsPopup');
  p.classList.remove('show'); p.style.display = 'none';
  wrap.style.overflow = 'auto'; _stopObjBlink();
  _dlgNodes = {}; _dlgObj = null;
}
function openAreaPopup(title, tip) {
  closeHsPopup();
  document.getElementById('areaPopupTitle').textContent = title || '';
  const tipEl = document.getElementById('areaPopupTip');
  tipEl.textContent = tip || ''; tipEl.style.display = tip ? '' : 'none';
  const pop = document.getElementById('areaPopup');
  const pw = Math.min(window.innerWidth * 0.88, 320);
  pop.style.cssText = 'left:' + ((window.innerWidth - pw) / 2) + 'px;top:' + Math.max(60, (window.innerHeight - 180) / 2) + 'px;max-width:' + pw + 'px;';
  pop.classList.add('show');
}
function closeAreaPopup() {
  document.getElementById('areaPopup').classList.remove('show');
  if (_areaHlCanvas) { _areaHlCanvas.remove(); _areaHlCanvas = null; }
}

// ── area blink outline ──
var _areaHlCanvas = null;
function _tracePoly(cells, TS) {
  const edgeSet = new Set();
  const norm = (x1,y1,x2,y2) => x1<x2||(x1===x2&&y1<y2)?x1+','+y1+','+x2+','+y2:x2+','+y2+','+x1+','+y1;
  cells.forEach(key => {
    const [r,cc] = key.split(',').map(Number);
    const px=cc*TS, py=r*TS;
    if (!cells.has(r+','+(cc-1))) edgeSet.add(norm(px,py,px,py+TS));
    if (!cells.has(r+','+(cc+1))) edgeSet.add(norm(px+TS,py,px+TS,py+TS));
    if (!cells.has((r-1)+','+cc)) edgeSet.add(norm(px,py,px+TS,py));
    if (!cells.has((r+1)+','+cc)) edgeSet.add(norm(px,py+TS,px+TS,py+TS));
  });
  const edges = [...edgeSet].map(s=>s.split(',').map(Number));
  const adj = new Map();
  edges.forEach(([x1,y1,x2,y2],i) => {
    const k1=x1+','+y1, k2=x2+','+y2;
    if (!adj.has(k1)) adj.set(k1,[]);
    if (!adj.has(k2)) adj.set(k2,[]);
    adj.get(k1).push(i); adj.get(k2).push(i);
  });
  const used = new Set(), polys = [];
  for (let si=0; si<edges.length; si++) {
    if (used.has(si)) continue;
    const [sx,sy] = [edges[si][0],edges[si][1]];
    let cx=sx, cy=sy, ci=si;
    const poly = [];
    do {
      used.add(ci);
      const [x1,y1,x2,y2]=edges[ci];
      poly.push([cx,cy]);
      [cx,cy] = (x1===cx&&y1===cy)?[x2,y2]:[x1,y1];
      const nb=(adj.get(cx+','+cy)||[]).find(i=>!used.has(i));
      if (nb===undefined) break;
      ci=nb;
    } while (cx!==sx||cy!==sy);
    if (poly.length>=3) polys.push(poly);
  }
  return polys;
}
function _drawRounded(ctx, poly, R) {
  ctx.beginPath();
  const n=poly.length;
  for (let i=0; i<n; i++) {
    const prev=poly[(i-1+n)%n], curr=poly[i], next=poly[(i+1)%n];
    const dx1=curr[0]-prev[0], dy1=curr[1]-prev[1];
    const dx2=next[0]-curr[0], dy2=next[1]-curr[1];
    const l1=Math.sqrt(dx1*dx1+dy1*dy1)||1, l2=Math.sqrt(dx2*dx2+dy2*dy2)||1;
    const r=Math.min(R,l1/2,l2/2);
    const p1x=curr[0]-r*dx1/l1, p1y=curr[1]-r*dy1/l1;
    if (i===0) ctx.moveTo(p1x,p1y); else ctx.lineTo(p1x,p1y);
    ctx.arcTo(curr[0],curr[1],curr[0]+r*dx2/l2,curr[1]+r*dy2/l2,r);
  }
  ctx.closePath(); ctx.stroke();
}
function _doBlink(els) {
  if (!els.length) return;
  const TS=_TS;
  const cells=new Set();
  els.forEach(el => {
    const ox=+el.dataset.ox,oy=+el.dataset.oy,ow=+el.dataset.ow,oh=+el.dataset.oh;
    for (let r=0;r<Math.round(oh/TS);r++)
      for (let cc=0;cc<Math.round(ow/TS);cc++)
        cells.add((Math.round(oy/TS)+r)+','+(Math.round(ox/TS)+cc));
  });
  const polys=_tracePoly(cells,TS);
  if (!polys.length) return;
  if (_areaHlCanvas) { _areaHlCanvas.remove(); _areaHlCanvas=null; }
  const ov=document.createElement('canvas');
  ov.width=_W; ov.height=_H;
  ov.style.cssText='position:absolute;top:0;left:0;pointer-events:none;z-index:15;';
  inner.appendChild(ov);
  const ctx=ov.getContext('2d');
  const R=Math.max(4,TS*0.25);
  ctx.lineWidth=2.5; ctx.lineCap='round'; ctx.lineJoin='round';
  function draw(alpha) {
    ctx.clearRect(0,0,ov.width,ov.height);
    if (alpha<=0) return;
    ctx.strokeStyle='rgba(255,220,80,'+alpha.toFixed(2)+')';
    polys.forEach(p=>_drawRounded(ctx,p,R));
  }
  const PULSE=550; let start=null, phase=0;
  function frame(ts) {
    if (!start) start=ts;
    const t=Math.min((ts-start)/PULSE,1);
    draw(phase%2===0?t:1-t);
    if (t<1) { requestAnimationFrame(frame); return; }
    phase++;
    if (phase<6) { start=null; requestAnimationFrame(frame); return; }
    // blink done — keep persistent at low alpha
    draw(0.45);
    _areaHlCanvas=ov;
  }
  requestAnimationFrame(frame);
}
function blinkAreasByGroupOrTitle(grp, title) {
  let els = grp ? [...document.querySelectorAll('.hs-area[data-group="' + grp + '"]')] : [];
  if (!els.length && title) els = [...document.querySelectorAll('.hs-area[data-title="' + title + '"]')];
  _doBlink(els);
}
// Navigate to a named area or hotspot — shared by btn.area and goToArea
function _gotoNamedLocation(title) {
  var aEls = document.querySelectorAll('.hs-area[data-title="' + title + '"]');
  if (aEls.length) { fitAreas(title); blinkAreasByGroupOrTitle('', title); return; }

  // try exact data-title match — prefer instance with dialogue
  var _cands = document.querySelectorAll('.hotspot[data-title="' + title + '"]');
  var hs = null;
  for (var _j = 0; _j < _cands.length; _j++) {
    var _cOi = +(_cands[_j].dataset.oi);
    if (typeof _OBJS !== 'undefined' && _OBJS[_cOi] && _OBJS[_cOi].dialogue && _OBJS[_cOi].dialogue.length) {
      hs = _cands[_j]; break;
    }
  }
  if (!hs && _cands.length) hs = _cands[0];

  // fallback: search by obj.lb or obj.title (renamed objects)
  if (!hs && typeof _OBJS !== 'undefined') {
    for (var _i = 0; _i < _OBJS.length; _i++) {
      if (_OBJS[_i] && (_OBJS[_i].lb === title || _OBJS[_i].title === title)) {
        hs = document.querySelector('.hotspot[data-oi="' + _i + '"]');
        if (hs) break;
      }
    }
  }

  if (hs) {
    var ox = +(hs.dataset.ox || 0), oy = +(hs.dataset.oy || 0);
    var ow = +(hs.dataset.ow || 64),  oh = +(hs.dataset.oh || 64);
    wrap.scrollLeft = (ox + ow / 2) * scale - wrap.clientWidth  / 2;
    wrap.scrollTop  = (oy + oh / 2) * scale - wrap.clientHeight / 2;
  }
}

function fitAreas(title) {
  const els = [...document.querySelectorAll('.hs-area[data-title="' + title + '"]')];
  if (!els.length) return;
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  els.forEach(el => {
    const ox = +el.dataset.ox, oy = +el.dataset.oy, ow = +el.dataset.ow, oh = +el.dataset.oh;
    minX = Math.min(minX, ox); minY = Math.min(minY, oy);
    maxX = Math.max(maxX, ox + ow); maxY = Math.max(maxY, oy + oh);
  });
  const PAD = 80, sw = wrap.clientWidth - PAD * 2, sh = wrap.clientHeight - PAD * 2;
  const z = Math.min(sw / (maxX - minX || 1), sh / (maxY - minY || 1), 4);
  applyScale(Math.max(0.2, z), wrap.clientWidth / 2, wrap.clientHeight / 2);
  const cx = (minX + (maxX - minX) / 2) * scale, cy = (minY + (maxY - minY) / 2) * scale;
  let n = 0;
  (function go() { wrap.scrollLeft = cx - wrap.clientWidth / 2; wrap.scrollTop = cy - wrap.clientHeight / 2; if (++n < 6) setTimeout(go, 120); })();
}

// ── game menu (drill-down) ──
var _gmCfg = null;

function toggleMenu() {
  const gm = document.getElementById('gameMenu');
  const open = gm.classList.toggle('open');
  wrap.style.overflow = open ? 'hidden' : 'auto';
  if (!open) {
    gm.classList.remove('ov-open');
    document.getElementById('gmOverlay').classList.remove('open');
  }
  if (open && !window._cfgLoaded) {
    window._cfgLoaded = true;
    _gmCfg = _CFG;
    _gmShowPanel((_CFG.menu || []), []);
  }
}

/* path = [{title, nodes}] — each entry is a node already entered; `nodes` = its children array (siblings shown at that level).
   Root level is path = []. */
function _gmShowPanel(nodes, path) {
  const panel = document.getElementById('gmPanel');
  panel.innerHTML = '';
  const bc = document.getElementById('gmBreadcrumb');
  if (path.length === 0) {
    bc.innerHTML = '';
    bc.classList.remove('visible');
  } else {
    bc.classList.add('visible');
    bc.innerHTML = '';
    const root = document.createElement('span');
    root.className = 'gm-bc-part';
    root.textContent = (_gmCfg && _gmCfg.title) || '☰';
    root.onclick = () => _gmShowPanel((_gmCfg.menu || []), []);
    bc.appendChild(root);
    path.forEach((p, i) => {
      const sep = document.createElement('span'); sep.className = 'gm-bc-sep'; sep.textContent = '/'; bc.appendChild(sep);
      const part = document.createElement('span');
      const isLast = (i === path.length - 1);
      part.className = 'gm-bc-part' + (isLast ? ' current' : '');
      part.textContent = p.title;
      if (!isLast) part.onclick = () => _gmShowPanel(p.nodes, path.slice(0, i + 1));
      bc.appendChild(part);
    });
    requestAnimationFrame(() => { bc.scrollLeft = bc.scrollWidth; });
  }
  nodes.forEach(node => {
    const hasChildren = node.children && node.children.length > 0;
    const hasItems    = node.items && node.items.length > 0;
    const el = document.createElement('div');
    el.className = 'gm-panel-item' + (hasItems && !hasChildren ? ' has-items' : '');
    const icon  = document.createElement('span'); icon.className = 'gm-pi-icon'; icon.textContent = node.icon || '📁';
    const title = document.createElement('span'); title.className = 'gm-pi-title'; title.textContent = node.title || '';
    el.appendChild(icon); el.appendChild(title);
    if (hasChildren && hasItems) {
      const txtBtn = document.createElement('span'); txtBtn.className = 'gm-pi-textbtn'; txtBtn.textContent = '📄';
      txtBtn.onclick = (e) => { e.stopPropagation(); _gmOpenOverlay(node, nodes, path); };
      el.appendChild(txtBtn);
      const arr = document.createElement('span'); arr.className = 'gm-pi-arrow'; arr.textContent = '›';
      el.appendChild(arr);
      el.onclick = () => _gmShowPanel(node.children, [...path, {title: node.title, nodes: node.children}]);
    } else if (hasChildren) {
      const arr = document.createElement('span'); arr.className = 'gm-pi-arrow'; arr.textContent = '›';
      el.appendChild(arr);
      el.onclick = () => _gmShowPanel(node.children, [...path, {title: node.title, nodes: node.children}]);
    } else if (hasItems) {
      const arr = document.createElement('span'); arr.className = 'gm-pi-arrow'; arr.textContent = '↗';
      el.appendChild(arr);
      el.onclick = () => _gmOpenOverlay(node, nodes, path);
    } else {
      el.style.opacity = '0.5';
      el.style.cursor = 'default';
    }
    panel.appendChild(el);
  });
}

/* Open full-screen overlay for a leaf node's items.
   parentNodes = the siblings array the leaf lives in (so "back" can return to the exact same panel).
   parentPath  = breadcrumb path TO that panel (not including the leaf itself).
   standalone  = true when this overlay was opened directly (e.g. a console
                 /მენიუ/.../N deep-link) without the person ever browsing the
                 menu themselves — closing it should return straight to the
                 map instead of revealing a menu panel they never opened. */
function _gmOpenOverlay(node, parentNodes, parentPath, standalone) {
  const ov   = document.getElementById('gmOverlay');
  const body = document.getElementById('gmOverlayBody');
  const titleEl = document.getElementById('gmOverlayTitle');
  titleEl.textContent = (node.icon ? node.icon + ' ' : '') + (node.title || '');
  body.innerHTML = '';
  (node.items || []).forEach(item => {
    const itObj = typeof item === 'string' ? { type: 'text', emoji: '•', label: item } : item;
    if (itObj.type === 'progress') {
      const v = Math.max(0, Math.min(100, itObj.value || 0));
      const color = v > 60 ? '#4ade80' : v > 30 ? '#facc15' : '#f87171';
      const row = document.createElement('div'); row.className = 'gm-progress-row';
      const pfx = itObj.emoji ? itObj.emoji + ' ' : '';
      row.innerHTML = '<span class="gm-progress-label">' + pfx + itObj.label + '</span><div class="gm-bar"><div class="gm-bar-fill" style="width:' + v + '%;background:' + color + ';"></div></div><span class="gm-bar-pct">' + v + '%</span>';
      body.appendChild(row);
    } else if (itObj.type === 'todo') {
      const checked = _gmTodoState.has(itObj.id) ? _gmTodoState.get(itObj.id) : !!itObj.checked;
      const row = document.createElement('div'); row.className = 'gm-todo-row' + (checked ? ' checked' : '');
      const box = document.createElement('span'); box.className = 'gm-todo-box'; box.textContent = checked ? '✅' : '⬜';
      const lbl = document.createElement('span'); lbl.className = 'gm-todo-label';
      lbl.innerHTML = parseLinks(itObj.label || '');
      row.appendChild(box); row.appendChild(lbl);
      row.onclick = (e) => {
        if (e.target.closest('a')) return;
        const next = !(_gmTodoState.has(itObj.id) ? _gmTodoState.get(itObj.id) : !!itObj.checked);
        _gmTodoState.set(itObj.id, next);
        row.classList.toggle('checked', next);
        box.textContent = next ? '✅' : '⬜';
        _gmSaveTodoState(itObj.id, next);
      };
      body.appendChild(row);
    } else {
      const d = document.createElement('div'); d.className = 'gm-item';
      d.innerHTML = (itObj.emoji || '•') + ' ' + parseLinks(itObj.label || '');
      body.appendChild(d);
    }
  });
  ov.classList.add('open');
  document.getElementById('gameMenu').classList.add('ov-open');
  document.getElementById('gmOverlayClose').onclick = () => {
    ov.classList.remove('open');
    document.getElementById('gameMenu').classList.remove('ov-open');
    if (standalone) { toggleMenu(); } else { _gmShowPanel(parentNodes, parentPath); }
  };
}

/* Legacy stubs */
function toggleSection(el) {}
function buildItems(parent, items) {}
function buildSubs(parent, children, depth) {}
function buildMenu(cfg) { _gmCfg = cfg; _gmShowPanel((cfg.menu || []), []); }

// ── dialogue engine ──
let _dlgNodes = {}, _dlgObj = null, _dlgActive = null;

function _parseNodes(dialogue) {
  const nodes = {};
  (dialogue || []).forEach(n => { nodes[n.id] = n; });
  const first = dialogue && dialogue.length ? dialogue[0].id : null;
  return { nodes, first };
}
function _dlgShowNode(nodeId, selectedLabel) {
  const node = _dlgNodes[nodeId]; if (!node) return;
  // #if flag =>N — redirect if flag is set
  if (node.condition && typeof flagHas === 'function' && flagHas(node.condition.flag)) {
    _dlgShowNode(node.condition.target, selectedLabel); return;
  }
  const body = document.getElementById('hsPopupBody');
  const btnWrap = document.getElementById('hsPopupBtns');
  if (btnWrap) { btnWrap.innerHTML = ''; btnWrap.classList.remove('visible'); }

  // append selected answer to history (no typewriter, italic)
  if (selectedLabel) {
    const nick = window.myDisplayName ? window.myDisplayName() : (localStorage.getItem('mdelo_nick') || 'მოგზაური');
    const ans = document.createElement('div');
    ans.style.cssText = 'font-style:italic;opacity:0.55;font-size:12px;margin:6px 0 2px; display:flex; justify-content:flex-end; text-align:right;';
    ans.textContent = nick + ': ' + selectedLabel;
    body.appendChild(ans);
  }

  const objTitle = (_dlgObj && (_dlgObj.title || _dlgObj.lb)) || '';
  const _he = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const txt = (node.text || '')
    .replace(/\[\]/g, (window.myDisplayName ? window.myDisplayName() : (localStorage.getItem('mdelo_nick') || 'მოგზაური')) + ':')
    .replace(/__OBJ__([^<"]*)/g, (_, name) => (name.trim() || _he(objTitle)) + ':')
    .replace(/&lt;([^&<\n]*)&gt;/g, (_, name) => '<b>' + (name.trim() || _he(objTitle)) + ':</b>');

  // new node appended into fresh div — history above stays intact
  const nodeEl = document.createElement('div');
  body.appendChild(nodeEl);

  _typewriterHTML(nodeEl, parseLinks(txt), 35, () => {
    if (!btnWrap) return;
    (node.buttons || []).forEach(btn => {
      if (!btn.label) return;
      // tier-gated visibility: a button past the person's authorization
      // simply never renders — no disabled/greyed state, per the UI-gating model
      if (btn.minTier && !window._tierAtLeast(btn.minTier)) return;
      const b = document.createElement('button');
      b.textContent = btn.label;
      b.style.cssText = 'width:100%;height:32px;background:rgba(22,27,34,0.2);border:1px solid rgba(88,166,255,0.4);color:#e6edf3;font-size:13px;border-radius:8px;cursor:pointer;text-align:center;';
      b.onclick = () => {
        if (btn.applyTier) {
          const targetTier = btn.applyTier;
          if (!window.isLoggedIn || !window.isLoggedIn()) {
            if (typeof toast === 'function') toast('⚠️ განაცხადისთვის საჭიროა შესვლა — სცადე /ლოგინი');
          } else {
            window.requestTierUp(targetTier).then(res => {
              if (res.ok) { if (typeof toast === 'function') toast('✓ განაცხადი გაგზავნილია — ხმის მიცემა იწყება'); }
              else if (res.reason === 'already_pending') { if (typeof toast === 'function') toast('⚠️ უკვე გაქვს გახსნილი განაცხადი — დაელოდე შედეგს'); }
              else { if (typeof toast === 'function') toast('✗ განაცხადი ვერ გაიგზავნა'); if (res.status) console.error('requestTierUp failed:', res.status, res.msg); }
            });
          }
        }
        if (btn.notify) {
          const sender = window.myDisplayName ? window.myDisplayName() : (localStorage.getItem('mdelo_sender') || 'ანონიმი');
          const notifyTxt = btn.notifyText || (sender + ' — ' + btn.label);
          const nType = btn.notifyType || 'info';
          const nSymbol = { info: '💬', warning: '⚠️', danger: '🔴', project: '🚀', done: '✅' }[nType] || '💬';
          fetch(SUPA_URL + '/rest/v1/notifications', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHeaders()),
            body: JSON.stringify({ type: nType, symbol: nSymbol, text: notifyTxt, sender: sender, linked_area: btn.area || '' })
          }).catch(() => {});
          // push-fetch (Scope C) — non-blocking, independent of the notifications insert above
          // NOTE: send-push checks the NEW publishable key format (sb_publishable_...),
          // not the legacy anon JWT (SUPA_KEY) used for REST calls above.
          fetch(SUPA_URL + '/functions/v1/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': 'sb_publishable_soE_2V-VW_fIu0DyM6QdzQ_TOvYNxF2' },
            body: JSON.stringify({ map_id: _MAP_ID, title: 'მდელო', body: notifyTxt, url: btn.area ? ('#area=' + encodeURIComponent(btn.area)) : '/' })
          }).catch(() => {});
        }
        if (btn.link) {
          if (btn.link.startsWith('menu:')) { _gmGoToSlug(btn.link.slice(5).trim()); }
          else { window.open(btn.link, '_blank'); }
        }
        if (btn.area) { closeHsPopup(); _gotoNamedLocation(btn.area); return; }
        // [^Xსახელი] marker effects
        if (btn.markers && btn.markers.length) {
          btn.markers.forEach(function(m) {
            var el = document.querySelector('.hotspot[data-title="' + m.title + '"]:not(.hs-area)');
            if (!el) return;
            _applyMarkerDom(el, m.mk);
            var _oi = el.dataset.oi;
            if (_oi != null && _OBJS && _OBJS[+_oi]) _OBJS[+_oi].marker = m.mk === '~' ? '...' : m.mk;
          });
        }
        // [+flag_name] button-level flag set
        if (btn.flags && btn.flags.length) {
          btn.flags.forEach(function(f) { if (typeof flagSet === 'function') flagSet(f); });
        }
        // [$macro_name] — run a saved console macro; a leading '/' instead
        // runs the raw command directly via window.tmRun (no wrapper macro
        // needed for commands that already have no tier restriction).
        if (btn.cmds && btn.cmds.length) {
          btn.cmds.forEach(function(c) {
            if (c.charAt(0) === '/') { if (typeof window.tmRun === 'function') window.tmRun(c); }
            else if (typeof window.runMacro === 'function') window.runMacro(c);
          });
        }
        if (btn.nextNode && _dlgNodes[btn.nextNode]) { _dlgShowNode(btn.nextNode, btn.label); }
        else {
          if (_dlgActive && typeof completeDialog === 'function') completeDialog(_dlgActive);
          _dlgActive = null;
          closeHsPopup();
        }
      };
      btnWrap.appendChild(b);
    });
    setTimeout(() => { btnWrap.classList.add('visible'); }, 50);
  }, () => {
    const scroll = document.getElementById('hsPopupScroll');
    if (scroll) {
      const target = scroll.scrollHeight - scroll.clientHeight;
      const start = scroll.scrollTop, diff = target - start;
      if (diff <= 0) return;
      let t = 0; const dur = 150;
      const step = () => { t += 16; const p = Math.min(t / dur, 1); scroll.scrollTop = start + diff * (p < 0.5 ? 2 * p * p : (1 - (2 - 2 * p) * (2 - 2 * p) / 2)); if (t < dur) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
  });
}
function openHsPopup(el, title, raw, obj) {
  _dlgObj = obj || null;
  const popup = document.getElementById('hsPopup');
  document.getElementById('hsPopupTitle').textContent = title || '';
  document.getElementById('hsPopupBody').innerHTML = '';
  const bw = document.getElementById('hsPopupBtns');
  if (bw) bw.innerHTML = '';
  const pw = Math.min(window.innerWidth * 0.95), left = (window.innerWidth - pw) / 2, top = Math.max(60, (window.innerHeight - 200) / 2);
  popup.style.cssText = 'display:block;left:' + left + 'px;top:' + top + 'px;max-width:' + pw + 'px;';
  popup.classList.add('show');
  wrap.style.overflow = 'hidden';
  if (el) _startObjBlink(el);
  if (obj && obj.dialogue && obj.dialogue.length > 0) {
    const parsed = _parseNodes(obj.dialogue);
    _dlgNodes = parsed.nodes;
    if (parsed.first) _dlgShowNode(parsed.first);
  } else {
    _typewriterHTML(document.getElementById('hsPopupBody'), parseLinks(raw || ''), 35);
  }
}

// ── typewriter ──
let _twTimer = null;
function _typewriter(el, text, speed, onDone) {
  if (_twTimer) { clearInterval(_twTimer); _twTimer = null; }
  el.textContent = '';
  if (!text) { if (onDone) onDone(); return; }
  let i = 0;
  _twTimer = setInterval(() => { el.textContent += text[i++]; if (i >= text.length) { clearInterval(_twTimer); _twTimer = null; if (onDone) onDone(); } }, speed);
}
function _twSpeed(type) {
  if (type === 'emergency' || type === 'danger') return 25;
  if (type === 'warning') return 45;
  return 35;
}
function _typewriterHTML(el, html, speed, onDone, onTick) {
  if (_twTimer) { clearInterval(_twTimer); _twTimer = null; }
  el.innerHTML = '';
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  const nodes = Array.from(tmp.childNodes);
  let ni = 0, ci = 0, cur = null, _done = false;
  function next() {
    if (ni >= nodes.length) { if (!_done) { _done = true; if (onDone) onDone(); } return; }
    const node = nodes[ni];
    if (node.nodeType === 3) {
      if (!cur) { cur = document.createTextNode(''); el.appendChild(cur); }
      const full = node.textContent;
      if (ci < full.length) { cur.textContent += full[ci++]; if (onTick) onTick(); }
      else { ni++; ci = 0; cur = null; }
    } else { el.appendChild(node.cloneNode(true)); ni++; ci = 0; cur = null; if (onTick) onTick(); }
  }
  _twTimer = setInterval(() => { next(); if (ni >= nodes.length && !_done) { clearInterval(_twTimer); _twTimer = null; _done = true; if (onDone) onDone(); } }, speed);
}

// ── quest/legend ──
function toggleQuest() {
  const p = document.getElementById('questPopup'); if (!p) return;
  if (p.style.display === 'block') { p.style.display = 'none'; }
  else { p.style.display = 'block'; const full = p.dataset.full || (p.dataset.full = p.textContent); p.textContent = ''; _typewriter(p, full, 60); }
}

// ── spot link popup ──
let _slCell = { col: 0, row: 0 }, _slZoom = 1;
function openSlPopup(col, row, cx, cy) {
  _slCell = { col, row }; _slZoom = _snapZoom(scale);
  document.getElementById('slCoords').textContent = 'Col: ' + col + '   Row: ' + row;
  document.querySelectorAll('.slzBtn').forEach(b => b.classList.toggle('on', +b.dataset.z === _slZoom));
  const p = document.getElementById('spotLinkPopup');
  const pw = 200, ph = 130;
  let left = cx + 12, top = cy - ph / 2;
  left = Math.min(window.innerWidth - pw - 8, Math.max(8, left));
  top  = Math.max(8, Math.min(window.innerHeight - ph - 8, top));
  p.style.left = left + 'px'; p.style.top = top + 'px'; p.classList.add('show');
}
function closeSlPopup() { const p = document.getElementById('spotLinkPopup'); p.classList.remove('show'); p.style.display = ''; }
function setSlZoom(btn) { _slZoom = +btn.dataset.z; document.querySelectorAll('.slzBtn').forEach(b => b.classList.toggle('on', b === btn)); }
function _snapZoom(z) { const snaps = [0.5, 1, 2, 3]; return snaps.reduce((a, b) => Math.abs(b - z) < Math.abs(a - z) ? b : a); }
function copySlLink() {
  const base = window.location.href.split('#')[0];
  const link = base + '#spot=' + _slCell.col + ',' + _slCell.row + ',' + _slZoom;
  const done = () => {
    const p = document.getElementById('spotLinkPopup'), btn = p.querySelector('.slCopy'), orig = btn.textContent;
    btn.textContent = '✓ დაკოპირდა!'; setTimeout(() => { btn.textContent = orig; closeSlPopup(); }, 900);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(link).then(done).catch(() => { _slFb(link); done(); }); }
  else { _slFb(link); done(); }
}
function _slFb(text) { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;'; document.body.appendChild(ta); ta.focus(); ta.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); }

// ── long-press for spot link ──
(function () {
  const TS2 = _TS;
  let _ltTimer = null, _ltSuppress = false;
  wrap.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0], sx = t.clientX, sy = t.clientY;
    _ltTimer = setTimeout(() => {
      _ltTimer = null; _ltSuppress = true;
      const rect = wrap.getBoundingClientRect();
      const mx = sx - rect.left + wrap.scrollLeft, my = sy - rect.top + wrap.scrollTop;
      openSlPopup(Math.max(0, Math.floor(mx / (TS2 * scale))), Math.max(0, Math.floor(my / (TS2 * scale))), sx, sy);
    }, 600);
  }, { passive: true });
  wrap.addEventListener('touchmove', e => { if (_ltTimer) { clearTimeout(_ltTimer); _ltTimer = null; } }, { passive: true });
  wrap.addEventListener('touchend', e => {
    if (_ltTimer) { clearTimeout(_ltTimer); _ltTimer = null; }
    if (_ltSuppress) { _ltSuppress = false; e.preventDefault && e.preventDefault(); }
  }, { passive: false });
  wrap.addEventListener('click', e => { if (document.getElementById('spotLinkPopup').classList.contains('show')) { if (!e.target.closest('#spotLinkPopup')) closeSlPopup(); } });
})();

// ── hash navigation ──
function applySpotHash() {
  const h = window.location.hash;
  if (!h.startsWith('#spot=')) return;
  const parts = h.slice(6).split(',');
  if (parts.length < 2) return;
  const col = parseInt(parts[0]), row = parseInt(parts[1]), z = parts.length >= 3 ? parseFloat(parts[2]) : 1;
  if (isNaN(col) || isNaN(row) || isNaN(z)) return;
  scale = Math.max(0.2, Math.min(8, z));
  inner.style.transform = 'scale(' + scale + ')';
  sizer.style.width  = (_W * scale) + 'px';
  sizer.style.height = (_H * scale) + 'px';
  const sx = Math.max(0, col * _TS * scale - wrap.clientWidth  / 2);
  const sy = Math.max(0, row * _TS * scale - wrap.clientHeight / 2);
  let n = 0;
  (function go() { wrap.scrollLeft = sx; wrap.scrollTop = sy; if (++n < 8) setTimeout(go, 150); })();
}
function applyAreaHash() {
  const h = window.location.hash;
  if (!h.startsWith('#area=')) return;
  const title = decodeURIComponent(h.slice(6).replace(/\+/g, ' '));
  if (!title) return;
  function tryFit(n) {
    const els = document.querySelectorAll('.hs-area[data-title="' + title + '"]');
    if (els.length) { fitAreas(title); return; }
    if (n > 0) setTimeout(() => tryFit(n - 1), 300);
  }
  setTimeout(() => tryFit(10), 200);
}

// ── notifications ──
const TYPE_LABELS = { info: 'ინფო', warning: 'გაფრთხილება', danger: 'საფრთხე', emergency: 'განგაში', done: 'მზადაა', project: 'პროექტი', consensus: 'კონსენსუსი' };
let _notifs = [], _curNotif = null;

async function loadNotifs() {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/notifications?order=created_at.desc&limit=20', { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } });
    if (!r.ok) return;
    _notifs = await r.json(); renderNotifBar();
    if (navigator.setAppBadge && _notifs.length) { navigator.setAppBadge(_notifs.length); }
    else if (navigator.clearAppBadge) { navigator.clearAppBadge(); }
  } catch (e) {}
}
function renderNotifBar() {
  const bar = document.getElementById('notifBar'); if (!bar) return;
  bar.innerHTML = ''; if (!_notifs.length) return;
  const MAX = 4;
  _notifs.slice(0, MAX).forEach(n => {
    const c = document.createElement('div');
    c.className = 'ncard' + (n.type === 'emergency' ? ' pulse' : '');
    c.dataset.type = n.type || 'info'; c.title = n.text || ''; c.textContent = n.symbol || '💬';
    c.onclick = () => { if (['consensus','project','done'].includes(n.type) && n.quorum_count) openConsensusPopup(n); else openNotifPopup(n); };
    let _lt = null;
    c.addEventListener('touchstart', e => {
      _lt = setTimeout(() => {
        _lt = null;
        if (navigator.vibrate) navigator.vibrate(40);
        _ncardDeleteConfirm(c, n);
      }, 600);
    }, { passive: true });
    c.addEventListener('touchmove',  () => { if (_lt) { clearTimeout(_lt); _lt = null; } }, { passive: true });
    c.addEventListener('touchend',   () => { if (_lt) { clearTimeout(_lt); _lt = null; } }, { passive: true });
    bar.appendChild(c);
  });
  if (_notifs.length > MAX) {
    const more = document.createElement('div');
    more.style.cssText = 'width:44px;height:44px;border-radius:10px;background:rgba(13,17,23,0.65);backdrop-filter:blur(8px);border:1px solid #30363d;color:#8b949e;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.82;';
    more.textContent = '+' + (_notifs.length - MAX); more.onclick = () => openNotifList(); bar.appendChild(more);
  }
}

async function _ncardDeleteConfirm(card, n) {
  if (n.type === 'consensus' && n.quorum_count) {
    const total = await _consensusVoteCount(n.id);
    if (total < n.quorum_count) {
      const ov = _ncardOverlay(card, '🔒', '#8b949e');
      ov.style.flexDirection = 'column'; ov.style.gap = '2px'; ov.innerHTML = '';
      const lockIcon = document.createElement('div'); lockIcon.textContent = '🔒'; lockIcon.style.fontSize = '16px';
      const lockMsg = document.createElement('div');
      lockMsg.style.cssText = 'font-size:9px;color:#fff;text-align:center;padding:0 4px;';
      lockMsg.textContent = 'ხმის მიცემა არ დასრულებულა (' + total + '/' + n.quorum_count + ')';
      ov.appendChild(lockIcon); ov.appendChild(lockMsg);
      setTimeout(() => ov.remove(), 1600);
      return;
    }
  }
  const type = n.type || 'info';
  if (type === 'emergency') {
    const ov = _ncardOverlay(card, '🔒', '#8b949e');
    setTimeout(() => ov.remove(), 1200);
    return;
  }
  if (type === 'danger' || type === 'warning') {
    const color = { danger: '#fb8f44', warning: '#f0a500' }[type];
    // dialog floats above the notif bar, not crammed inside the 44px card
    const dlg = document.createElement('div');
    dlg.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:70px',
      'transform:translateX(-50%)',
      'z-index:200',
      'background:#1c2128',
      'border:1px solid ' + color,
      'border-radius:12px',
      'padding:14px 18px 12px',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:10px',
      'min-width:180px',
      'box-shadow:0 4px 24px rgba(0,0,0,0.6)'
    ].join(';');

    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;font-weight:700;color:#e6edf3;text-align:center;line-height:1.4;';
    msg.textContent = 'ნოტიფიკაცია წაიშალოს?';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const yes = document.createElement('button');
    yes.style.cssText = 'background:#f85149;border:none;color:#fff;border-radius:8px;padding:6px 18px;font-size:13px;font-weight:700;cursor:pointer;';
    yes.textContent = 'კი';

    const no = document.createElement('button');
    no.style.cssText = 'background:transparent;border:1px solid #444;color:#ccc;border-radius:8px;padding:6px 18px;font-size:13px;font-weight:700;cursor:pointer;';
    no.textContent = 'გაუქმება';

    btnRow.appendChild(yes); btnRow.appendChild(no);
    dlg.appendChild(msg); dlg.appendChild(btnRow);
    document.body.appendChild(dlg);

    const cleanup = () => dlg.remove();
    yes.addEventListener('click', async e => { e.stopPropagation(); cleanup(); await _ncardDoDelete(null, n); });
    no.addEventListener('click',  e => { e.stopPropagation(); cleanup(); });
    // tap outside also closes
    setTimeout(() => {
      function outside(e) { if (!dlg.contains(e.target)) { cleanup(); document.removeEventListener('touchstart', outside); } }
      document.addEventListener('touchstart', outside, { passive: true });
    }, 100);
    return;
  }
  const ov = _ncardOverlay(card, '🗑', '#f85149');
  ov.addEventListener('click', async e => { e.stopPropagation(); await _ncardDoDelete(ov, n); });
  setTimeout(() => {
    function cancel(e) { if (!card.contains(e.target)) { ov.remove(); document.removeEventListener('touchstart', cancel); } }
    document.addEventListener('touchstart', cancel, { passive: true });
  }, 100);
}

function _ncardOverlay(card, icon, color) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:absolute;inset:0;border-radius:10px;background:' + color + 'dd;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;z-index:2;';
  ov.textContent = icon;
  card.style.position = 'relative';
  card.appendChild(ov);
  return ov;
}

async function _ncardDoDelete(ov, n) {
  if (ov) ov.textContent = '…';
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/notifications?id=eq.' + n.id, {
      method: 'DELETE',
      headers: _authHeaders()
    });
    if (r.ok) await loadNotifs();
    else if (ov) ov.remove();
  } catch (e) { if (ov) ov.remove(); }
}

async function _consensusVoteCount(notifId) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/consensus_votes?notification_id=eq.' + notifId + '&select=id',
      { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
    if (!r.ok) return 0;
    const rows = await r.json();
    return rows.length;
  } catch (e) { return 0; }
}

function _startRealtime() {
  if (typeof supabase === 'undefined') return;
  try {
    const client = supabase.createClient(SUPA_URL, SUPA_KEY);
    // notifications channel
    client.channel('notif-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => loadNotifs())
      .subscribe();
    // dialogue overrides channel — realtime patch for all viewers
    client.channel('dlg-overrides')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dialogue_overrides' }, payload => {
        if (payload.new && payload.new.map_id === _MAP_ID) _applyDlgOverride(payload.new);
      })
      .subscribe();
  } catch (e) {}
}

function openNotifPopup(n) {
  _curNotif = n;
  const p = document.getElementById('notifPopup');
  p.style.setProperty('--nc', { info: '#58a6ff', warning: '#f0a500', danger: '#fb8f44', emergency: '#f85149', done: '#4ade80', project: '#c084fc' }[n.type] || '#58a6ff');
  document.getElementById('npType').textContent = (TYPE_LABELS[n.type] || n.type).toUpperCase();
  document.getElementById('npSender').textContent = n.sender ? ('👤 ' + n.sender) : '';
  const textEl = document.getElementById('npText'); textEl.textContent = '';
  const detEl = document.getElementById('npDetail'); detEl.style.display = 'none'; detEl.textContent = '';
  const ar = document.getElementById('npArea'); ar.style.display = 'none';
  const spd = _twSpeed(n.type);
  _typewriter(textEl, n.text || '', spd, () => { if (n.detail) { detEl.style.display = 'block'; _typewriter(detEl, n.detail, spd); } });
  if (n.linked_area) { ar.style.display = 'block'; ar.textContent = '🗺 ' + n.linked_area + ' — რუკაზე ნახვა →'; }
  const pw = Math.min(window.innerWidth * 0.9, 360);
  p.style.cssText = 'display:block;left:' + ((window.innerWidth - pw) / 2) + 'px;bottom:72px;max-width:' + pw + 'px;';
  p.classList.add('show');
}
function openNotifList() {
  closeNotifPopup();
  const p = document.getElementById('notifPopup');
  p.style.setProperty('--nc', '#58a6ff');
  document.getElementById('npType').textContent = 'ყველა შეტყობინება';
  document.getElementById('npSender').textContent = '';
  const body = document.getElementById('npText'); body.innerHTML = '';
  _notifs.forEach(n => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(48,54,61,0.4);cursor:pointer;';
    row.innerHTML = '<span style="font-size:16px;">' + (n.symbol || '💬') + '</span><span style="font-size:12px;color:#e6edf3;flex:1;">' + (n.text || '') + '</span>';
    row.onclick = () => { if (['consensus','project','done'].includes(n.type) && n.quorum_count) openConsensusPopup(n); else openNotifPopup(n); }; body.appendChild(row);
  });
  document.getElementById('npDetail').textContent = ''; document.getElementById('npDetail').style.display = 'none';
  document.getElementById('npArea').style.display = 'none';
  const pw = Math.min(window.innerWidth * 0.9, 360);
  p.style.cssText = 'display:block;left:' + ((window.innerWidth - pw) / 2) + 'px;bottom:72px;max-width:' + pw + 'px;';
  p.classList.add('show');
}
function closeNotifPopup() { const p = document.getElementById('notifPopup'); p.classList.remove('show'); p.style.display = 'none'; }

// ── consensus notification ("talking circle") ──
// Dynamic quorum: shadow_admin is a permanent voter alongside every resident
// (not just a bootstrap fallback) — quorum = residentCount + shadowAdminCount
// at every stage: 0 residents -> quorum = shadow_admin count (bootstrap,
// normally 1); n residents -> quorum = n + shadowAdminCount (unanimous, all
// residents + shadow_admin(s) must agree). Used for every consensus-type
// notification (tier-change requests and plain /შეტყობინება^ alike).
window.consensusQuorumCount = async function () {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/user_tiers?tier=in.(resident,shadow_admin)&select=user_id', { headers: _authHeaders() });
    if (!r.ok) return 1;
    const rows = await r.json();
    return rows.length || 1;
  } catch (e) { return 1; }
};

// ── self-nomination (tier-up requests) ──
// Both self-service tiers use consensus: visitor→caretaker AND
// caretaker→resident. resident/shadow_admin have no self-service next tier.
window.nextTierFor = function (tier) {
  const order = ['visitor', 'caretaker', 'resident', 'shadow_admin'];
  const idx = order.indexOf(tier);
  if (idx === -1 || idx >= order.length - 2) return null;
  return order[idx + 1];
};

// Shared self-nomination logic — used by the applyTier dialogue button AND
// the /დაწინაურება terminal command, so the notification shape / quorum
// logic lives in exactly one place (avoids the two-places-to-fix drift that
// hit the quorum formula before). Creates a consensus notification tagged
// with subject_type='tier_change' (consumed server-side by
// resolve_tier_change), with a terminal_cmd that self-triggers on quorum.
// Blocks a second request while the person already has one open — per topic
// (tier_change), not globally.
window.requestTierUp = async function (targetTier, requestText, detail) {
  if (!window.isLoggedIn || !window.isLoggedIn()) return { ok: false, reason: 'not_logged_in' };
  const uid = window.myUserId();
  const name = window.myDisplayName();

  try {
    const dupR = await fetch(
      SUPA_URL + '/rest/v1/notifications?subject_type=eq.tier_change&subject_data->>user_id=eq.' + encodeURIComponent(uid) + '&select=id',
      { headers: _authHeaders() }
    );
    if (dupR.ok) {
      const dupRows = await dupR.json();
      if (dupRows && dupRows.length) return { ok: false, reason: 'already_pending' };
    }
    // if the dup-check itself fails (e.g. missing GRANT on notifications
    // SELECT), fail OPEN here — the insert below will surface the real
    // permission error clearly instead of masking it as "already_pending"
  } catch (e) { /* fail open — worst case a duplicate slips through, harmless */ }

  const label = targetTier === 'caretaker' ? 'ქეართეიქერი' : (targetTier === 'resident' ? 'რეზიდენტი' : targetTier);
  // requestText already IS the full message when it comes from a popup that
  // pre-filled the "<name>-ს სურს გახდეს <tier>" template (terminal command
  // path) — used verbatim. Only auto-generate it here when nothing was
  // supplied at all (the dialogue-button path, which has no popup).
  const text = (requestText && requestText.trim()) ? requestText.trim() : (name + '-ს სურს გახდეს ' + label);
  const quorum = typeof window.consensusQuorumCount === 'function' ? await window.consensusQuorumCount() : 1;

  try {
    const notifBody = {
      type: 'consensus', symbol: '🌱', text: text, sender: name, quorum_count: quorum,
      subject_type: 'tier_change',
      subject_data: { user_id: uid, from: window.myRealTier(), to: targetTier }
    };
    if (detail && detail.trim()) notifBody.detail = detail.trim();
    const r = await fetch(SUPA_URL + '/rest/v1/notifications', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, _authHeaders()),
      body: JSON.stringify(notifBody)
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      return { ok: false, reason: 'insert_failed', status: r.status, msg: errBody.slice(0, 200) };
    }
    const rows = await r.json();
    const row = rows && rows[0];
    if (!row) return { ok: false, reason: 'no_row' };

    await fetch(SUPA_URL + '/rest/v1/notifications?id=eq.' + row.id, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, _authHeaders()),
      body: JSON.stringify({ terminal_cmd: '/სტატუსი ' + row.id })
    });

    if (typeof loadNotifs === 'function') loadNotifs();
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, reason: 'exception', msg: e.message }; }
};

let _curConsensusNotif = null, _consensusVotes = [], _consensusChannel = null, _voteWritePending = false;
const _executedTerminalCmds = new Set(); // prevent re-firing on realtime re-evaluations

function openConsensusPopup(n) {
  closeNotifPopup();
  _curConsensusNotif = n;
  _consensusVotes = [];
  const p = document.getElementById('consensusPopup');
  
  const logoEl = document.getElementById('cpLogo');
  if (n.type === 'consensus') {
    logoEl.innerHTML = '<img src="logo.png" alt="Logo" style="width: 144px; height: 144px; object-fit: contain; vertical-align: middle;">';
  } else {
    logoEl.innerHTML = '';
    logoEl.textContent = n.symbol;
  }
  
  document.getElementById('cpQuestion').textContent = n.text || '';
  const detEl = document.getElementById('cpDetail');
  if (n.detail) { detEl.textContent = n.detail; detEl.style.display = 'block'; }
  else { detEl.textContent = ''; detEl.style.display = 'none'; }
  document.getElementById('cpStatus').textContent = '';
  _setConsensusToggle(null);
  document.getElementById('cpFeed').innerHTML = '';
  // voting itself is resident+ only — caretaker/visitor see the topic and
  // the live feed, but the yes/no buttons simply aren't there for them
  const canVote = typeof window._tierAtLeast === 'function' && window._tierAtLeast('resident');
  const yesBtn = document.getElementById('cpYes'), noBtn = document.getElementById('cpNo');
  if (yesBtn) yesBtn.style.display = canVote ? '' : 'none';
  if (noBtn) noBtn.style.display = canVote ? '' : 'none';
  p.style.display = 'flex';
  requestAnimationFrame(() => p.classList.add('show'));
  loadConsensusVotes(n.id);
  _subscribeConsensusVotes(n.id);
}


function closeConsensusPopup() {
  const n = _curConsensusNotif;
  const p = document.getElementById('consensusPopup');
  p.classList.remove('show');
  setTimeout(() => { if (!p.classList.contains('show')) p.style.display = 'none'; }, 200);
  if (_consensusChannel) { try { _consensusChannel.unsubscribe(); } catch (e) {} _consensusChannel = null; }
  _curConsensusNotif = null;
  // if voting was complete when user closed — auto-delete the notification
  if (n && n._allVoted) _autoDeleteVotingNotif(n);
}

async function _autoDeleteVotingNotif(n) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/notifications?id=eq.' + n.id, {
      method: 'DELETE',
      headers: _authHeaders()
    });
    if (r.ok) loadNotifs();
  } catch (e) {}
}

function _setConsensusToggle(vote) {
  const yes = document.getElementById('cpYes'), no = document.getElementById('cpNo');
  yes.classList.toggle('sel', vote === true);
  no.classList.toggle('sel', vote === false);
}

async function loadConsensusVotes(notifId) {
  if (_voteWritePending) return;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/consensus_votes?notification_id=eq.' + notifId + '&order=voted_at.asc',
      { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
    if (!r.ok) return;
    _consensusVotes = await r.json();
    _renderConsensusFeed();
    _evaluateConsensusState();
  } catch (e) {}
}

function _renderConsensusFeed() {
  const feed = document.getElementById('cpFeed');
  feed.innerHTML = '';
  if (!_consensusVotes.length) {
    feed.innerHTML = '<div class="cp-feed-empty">ჯერ არავის უხმია</div>';
  } else {
    _consensusVotes.forEach(v => {
      const row = document.createElement('div');
      row.className = 'cp-feed-row';
      row.innerHTML = '<span>' + (v.vote ? '🔘' : '❌') + '</span><span>' + (v.voter_name || '') + '</span>';
      feed.appendChild(row);
    });
  }
  const myName = window.myDisplayName ? window.myDisplayName() : localStorage.getItem('mdelo_sender');
  const myUid  = window.myUserId ? window.myUserId() : null;
  const mine = myUid && _consensusVotes.find(v => v.user_id === myUid);
  _setConsensusToggle(mine ? mine.vote : null);
}

// Voting requires login now — RLS enforces auth.uid() = user_id on write, and
// per the tier decisions, voting itself is resident+ only (caretaker never
// gets this UI surfaced in the first place — see cpYes/cpNo gating upstream).
async function castConsensusVote(vote) {
  if (!_curConsensusNotif) return;
  if (typeof window.isLoggedIn !== 'function' || !window.isLoggedIn()) {
    if (typeof toast === 'function') toast('⚠️ ხმის მისაცემად საჭიროა შესვლა — სცადე /ლოგინი');
    return;
  }
  if (typeof window._tierAtLeast !== 'function' || !window._tierAtLeast('resident')) {
    if (typeof toast === 'function') toast('⚠️ ხმის მიცემა resident-ის და უფრო მაღალი tier-ისთვისაა');
    return;
  }
  const uid = window.myUserId();
  const name = window.myDisplayName();

  // optimistic: update local array immediately, no flicker
  const existing = _consensusVotes.findIndex(v => v.user_id === uid);
  if (existing >= 0) {
    _consensusVotes[existing] = { ..._consensusVotes[existing], vote: vote, voted_at: new Date().toISOString() };
  } else {
    _consensusVotes.push({ notification_id: _curConsensusNotif.id, user_id: uid, voter_name: name, vote: vote, voted_at: new Date().toISOString() });
  }
  _renderConsensusFeed();
  _evaluateConsensusState();

  // persist to Supabase in background
  _voteWritePending = true;
  try {
    await fetch(SUPA_URL + '/rest/v1/consensus_votes?on_conflict=notification_id,user_id', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify({
        notification_id: _curConsensusNotif.id,
        user_id: uid,
        voter_name: name,
        vote: vote,
        voted_at: new Date().toISOString()
      })
    });
    // wait for DB to commit before allowing realtime/fetch to overwrite local state
    setTimeout(() => {
      _voteWritePending = false;
      if (_curConsensusNotif) loadConsensusVotes(_curConsensusNotif.id);
    }, 800);
  } catch (e) { _voteWritePending = false; }
}

function _evaluateConsensusState() {
  const n = _curConsensusNotif;
  if (!n) return;
  const statusEl = document.getElementById('cpStatus');
  const total = _consensusVotes.length;
  const quorum = n.quorum_count || 0;
  const quorumMet = !!quorum && total >= quorum;
  n._allVoted = quorumMet;

  const extra = quorum ? (total + '/' + quorum + ' ხმა') : (total + ' ხმა');
  let label, color;
  if (quorumMet) {
    const allAgree = _consensusVotes.every(v => v.vote === true);
    const RESULTS = {
      project: ['✅ პროექტი მხარდაჭერილია!', '🚫 პროექტი უარყოფილია!'],
      done:    ['✅ პროექტი შესრულდა!',       '🚫 პროექტი შეჩერდა!'],
    };
    const pair = RESULTS[n.type] || ['✅ კონსენსუსი შედგა!', '🚫 კონსენსუსი არ შედგა!'];
    label = allAgree ? pair[0] : pair[1];
    color = allAgree ? '#4ade80' : '#f85149';
    // fire terminal_cmd once on positive outcome
    if (allAgree && n.terminal_cmd && !_executedTerminalCmds.has(n.id)) {
      _executedTerminalCmds.add(n.id);
      if (typeof window.tmRun === 'function') window.tmRun(n.terminal_cmd);
      else if (typeof window.runMacro === 'function') window.runMacro(n.terminal_cmd);
    }
  } else {
    label = '📜 განხილვა მიმდინარეობს';
    color = '#55aa33';
  }
  statusEl.style.color = color;
  statusEl.textContent = label + ' · ' + extra;
}

function _subscribeConsensusVotes(notifId) {
  if (typeof supabase === 'undefined') return;
  if (_consensusChannel) { try { _consensusChannel.unsubscribe(); } catch (e) {} _consensusChannel = null; }
  try {
    const client = supabase.createClient(SUPA_URL, SUPA_KEY);
    _consensusChannel = client.channel('consensus-' + notifId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'consensus_votes', filter: 'notification_id=eq.' + notifId },
        () => loadConsensusVotes(notifId))
      .subscribe();
  } catch (e) {}
}
window.openConsensusPopup = openConsensusPopup;
window.closeConsensusPopup = closeConsensusPopup;
window.castConsensusVote = castConsensusVote;

function goToArea() {
  if (!_curNotif || !_curNotif.linked_area) return;
  closeNotifPopup();
  _gotoNamedLocation(_curNotif.linked_area);
}

// ── dialogue overrides (Supabase) ──
// Allows admin to edit dialogue via terminal; all viewers get updates via realtime.

const _MAP_ID = (_CFG && _CFG.title) ? _CFG.title : 'map';

// Find _OBJS index by hotspot data-title
function _findOiByTitle(title) {
  var hs = document.querySelector('.hotspot[data-title="' + title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]:not(.hs-area):not(.no-interact)');
  return (hs && hs.dataset.oi != null) ? +hs.dataset.oi : -1;
}

// Update hotspot DOM marker element.
// mk = internal marker string: '!' | '?' | '💬' | ''
// Creates .hs-marker if missing; hides/shows .hs-dot accordingly.
function _applyMarkerDom(hsEl, mk) {
  if (!hsEl) return;
  var dotEl = hsEl.querySelector('.hs-dot');
  var mkEl  = hsEl.querySelector('.hs-marker');
  if (mk) {
    if (!mkEl) {
      mkEl = document.createElement('div');
      hsEl.appendChild(mkEl);
    }
    // must set color class — without it the element is invisible
    mkEl.className   = mk === '!' ? 'hs-marker exc' : mk === '?' ? 'hs-marker q' : 'hs-marker chat';
    mkEl.textContent = mk === '💬' ? '...' : mk;
    mkEl.style.display = '';
    if (dotEl) dotEl.style.display = 'none';
  } else {
    if (mkEl)  mkEl.style.display  = 'none';
    if (dotEl) dotEl.style.display = '';
  }
  // persist by oi (unique per object, avoids title collisions)
  if (!_mkRestoring) {
    var _oi = hsEl.dataset.oi;
    if (_oi != null) _markerSave(_oi, mk || '');
  }
}

// ── marker persistence (keyed by oi, not title) ──────────────
var _MK_KEY = 'mdelo_mk_' + ((_CFG && _CFG.title) ? _CFG.title : 'map').replace(/[^a-zA-Z0-9ა-ჿ_-]/g, '_');
var _mkRestoring = false;
function _markerSave(oi, mk) {
  try {
    var s = JSON.parse(localStorage.getItem(_MK_KEY) || '{}');
    if (mk === '') delete s[oi]; else s[oi] = mk;
    localStorage.setItem(_MK_KEY, JSON.stringify(s));
  } catch(e) {}
}
function _markerRestore() {
  try {
    var s = JSON.parse(localStorage.getItem(_MK_KEY) || '{}');
    _mkRestoring = true;
    Object.keys(s).forEach(function(oi) {
      var el = document.querySelector('.hotspot[data-oi="' + oi + '"]:not(.hs-area)');
      if (el) _applyMarkerDom(el, s[oi]);
    });
    _mkRestoring = false;
  } catch(e) { _mkRestoring = false; }
}

// Patch _OBJS[oi].dialogue with data from Supabase row
function _applyDlgOverride(row) {
  if (!row || !row.obj_title || !row.nodes_json) return;
  var oi = _findOiByTitle(row.obj_title);
  if (oi < 0 || typeof _OBJS === 'undefined' || !_OBJS[oi]) return;

  var nodes = (Array.isArray(row.nodes_json) ? row.nodes_json : []).map(function(node) {
    if (!node || !node.text) return node;
    return Object.assign({}, node, { text: node.text.replace(/__OBJ___OBJ__/g, '__OBJ__') });
  });
  _OBJS[oi].dialogue = nodes;

  if (row.dsl && typeof parseBulkDSL === 'function') {
    try {
      var dslRaw = row.dsl;
      if (typeof parseUnlockHeaders === 'function') {
        var unlockData = parseUnlockHeaders(dslRaw);
        dslRaw = unlockData.dsl;
        _OBJS[oi].requires    = unlockData.requires;
        _OBJS[oi].on_complete = unlockData.on_complete;
        if (unlockData.on_complete && unlockData.on_complete.set_markers) {
          unlockData.on_complete.set_markers.forEach(function(m) {
            var el = document.querySelector('.hotspot[data-title="' + m.title + '"]:not(.hs-area)');
            if (el) _applyMarkerDom(el, m.mk);
            var tOi = el ? el.dataset.oi : null;
            if (tOi != null && _OBJS[+tOi]) _OBJS[+tOi].marker = m.mk === '~' ? '...' : m.mk;
          });
        }
      }
      var parsed = parseBulkDSL(dslRaw.trim() || '@0\n');
      var mk = parsed.marker === '...' ? '💬' : (parsed.marker || '');
      if (mk) _OBJS[oi].marker = mk;
      if (parsed.title) { _OBJS[oi].lb = parsed.title; _OBJS[oi].title = parsed.title; }
      var hsEl = document.querySelector('.hotspot[data-oi="' + oi + '"]:not(.hs-area)');
      // only apply Supabase marker if: has marker AND user has no local override
      var _mkStored = JSON.parse(localStorage.getItem(_MK_KEY) || '{}');
      if (mk && !(_mkStored.hasOwnProperty(String(oi)))) {
        _applyMarkerDom(hsEl, mk);
      }
      // sync window.DIALOGS so completeDialog sees updated requires/on_complete
      if (window.DIALOGS) {
        var _dlgKey = 'dlg_' + oi;
        if (window.DIALOGS[_dlgKey]) {
          window.DIALOGS[_dlgKey].requires    = _OBJS[oi].requires;
          window.DIALOGS[_dlgKey].on_complete = _OBJS[oi].on_complete;
          window.DIALOGS[_dlgKey].dialogue    = _OBJS[oi].dialogue;
        }
      }
    } catch(e) {}
  }
}

// Load all overrides for this map on startup
// ── menu todo checkbox state (persisted in Supabase, table: menu_todo_state) ──
var _gmTodoState = new Map(); // todo_id -> checked (bool)

async function loadTodoState() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/menu_todo_state?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    rows.forEach(function(row) { _gmTodoState.set(row.todo_id, !!row.checked); });
  } catch (e) {}
}

async function _gmSaveTodoState(todoId, checked) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/menu_todo_state?on_conflict=map_id,todo_id', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify({
        map_id: _MAP_ID,
        todo_id: todoId,
        checked: checked,
        updated_at: new Date().toISOString()
      })
    });
    if (!r.ok) console.error('todo save failed', r.status, await r.text());
  } catch (e) {}
}

// ── menu todo checkbox state (persisted in Supabase, table: menu_todo_state) ──
var _gmTodoState = new Map(); // todo_id -> checked (bool)

async function loadTodoState() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/menu_todo_state?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    rows.forEach(function(row) { _gmTodoState.set(row.todo_id, !!row.checked); });
  } catch (e) {}
}

async function _gmSaveTodoState(todoId, checked) {
  try {
    await fetch(SUPA_URL + '/rest/v1/menu_todo_state', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify({ map_id: _MAP_ID, todo_id: todoId, checked: checked, updated_at: new Date().toISOString() })
    });
  } catch (e) {}
}

async function loadDialogueOverrides() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/dialogue_overrides?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    rows.forEach(_applyDlgOverride);
  } catch (e) {}
}

// Save/update a dialogue override — called from terminal.js
window.dlgOverrideSave = async function(objTitle, nodesJson, dsl) {
  try {
    var body = JSON.stringify({
      map_id: _MAP_ID,
      obj_title: objTitle,
      nodes_json: nodesJson,
      dsl: dsl,
      updated_at: new Date().toISOString()
    });
    var r = await fetch(SUPA_URL + '/rest/v1/dialogue_overrides', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: body
    });
    if (r.ok) {
      // reuse _applyDlgOverride for nodes + marker + lb — single source of truth
      _applyDlgOverride({ obj_title: objTitle, nodes_json: nodesJson, dsl: dsl });
      return true;
    }
    var errBody = r.text ? await r.text().catch(function(){return "";}) : "";
    return { ok: false, status: r.status, msg: errBody.slice(0,150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// Get current DSL string for an object — called from terminal.js
window.dlgGetCurrentDsl = function(objTitle) {
  var oi = _findOiByTitle(objTitle);
  if (oi < 0 || typeof _OBJS === 'undefined' || !_OBJS[oi]) return '';
  var obj = _OBJS[oi];
  var dsl = '';
  if (obj.dialogue && obj.dialogue.length && typeof unparseDialogue === 'function') {
    dsl = unparseDialogue({ lb: obj.lb || objTitle, dialogue: obj.dialogue, marker: obj.marker || '' });
  }
  if (typeof unparseUnlockHeaders === 'function') {
    var headers = unparseUnlockHeaders(obj);
    if (headers) dsl = headers + '\n' + dsl;
  }
  return dsl;
};

// ── menu overrides (Supabase) ──
// Allows community members to extend the burger menu via the terminal's
// /cd /md /ფოთოლი /rm commands (see terminal.js). All viewers get the same
// merged structure on every page load — there is no realtime channel for this,
// just a fetch+merge into _CFG.menu before the burger menu is ever opened.
//
// Table: menu_overrides (map_id, node_id) unique
//   node_id    — Fixed ID of the node being touched (matches node.id in _CFG.menu,
//                survives re-export since menu-builder.js never regenerates ids)
//   parent_id  — only set when node_id is a brand-new node created via /md;
//                null means either "root-level" or "not a new node" (existing baked node)
//   icon/title — only meaningful for brand-new nodes
//   items_json — the CURRENT full items[] array for that node (snapshot, not a delta —
//                mirrors how dialogue_overrides stores the full nodes_json each time)
//   deleted    — tombstone; true means this node (and anything still hanging under it)
//                should be removed from the tree on load

// Find a node anywhere in _CFG.menu by its Fixed ID.
function _mnFindNode(id, nodes) {
  nodes = nodes || (_CFG.menu || []);
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes[i];
    if (nodes[i].children && nodes[i].children.length) {
      var f = _mnFindNode(id, nodes[i].children);
      if (f) return f;
    }
  }
  return null;
}

// Remove a node anywhere in _CFG.menu by its Fixed ID (used for `deleted` tombstones).
function _mnRemoveNodeById(id, nodes) {
  nodes = nodes || (_CFG.menu || []);
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) { nodes.splice(i, 1); return true; }
    if (nodes[i].children && nodes[i].children.length) {
      if (_mnRemoveNodeById(id, nodes[i].children)) return true;
    }
  }
  return false;
}

// Apply fetched menu_overrides rows onto _CFG.menu in place.
// Pass 1 attaches brand-new nodes — iteratively, since a new node's parent may
// itself be another new node that appears later/earlier in the unordered rows.
// Pass 2 applies items snapshots + deletions to every touched node (including
// ones just attached in pass 1).
function _applyMenuOverrides(rows) {
  if (!_CFG.menu) _CFG.menu = [];

  var pending = rows.filter(function (r) { return r.parent_id !== null && !r.deleted; });
  for (var pass = 0; pass < 50 && pending.length; pass++) {
    var stillPending = [];
    pending.forEach(function (r) {
      if (_mnFindNode(r.node_id)) return; // already attached
      var parentList;
      if (!r.parent_id) { parentList = _CFG.menu; }
      else {
        var parentNode = _mnFindNode(r.parent_id);
        parentList = parentNode ? (parentNode.children || (parentNode.children = [])) : null;
      }
      if (!parentList) { stillPending.push(r); return; }
      parentList.push({ id: r.node_id, icon: r.icon || '📁', title: r.title || '', items: [], children: [] });
    });
    pending = stillPending;
  }

  rows.forEach(function (r) {
    if (r.deleted) { _mnRemoveNodeById(r.node_id); return; }
    var node = _mnFindNode(r.node_id);
    if (node && Array.isArray(r.items_json)) node.items = r.items_json;
  });
}

// Load all menu overrides for this map on startup.
async function loadMenuOverrides() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/menu_overrides?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    _applyMenuOverrides(rows);
  } catch (e) {}
}

// Partial upsert — called from terminal.js. `fields` may include any of:
// parent_id, icon, title, items_json, deleted. Only the given keys are written;
// PostgREST's merge-duplicates upsert leaves every other column untouched.
window.menuOverrideSave = async function (nodeId, fields) {
  try {
    var body = Object.assign({ map_id: _MAP_ID, node_id: nodeId, updated_at: new Date().toISOString() }, fields);
    var r = await fetch(SUPA_URL + '/rest/v1/menu_overrides', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify(body)
    });
    if (r.ok) return true;
    var errBody = r.text ? await r.text().catch(function () { return ''; }) : '';
    return { ok: false, status: r.status, msg: errBody.slice(0, 150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// ── shared terminal macros (Supabase) ──
// Personal ("local") macros never leave the device — see terminal.js localStorage.
// Shared ("საერთო") macros are visible to every viewer; cached in window._tmMacroShared
// (name -> {commands: [...], min_tier: null|'visitor'|'caretaker'|'resident'})
// so terminal.js can resolve them with zero network latency once boot has
// finished. min_tier is set ONLY by shadow_admin (enforced server-side by a
// DB trigger, not just this client) — it's the sole mechanism that lets a
// lower tier run a specific whitelisted macro without granting standalone
// access to the raw commands inside it.
window._tmMacroShared = {};

async function loadMacroOverrides() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/terminal_macros?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    var shared = {};
    rows.forEach(function (row) { shared[row.name] = { commands: row.commands_json || [], min_tier: row.min_tier || null }; });
    window._tmMacroShared = shared;
  } catch (e) {}
}

window.macroOverrideSave = async function (name, commands, minTier) {
  try {
    var body = { map_id: _MAP_ID, name: name, commands_json: commands, min_tier: minTier || null, updated_at: new Date().toISOString() };
    var r = await fetch(SUPA_URL + '/rest/v1/terminal_macros', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify(body)
    });
    if (r.ok) { window._tmMacroShared[name] = { commands: commands, min_tier: minTier || null }; return true; }
    var errBody = r.text ? await r.text().catch(function () { return ''; }) : '';
    return { ok: false, status: r.status, msg: errBody.slice(0, 150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

window.macroOverrideDelete = async function (name) {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/terminal_macros?map_id=eq.' + encodeURIComponent(_MAP_ID) + '&name=eq.' + encodeURIComponent(name),
      { method: 'DELETE', headers: _authHeaders() }
    );
    if (r.ok) { delete window._tmMacroShared[name]; return true; }
    var errBody = r.text ? await r.text().catch(function () { return ''; }) : '';
    return { ok: false, status: r.status, msg: errBody.slice(0, 150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// ── main "?" legend override (Supabase) ──
// The legend's baked-in text (export time) lives in #questPopup. A single row
// per map_id is enough — there's only one legend, not a tree like the menu.
async function loadLegendOverride() {
  try {
    var r = await fetch(
      SUPA_URL + '/rest/v1/legend_overrides?map_id=eq.' + encodeURIComponent(_MAP_ID),
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!r.ok) return;
    var rows = await r.json();
    if (rows && rows[0] && rows[0].text != null) {
      var p = document.getElementById('questPopup');
      if (p) { p.dataset.full = rows[0].text; if (p.style.display === 'block') p.textContent = rows[0].text; }
    }
  } catch (e) {}
}

window.legendOverrideSave = async function (text) {
  try {
    var body = { map_id: _MAP_ID, text: text, updated_at: new Date().toISOString() };
    var r = await fetch(SUPA_URL + '/rest/v1/legend_overrides', {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }, _authHeaders()),
      body: JSON.stringify(body)
    });
    if (r.ok) return true;
    var errBody = r.text ? await r.text().catch(function () { return ''; }) : '';
    return { ok: false, status: r.status, msg: errBody.slice(0, 150) };
  } catch (e) { return { ok: false, status: 0, msg: e.message }; }
};

// ── init ──
// Toggle handler for the legend-tree static todo items (exportMenuHTML output).
// Visual-only for now — no persistence; resets on reload.
window.toggleTodoInExport = function(todoId) {
  const elements = document.querySelectorAll('[data-todo-id="' + todoId + '"] .todo-sym');
  elements.forEach(function(el) {
    el.textContent = (el.textContent.trim() === '⬜') ? '✅' : '⬜';
  });
};

window.addEventListener('load', async () => {
  await _authBoot();
  _renderDevViewBanner();
  loadNotifs();
  loadDialogueOverrides().then(_markerRestore);
  loadTodoState();
  loadTodoState();
  loadMenuOverrides();
  loadMacroOverrides();
  loadLegendOverride();
  _startRealtime();
  applySpotHash();
  applyAreaHash();
  _tmInit();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      if ('periodicSync' in reg) { reg.periodicSync.register('notif-check', { minInterval: 5 * 60 * 1000 }).catch(() => {}); }
      setInterval(() => { if (reg.active) reg.active.postMessage('CHECK_NOTIFS'); }, 5 * 60 * 1000);
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'NOTIF_UPDATE') loadNotifs(); });
  }
});
window.addEventListener('hashchange', () => { applySpotHash(); applyAreaHash(); });
