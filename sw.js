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
