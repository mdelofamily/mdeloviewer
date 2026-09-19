// ============================================================
//  push-notifications.js — Client Subscribe Logic (Scope B)
//  Depends on (already defined by runtime.js, loaded earlier):
//    SUPA_URL, SUPA_KEY, _MAP_ID
// ============================================================

const VAPID_PUBLIC_KEY = 'BBIQO1F3JjhnTK_k3-VPtsQz9CirxaajAwESodkE4zVXgIFxq1biwjmiBha7C-RE42B6EyArOIvBV_WTW4zWM1s';
const PUSH_DB_NAME = 'mdelo-push';
const PUSH_DB_STORE = 'meta';
const PUSH_DB_KEY = 'map_id';

function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PUSH_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PUSH_DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _idbSetMapId(mapId) {
  try {
    const db = await _idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PUSH_DB_STORE, 'readwrite');
      tx.objectStore(PUSH_DB_STORE).put(mapId, PUSH_DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Hides the button only when a subscription genuinely exists — checking
// Notification.permission alone was wrong: permission stays 'granted'
// forever once given, even after the underlying subscription goes stale
// (PWA reinstall, browser update, SW re-registration, endpoint expiry).
// That silently hid the only way to re-subscribe, with no error shown —
// exactly the "used to work, don't know when it stopped" failure mode.
async function _updatePushBtnVisibility() {
  const btn = document.getElementById('pushBtn');
  if (!btn) return;
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { btn.style.display = 'none'; return; }
  if (Notification.permission !== 'granted') { btn.style.display = ''; return; }
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), 8000))
    ]);
    const sub = await reg.pushManager.getSubscription();
    btn.style.display = sub ? 'none' : ''; // permission granted but no live subscription → show button, let them re-subscribe
  } catch (e) {
    btn.style.display = ''; // couldn't verify — err toward showing the button rather than hiding a possibly-broken state
  }
}

// Public hook — called by the "ჩართე ნოტიფიკაციები" button (#pushBtn).
window.initPushNotifications = async function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  try {
    const permission = await Notification.requestPermission();
    _updatePushBtnVisibility();
    if (permission !== 'granted') return;

    // defensive: serviceWorker.ready normally resolves fast (registration
    // happens on page load, well before a user can click), but if
    // registration silently failed it would hang forever — bound it.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw-timeout')), 8000))
    ]);

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });

    await _idbSetMapId(_MAP_ID);

    const saveRes = await fetch(SUPA_URL + '/rest/v1/push_subscriptions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        map_id: _MAP_ID,
        endpoint: sub.endpoint,
        p256dh: _arrayBufferToBase64(sub.getKey('p256dh')),
        auth: _arrayBufferToBase64(sub.getKey('auth'))
      })
    });
    if (!saveRes.ok) {
      // Browser-side subscribe succeeded but Supabase rejected the save —
      // was previously swallowed silently, leaving a subscription that
      // exists on-device but was never recorded server-side, so send-push
      // would never reach it.
      const errText = await saveRes.text().catch(() => '');
      console.error('[push] failed to save subscription:', saveRes.status, errText);
      if (typeof toast === 'function') toast('⚠️ subscription ვერ შეინახა სერვერზე (' + saveRes.status + ')');
      return;
    }
    _updatePushBtnVisibility();
  } catch (e) {
    if (typeof toast === 'function') toast('⚠️ ნოტიფიკაციების ჩართვა ვერ მოხერხდა');
  }
};

window.addEventListener('load', _updatePushBtnVisibility);
