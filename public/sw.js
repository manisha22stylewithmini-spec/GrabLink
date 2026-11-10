// Minimal service worker: makes the app installable and keeps the shell available offline.
// API calls are never cached.
const CACHE = 'grab-video-v10';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'gv-meta').map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first so updates show up; fall back to cache when offline. Share-target visits (/?url=…) reuse the cached shell.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/' : req, copy)); }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req))
  );
});

// Background suggestions (Chrome on Android, installed app): look for fresh picks and notify.
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'gv-suggest') return;
  e.waitUntil((async () => {
    const res = await (await caches.open('gv-meta')).match('/__meta');
    if (!res) return;
    const meta = await res.json();
    if (!meta.personal || !meta.notify || !meta.interests.length) return;
    const q = meta.interests[Math.floor(Math.random() * Math.min(3, meta.interests.length))];
    const r = await fetch('/api/search?platform=youtube&q=' + encodeURIComponent(q));
    if (!r.ok) return;
    const data = await r.json();
    if (!data.items.length) return;
    await self.registration.showNotification(`New picks for “${q}”`, {
      body: data.items[0].title, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'gv-suggest',
      data: { url: '/?tab=home&q=' + encodeURIComponent(q) },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === location.origin);
    if (win) { await win.navigate(url).catch(() => {}); return win.focus(); }
    return clients.openWindow(url);
  })());
});
