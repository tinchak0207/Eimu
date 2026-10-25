import { controlPlaneRewrites as buildControlPlaneRewrites } from "./src/lib/control-plane-proxy-routes.mjs";

/** @type {import('next').NextConfig} */
const controlPlaneOrigin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN
  ?.trim()
  .replace(/\/$/, "");
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Vercel 远程构建跳过 lint＋型别检查（每次省约 60s）；本机 `npm run build` 照常把关。
  eslint: { ignoreDuringBuilds: process.env.VERCEL === "1" },
  typescript: { ignoreBuildErrors: process.env.VERCEL === "1" },
  // 建置期「新鲜度指纹」，供 /api/version 取证用（唯一消费者，不影响其他 bundle）。
  // 必要性：route 内 new Date() 是「请求时间」不是「建置时间」，会误导「生产跑的是哪一版」
  // 的取证，故在此（=config 求值时 = build 时）冻结成常数，由 Next 内联进 server bundle。
  // 安全（红队 2026-10-05）：不再冻结 BUILD_COMMIT_SHA／BUILD_COMMIT_REF——git SHA 会
  // 让对手精确对到版本打已知 CVE，且 /api/version 已不再回传；建置时间足以答「新鲜度」。
  env: {
    BUILD_TIMESTAMP: new Date().toISOString(),
  },
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
  async headers() {
    // 仅 public 静态媒体；账户、页面和 API 不进入共享缓存。
    // 文件名可被替换，故不标 immutable；后台更新允许过期 CDN 副本先返回。
    return ["showcase", "promo", "fonts", "mascot", "brands", "provider-icons", "email"].map((directory) => ({
      source: `/${directory}/:path*`,
      headers: [{
        key: "Cache-Control",
        value: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      }],
    }));
  },
  // 2026-09-27 SEO 重构：旧 URL 全部 301 到承接页，不留 404。
  //  - 102 个 `<行业>-<n>` 模板门页并入 17 个行业枢纽页 /use-cases/<行业>
  //    （清单与 src/lib/use-case-categories/index.ts 的 17 个 slug 一致）。
  //  - /docs/harness 与 /docs/harness/deep 在 GSC 仍有曝光且排名最好，
  //    子页已在文档收敛时删除，内容归入「工作流与画布」。
  async redirects() {
    const legacyCategories = [
      "ecommerce", "content", "design", "personal-brand", "marketing", "anime",
      "photography", "ui", "education", "gaming", "architecture", "fashion",
      "health", "finance", "travel", "automotive", "training",
    ];
    return [
      ...legacyCategories.map((category) => ({
        source: `/use-cases/${category}-:n(\\d+)`,
        destination: `/use-cases/${category}`,
        permanent: true,
      })),
      { source: "/agent", destination: "/?agent=1", permanent: false },
      { source: "/docs/harness", destination: "/docs/workflow", permanent: true },
      { source: "/docs/harness/:path*", destination: "/docs/workflow", permanent: true },
      { source: "/docs/report", destination: "/docs", permanent: true },
    ];
  },
  async rewrites() {
    const controlPlaneRewrites = buildControlPlaneRewrites(controlPlaneOrigin);
    // 影片生成必须先进 Vercel 的处理器套动作合同，再代理到控制面。
    // 若交给 controlPlaneRewrites 的 `/v1/:path*`、`/api/v1/:path*` 通配，请求会
    // 直接被代理走，站点的 directVideoPrompt 永远看不到 B 端影片请求（2026-10-20
    // 实测：落库 prompt 仍是用户原句）。精确重写必须排在全量代理之前。
    const videoContractRewrites = [
      { source: "/v1/videos/generations", destination: "/api/video-contract/generations" },
      { source: "/api/v1/videos/generations", destination: "/api/video-contract/generations" },
    ];
    // CRITICAL: 控制面代理必须放 `beforeFiles`，不能放在回传阵列里。
    //
    // `rewrites()` 回传阵列时语意等同 `afterFiles`——Next.js 先比对档案系统路由，
    // 命中就结束，rewrite 永远不会被考虑。而 /api/generate-images 与
    // /api/generation-jobs 在本 repo 都有同名 route.ts，所以那两条代理曾长期是死的：
    // 请求全落在 Vercel 上，而 Vercel 没有 GENERATION_CONTROL_PLANE_ENABLED 与
    // GENERATION_DATABASE_URL，于是回 503 control_plane_disabled（generate-images 回 500）。
    // 前端收到 503 会退回旧生成路径，那条路径直接把上游 images-ng.pixai.art 直链交给
    // 浏览器，于是使用者看到 ERR_CONNECTION_CLOSED、下载按钮失效。
    //
    // /v1/:path* 当时看起来正常，只是因为 repo 里没有 src/app/v1 目录，不是因为顺序对。
    // 别把这几条搬回回传阵列。
    return {
      beforeFiles: [...videoContractRewrites, ...controlPlaneRewrites],
      afterFiles: [
      // B 端的 Base URL 对外是 `https://eimu.dev/v1`，
      // OpenAI SDK 会在其后拼上 `/images/generations`，而路由实际住在 /api/v1 下。
      // 用重写而不是让客户填 `/api/v1`：Base URL 里带 `/api` 不像正经 API 服务，
      // 而且日后把 /v1 挪到独立子域或独立服务时，客户端不用改配置。
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      // Gatus does not support path-based UI hosting, so the app renders the
      // /status page and proxies only its read-only status API.
      //
      // 收窄（红队 2026-10-05 Hack 实测）：原为 `/status/api/:path*` → 上游 nginx 把
      // `/gatus-api/*` rewrite 成 Gatus `/api/v1/*`，而 deploy/gatus/config/config.yaml
      // 没有 security 段 ⇒ 免登录即可打 Gatus 整个管理 API（/status/api/config、
      // /status/api/endpoints…），公开面远大于页面实际所需。
      // 页面唯一消费者是 StatusDashboard.tsx 的 `/status/api/endpoints/statuses`
      // （page.tsx 的 SSR 直连上游，不过此 rewrite），故只放行这一条精确路径；
      // 其余 /status/api/* 落回 Next 档案系统即 404。
        {
          source: "/status/api/endpoints/statuses",
          destination: "https://store.tinchak0207.xyz/gatus-api/endpoints/statuses",
        },
      ],
    };
  },
};

export default nextConfig;
