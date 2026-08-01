// Social Connect — service worker
// Shell dell'app in cache (uso offline); feed sempre freschi quando c'è rete.

const CACHE = 'socialconnect-v3';
const SAVED_CACHE = 'socialconnect-saved';   // immagini dei contenuti salvati (offline)
const SHELL = [
  '.', 'index.html', 'css/style.css',
  'js/app.js', 'js/i18n.js', 'js/store.js',
  'i18n/it.json', 'i18n/en.json',
  'data/catalog.json',
  'assets/icon.svg',
  'assets/logos/youtube.svg', 'assets/logos/reddit.svg', 'assets/logos/bluesky.svg',
  'assets/logos/mastodon.svg', 'assets/logos/telegram.svg', 'assets/logos/instagram.svg',
  'assets/logos/facebook.svg', 'assets/logos/x.svg', 'assets/logos/tiktok.svg',
  'assets/logos/whatsapp.svg', 'assets/logos/rss.svg',
  'manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== SAVED_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Feed e API esterne: prima la rete, fallback alla cache (offline: anche le
  // immagini dei contenuti salvati, conservate in SAVED_CACHE)
  const isData = url.origin === location.origin && url.pathname.includes('/data/feeds/');
  const isExternal = url.origin !== location.origin;
  if (isData || isExternal) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && isData) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreVary: true }))
    );
    return;
  }

  // Shell: prima la rete (così gli aggiornamenti dell'app arrivano subito),
  // con la cache come rete di sicurezza quando si è offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreVary: true })
        .then(hit => hit || caches.match('index.html')))
  );
});
