const CACHE = "image-studio-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 帶 hash 的靜態資源：network-first，成功就進快取，離線直接命中。
  if (request.destination === "script" || request.destination === "style" || request.destination === "font") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error())),
    );
    return;
  }

  // 文件導航一律放行網絡：緩存頁面殼會讓部署後的瀏覽器拿到舊 HTML/舊
  // chunk 引用（2026-09-05 登錄修復多輪「改了沒生效」的根因），登錄站離線
  // 無意義，不緩存導航。
});