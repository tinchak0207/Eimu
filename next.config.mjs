/** @type {import('next').NextConfig} */
const controlPlaneOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN
  ?.trim()
  .replace(/\/$/, "");
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31536000,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "raw.githubusercontent.com",
        pathname: "/freestylefly/awesome-gpt-image-2/**",
      },
      // Canvas 节点缩略图走 /_next/image 优化器（CanvasNodeView 的 thumbUrl），
      // 上游生成结果存在 Vercel Blob。Blob 域不在白名单时优化器直接回 400，
      // 导致 <img> onError → 节点显示「图片加载失败」。必须放行。
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com",
      },
    ],
  },
  async rewrites() {
    const controlPlaneRewrites = controlPlaneOrigin
      ? [
        // Vercel remains the public web edge while durable work runs beside its
        // PostgreSQL database and worker on the VPS.
        { source: "/v1/:path*", destination: `${controlPlaneOrigin}/image-control/v1/:path*` },
        { source: "/api/generate-images", destination: `${controlPlaneOrigin}/image-control/api/generate-images` },
        // 裸路徑要單獨列一條。Next 的 `/:path*` 不匹配「後面完全沒有一段」的
        // `/api/generation-jobs`，而前端提交新任務打的正是這個裸路徑（帶 :path*
        // 的那條只服務 /api/generation-jobs/<id> 這種輪詢）。少了這條，POST 會
        // 落在 Vercel，而 Vercel 沒有 GENERATION_CONTROL_PLANE_ENABLED 與
        // GENERATION_DATABASE_URL，於是回 503 control_plane_disabled，前端退回
        // 舊生成路徑並把上游直鏈交給瀏覽器（載不到、下載失敗）。
        { source: "/api/generation-jobs", destination: `${controlPlaneOrigin}/image-control/api/generation-jobs` },
        { source: "/api/generation-jobs/:path*", destination: `${controlPlaneOrigin}/image-control/api/generation-jobs/:path*` },
        { source: "/api/admin/billing-operations/:path*", destination: `${controlPlaneOrigin}/image-control/api/admin/billing-operations/:path*` },
      ]
      : [];
    // CRITICAL: 控制面代理必須放 `beforeFiles`，不能放在回傳陣列裡。
    //
    // `rewrites()` 回傳陣列時語意等同 `afterFiles`——Next.js 先比對檔案系統路由，
    // 命中就結束，rewrite 永遠不會被考慮。而 /api/generate-images 與
    // /api/generation-jobs 在本 repo 都有同名 route.ts，所以那兩條代理曾長期是死的：
    // 請求全落在 Vercel 上，而 Vercel 沒有 GENERATION_CONTROL_PLANE_ENABLED 與
    // GENERATION_DATABASE_URL，於是回 503 control_plane_disabled（generate-images 回 500）。
    // 前端收到 503 會退回舊生成路徑，那條路徑直接把上游 images-ng.pixai.art 直鏈交給
    // 瀏覽器，於是使用者看到 ERR_CONNECTION_CLOSED、下載按鈕失效。
    //
    // /v1/:path* 當時看起來正常，只是因為 repo 裡沒有 src/app/v1 目錄，不是因為順序對。
    // 別把這幾條搬回回傳陣列。
    return {
      beforeFiles: controlPlaneRewrites,
      afterFiles: [
      // B 端的 Base URL 对外是 `https://image.tinchak0207.xyz/v1`，
      // OpenAI SDK 会在其后拼上 `/images/generations`，而路由实际住在 /api/v1 下。
      // 用重写而不是让客户填 `/api/v1`：Base URL 里带 `/api` 不像正经 API 服务，
      // 而且日后把 /v1 挪到独立子域或独立服务时，客户端不用改配置。
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      // Gatus does not support path-based UI hosting, so the app renders the
      // /status page and proxies only its read-only status API.
        {
          source: "/status/api/:path*",
          destination: "https://store.tinchak0207.xyz/gatus-api/:path*",
        },
      ],
    };
  },
};

export default nextConfig;
