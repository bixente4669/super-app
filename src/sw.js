// Offline shell. The file list and cache name are injected by the build, so they
// cannot drift from what was actually shipped.
const CACHE = "super-app-__VERSION__";
const SHELL = __SHELL__;

self.addEventListener("install", (event) => {
  // Deliberately no skipWaiting. A worker that takes over on its own swaps the assets
  // under a page that is already running, and leaves nobody able to tell whether what
  // is on screen is current. The page asks for the switch when the user agrees to it.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// Cache first, because a card has to open at the till whatever the signal is like.
// A background refresh keeps the shell current for the next launch.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then(async (response) => {
          if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) ?? new Response("Offline and not cached.", { status: 503 });
    })(),
  );
});
