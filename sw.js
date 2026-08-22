// ============================================================
//  sw.js — Service Worker
//  ყოველ 5 წუთში Supabase-ს ამოწმებს და badge-ს განახლებს
//  + offline app-shell caching (Cache API) — scope-offline-viewer.md §1
// ============================================================

const SUPA_URL = 'https://miqenmsgwkkmtxwwbxzo.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pcWVubXNnd2trbXR4d3dieHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDc0NzYsImV4cCI6MjA5NDg4MzQ3Nn0.VfJgVoPC-ZbjlcuwMriYrNXb-3E2OgC92nOR9hOPgKI';
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 წუთი

// ── offline app-shell precache ──────────────────────────────────────────
// Paths relative to this file's own scope (mdeloviewer root) — confirmed
// correct. Precaches the skins (objects.png 164KB, tiles.png 224KB) plus
// the rest of the app shell so the site is visually usable offline.
const CACHE_NAME = 'mdelo-shell-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './chat.js',
  './chat-hud.js',
  './bulk-parser.js',
  './manifest.json',
  './logo.png',
  './skin/tiles.png',
  './skin/objects.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(err => console.error('[sw] precache failed', err)) // don't let one missing file block install
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

// Cache-first for same-origin GET requests (app shell + skins). Falls back
// to network and opportunistically caches whatever comes back. Cross-origin
// requests (Supabase REST/Storage/Realtime, push, etc.) are left completely
// untouched — those must always hit the network live.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => {
        if (cached) return cached;
        // Known limitation (scope-offline-viewer.md §1): if site-data/cache
        // ever gets cleared manually, the precache is gone until the next
        // online visit repopulates it. A navigation with nothing cached and
        // no network gets this explicit message instead of a generic error.
        if (req.mode === 'navigate') {
          return new Response(
            '<!doctype html><meta charset="utf-8">' +
            '<body style="font-family:sans-serif;background:#111;color:#eee;display:flex;' +
            'align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;">' +
            '<div><h2>ვერ ვხედავ ჩაცხრილულ მონაცემებს</h2>' +
            '<p>საჭიროა ერთხელ ონლაინ შესვლა, რომ საიტი ხელახლა შეინახოს ოფლაინ-ხილვისთვის.</p></div>' +
            '</body>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        }
        return Response.error();
      });
      return cached || network;
    })
  );
});

async function checkNotifs() {
  try {
    const res = await fetch(
      SUPA_URL + '/rest/v1/notifications?select=id&limit=20',
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const count = data.length;
    if (navigator.setAppBadge) {
      if (count > 0) { navigator.setAppBadge(count); }
      else { navigator.clearAppBadge(); }
    }
    // notify all open clients to refresh
    const allClients = await clients.matchAll({ type: 'window' });
    allClients.forEach(c => c.postMessage({ type: 'NOTIF_UPDATE', count }));
  } catch (e) {}
}

// periodic sync every 5 min
self.addEventListener('periodicsync', e => {
  if (e.tag === 'notif-check') e.waitUntil(checkNotifs());
});

// fallback: message from page
self.addEventListener('message', e => {
  if (e.data === 'CHECK_NOTIFS') checkNotifs();
});

// initial check on activate
checkNotifs();

// ============================================================
//  PUSH NOTIFICATIONS — SCOPE A
// ============================================================

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Mdelo', {
        body: data.body || '',
        icon: 'logo.png',
        badge: 'logo.png',
        data: { url: data.url || '/' }
      }),
      checkNotifs()
    ])
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(allClients => {
      for (const c of allClients) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

const VAPID_PUBLIC_KEY = 'BBIQO1F3JjhnTK_k3-VPtsQz9CirxaajAwESodkE4zVXgIFxq1biwjmiBha7C-RE42B6EyArOIvBV_WTW4zWM1s';
const PUSH_DB_NAME = 'mdelo-push';
const PUSH_DB_STORE = 'meta';
const PUSH_DB_KEY = 'map_id';

function getMapIdFromIDB() {
  return new Promise(resolve => {
    const req = indexedDB.open(PUSH_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PUSH_DB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(PUSH_DB_STORE, 'readonly');
      const getReq = tx.objectStore(PUSH_DB_STORE).get(PUSH_DB_KEY);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function _abToB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function saveSubscriptionToSupabase(mapId, sub) {
  return fetch(SUPA_URL + '/rest/v1/push_subscriptions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      map_id: mapId,
      endpoint: sub.endpoint,
      p256dh: _abToB64(sub.getKey('p256dh')),
      auth: _abToB64(sub.getKey('auth'))
    })
  }).catch(() => {});
}

self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    getMapIdFromIDB().then(mapId => {
      if (!mapId) return;
      return self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      }).then(sub => saveSubscriptionToSupabase(mapId, sub));
    })
  );
});
