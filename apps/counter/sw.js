/*
 * Counter service worker: keeps the app shell cached so the counter opens and records stamps offline. The build
 * fills in CACHE_NAME and PRECACHE (vite.config.ts). A new build installs alongside and waits until the page tells
 * it to take over, which the page does only when its queue is empty and no work is in progress (AC 29). API
 * requests are never cached.
 */
const CACHE_NAME = "__CACHE_NAME__";
const PRECACHE = ["__PRECACHE__"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("counter-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  // Every page of the app (/, /pair) is the same shell. ignoreVary: module scripts send an Origin header that the
  // cached copies were fetched without, and a server answering with Vary: Origin would otherwise miss the cache.
  const options = { cacheName: CACHE_NAME, ignoreVary: true };
  const cached = request.mode === "navigate" ? caches.match("/index.html", options) : caches.match(request, options);
  event.respondWith(cached.then((response) => response ?? fetch(request)));
});
