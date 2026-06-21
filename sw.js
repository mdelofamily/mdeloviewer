// ============================================================
//  sw.js — Service Worker
//  ყოველ 5 წუთში Supabase-ს ამოწმებს და badge-ს განახლებს
// ============================================================

const SUPA_URL = 'https://miqenmsgwkkmtxwwbxzo.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pcWVubXNnd2trbXR4d3dieHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDc0NzYsImV4cCI6MjA5NDg4MzQ3Nn0.VfJgVoPC-ZbjlcuwMriYrNXb-3E2OgC92nOR9hOPgKI';
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 წუთი

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

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
