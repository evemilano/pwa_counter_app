import { APP_VERSION } from "./js/version.js";

const CACHE = `counter-${APP_VERSION}`;
// Tailwind e i moduli esm.sh (URL già versionati) vivono in una cache NON
// legata alla versione: se activate li cancellasse a ogni bump, la prima
// apertura offline dopo un aggiornamento non partirebbe.
const CDN_CACHE = "counter-cdn";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/db.js",
  "./js/dashboard.js",
  "./js/stats.js",
  "./js/stats-math.js",
  "./js/history.js",
  "./js/settings.js",
  "./js/sync.js",
  "./js/version.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable.png",
  "./icons/shortcut-plus.png",
  "./fonts/inter-variable.woff2",
  "./fonts/montserrat-variable.woff2",
  "./fonts/material-symbols-outlined.woff2",
];

const ALLOWED_CDN = [
  "https://esm.sh",
  "https://cdn.tailwindcss.com",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // cache:"reload": salta la cache HTTP, altrimenti la nuova versione può
    // precacheare JS/CSS vecchi.
    await c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })));
    await migrateCdnEntries();
  })());
  self.skipWaiting();
});

// Le versioni <= v42 tenevano i file CDN nella cache versionata: copiali in
// CDN_CACHE prima che activate la cancelli.
async function migrateCdnEntries() {
  const cdn = await caches.open(CDN_CACHE);
  for (const k of await caches.keys()) {
    if (!k.startsWith("counter-v")) continue;
    const old = await caches.open(k);
    for (const req of await old.keys()) {
      if (!isCdn(req.url) || await cdn.match(req)) continue;
      const res = await old.match(req);
      if (res) await cdn.put(req, res);
    }
  }
}

function isCdn(url) {
  return ALLOWED_CDN.some((o) => url.startsWith(o));
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // Solo le nostre cache: l'origine è condivisa con il resto del sito.
      Promise.all(keys.filter((k) => k.startsWith("counter-") && k !== CACHE && k !== CDN_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname.includes("/api/")) return;
  if (req.method !== "GET") return;

  const allowedCdn = isCdn(req.url);
  if (!sameOrigin && !allowedCdn) return;

  const isAppShell = sameOrigin && /\.(html|js|css|webmanifest)$|\/$/.test(url.pathname);

  e.respondWith(
    isAppShell ? networkFirst(req) : staleWhileRevalidate(req, allowedCdn ? CDN_CACHE : CACHE)
  );
});

function networkFirst(req) {
  return fetch(req, { cache: "no-store" })
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(async () => {
      // ignoreSearch: le navigazioni con query (es. lo shortcut ./?action=quick-inc
      // del manifest) non matchano l'entry "./" precacheata. Nessun asset usa la
      // query string per il versioning, quindi il match allargato e' sicuro.
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === "navigate") {
        const shell = await caches.match("./index.html");
        if (shell) return shell;
      }
      // Mai risolvere a undefined: respondWith(undefined) e' un TypeError.
      return Response.error();
    });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.match(req).then((cached) => {
    const fetched = fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(cacheName).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => cached || Response.error());
    return cached || fetched;
  });
}
