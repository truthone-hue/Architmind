/* Architmind CI : fonctionnement hors ligne.
   À chaque mise à jour du site, augmentez le numéro de VERSION pour que
   les appareils des utilisateurs téléchargent la nouvelle version. */
const VERSION = "architmind-v27";

// Fichiers du site, mis en cache dès l'installation
const CORE = [
  "./",
  "./index.html",
  "./config.js",
  "./manifest.webmanifest",
  "./conditions.html",
  "./confidentialite.html",
  "./remboursement.html",
  "./mentions-legales.html",
  "./icons/favicon.svg",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

// Bibliothèques externes (three.js, Firebase, polices) gardées pour le hors ligne
const CDN = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
];

const CDN_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(CORE);
    await Promise.all(CDN.map(async (url) => {
      try {
        const r = await fetch(url, { mode: "cors", credentials: "omit" });
        if (r.ok) await cache.put(url, r);
      } catch (err) { /* sera mis en cache à la première utilisation */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("architmind-") && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Page et configuration : réseau d'abord (version à jour), copie locale si hors ligne ou réseau trop lent
async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(VERSION);
  const net = fetch(req).then((r) => {
    if (r.ok) cache.put(fallbackUrl || req, r.clone());
    return r;
  });
  const cached = await cache.match(fallbackUrl || req, { ignoreSearch: true });
  if (!cached) return net;
  const slow = new Promise((res) => setTimeout(() => res(cached), 4000));
  try { return await Promise.race([net, slow]); } catch (err) { return cached; }
}

// Bibliothèques et images : copie locale d'abord, mise à jour en arrière-plan
async function cacheFirst(req, refresh) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreVary: true });
  const net = fetch(req).then((r) => {
    if (r.ok || r.type === "opaque") cache.put(req, r.clone());
    return r;
  });
  if (cached) { if (refresh) net.catch(() => {}); return cached; }
  return net;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === "navigate") return e.respondWith(networkFirst(req, "./index.html"));
    if (url.pathname.endsWith("/config.js") || url.pathname.endsWith("/sw.js")) return e.respondWith(networkFirst(req));
    return e.respondWith(cacheFirst(req, true));
  }
  if (CDN_HOSTS.includes(url.hostname) || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    return e.respondWith(cacheFirst(req, url.hostname === "fonts.googleapis.com"));
  }
  // Tout le reste (connexion Firebase, base de données, paiement) passe directement par le réseau
});
