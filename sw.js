import { APP_VERSION } from "./js/version.js";

const CACHE = `counter-${APP_VERSION}`;
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
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
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

  const allowedCdn = ALLOWED_CDN.some((o) => req.url.startsWith(o));
  if (!sameOrigin && !allowedCdn) return;

  const isAppShell = sameOrigin && /\.(html|js|css|webmanifest)$|\/$/.test(url.pathname);

  e.respondWith(
    isAppShell ? networkFirst(req) : staleWhileRevalidate(req)
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

function staleWhileRevalidate(req) {
  return caches.match(req).then((cached) => {
    const fetched = fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => cached || Response.error());
    return cached || fetched;
  });
}
