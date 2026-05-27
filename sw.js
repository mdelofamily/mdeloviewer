// ============================================================
//  sw.js — Service Worker
//  მართავს პერიოდულ შემოწმებას, Push ნოტიფიკაციებს და ბეიჯებს
// ============================================================

const SUPA_URL = 'https://miqenmsgwkkmtxwwbxzo.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pcWVubXNnd2trbXR4d3dieHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzMDc0NzYsImV4cCI6MjA5NDg4MzQ3Nn0.VfJgVoPC-ZbjlcuwMriYrNXb-3E2OgC92nOR9hOPgKI';
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 წუთი

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

// Supabase-ს შემოწმება და აიქონზე ბეიჯის მართვა
async function checkNotifs() {
  try {
    const res = await fetch(
      SUPA_URL + '/rest/v1/notifications?select=id&limit=20',
      { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
    );
    if (!res.ok) return;
    const data = await res.json();
    const count = data.length;
    
    // შესწორებულია: სერვის ვორკერში ვიყენებთ self.navigator-ს
    if (self.navigator && self.navigator.setAppBadge) {
      if (count > 0) { self.navigator.setAppBadge(count); }
      else { self.navigator.clearAppBadge(); }
    }
    
    // notify all open clients to refresh
    const allClients = await clients.matchAll({ type: 'window' });
    allClients.forEach(c => c.postMessage({ type: 'NOTIF_UPDATE', count }));
  } catch (e) {}
}

// ============================================================
// ⚡ ახალი ნაწილი: რეალურ დროში მოსული Push შეტყობინებების დაჭერა
// ============================================================
self.addEventListener('push', function(event) {
  if (!event.data) return;
  
  let data;
  try {
    data = event.data.json(); 
  } catch (e) {
    // თუ სერვერიდან JSON-ის ნაცვლად უბრალო ტექსტი მოვიდა
    data = { title: 'ახალი შეტყობინება', body: event.data.text(), url: '/' };
  }

  const options = {
    body: data.body,
    icon: '/logo.png',       // ფერადი ლოგო ნოტიფიკაციის შიგნით
    badge: '/badge.png',     // ⚡ სუფთა თეთრი აიქონი ზედა ზოლისთვის (Status Bar)
    vibrate: [200, 100, 200], // ⚡ ტელეფონის ვიბრაცია, რომ Popup გადმოაგდოს
    sound: 'default',
    tag: 'mdelo-notification', // არ აჭრელდეს ეკრანი, ჩაანაცვლოს ძველი
    renotify: true,
    data: { url: data.url || '/' }
  };

  // როცა პუში შემოდის, პარალელურად ბეიჯის რაოდენობასაც ვანახლებთ ბაზიდან
  event.waitUntil(
    Promise.all([
      checkNotifs(),
      self.registration.showNotification(data.title, options)
    ])
  );
});

// ნოტიფიკაციაზე ხელის დაჭერის ლოგიკა
self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  // აპლიკაციაში შესვლისას აიქონიდან ბეიჯის მოცილება
  if (self.navigator && self.navigator.clearAppBadge) {
    self.navigator.clearAppBadge().catch(err => console.error(err));
  }

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      // თუ საიტი სადმე უკვე გახსნილია, უბრალოდ იმ ჩანართზე გადავიდეს
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      // თუ გახსნილი არ არის, ახალ ფანჯარაში გაუხსნას ლინკი
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url || '/');
      }
    })
  );
});

// periodic sync every 5 min
self.addEventListener('periodicsync', e => {
  if (e.tag === 'notif-check') e.waitUntil(checkNotifs());
});

// fallback: message from page
self.addEventListener('message', e => {
  if (e.data === 'CHECK_NOTIFS') e.waitUntil(checkNotifs());
});

// initial check on activate
checkNotifs();
