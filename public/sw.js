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

  // 带 hash 的静态资源：network-first，成功就进快取，离线直接命中。
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

  // 文件导航一律放行网络：缓存页面壳会让部署后的浏览器拿到旧 HTML/旧
  // chunk 引用（2026-09-05 登录修复多轮「改了没生效」的根因），登录站离线
  // 无意义，不缓存导航。
});