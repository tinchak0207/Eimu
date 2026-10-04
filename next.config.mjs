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
  // 建置期版本指纹，供 /api/version 取证用（唯一消费者，不影响其他 bundle）。
  // 必要性：VERCEL_GIT_COMMIT_SHA 只在 build 阶段保证存在、runtime 不保证；而 route 内
  // new Date() 是「请求时间」不是「建置时间」。两者都会误导「生产跑的是哪一版」的取证，
  // 故在此（=config 求值时 = build 时）冻结成常数，由 Next 内联进 server bundle。
  env: {
    BUILD_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
    BUILD_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF ?? "",
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
      { source: "/docs/harness", destination: "/docs/workflow", permanent: true },
      { source: "/docs/harness/:path*", destination: "/docs/workflow", permanent: true },
      { source: "/docs/report", destination: "/docs", permanent: true },
    ];
  },
  async rewrites() {
    const controlPlaneRewrites = buildControlPlaneRewrites(controlPlaneOrigin);
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
      beforeFiles: controlPlaneRewrites,
      afterFiles: [
      // B 端的 Base URL 对外是 `https://eimu.dev/v1`，
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
