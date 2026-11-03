// 本地测试模式的判定，独立成模块的唯一原因：客户端 hook（use-auth.tsx）
// 需要它，而 sub2api.ts 依赖服务端模块（node:fs / node:zlib）——从那里
// import 会把服务端代码拖进浏览器 bundle，webpack 直接拒收。
// 放在这里的只有纯环境变量判断，两端都安全。
//
// 生产闸（S-07）：NEXT_PUBLIC_LOCAL_TEST_MODE=true 会让全站服务端鉴权失效。
// 白名单：只有 NODE_ENV 为 "development" 或 "test" 时才按该变量生效；其余（production／
// Production／staging／未设置）一律 false，除非显式 EIMU_ALLOW_LOCAL_TEST_MODE_IN_PROD=1
// （应急口；该变量非 NEXT_PUBLIC_*，客户端 bundle 读不到 ⇒ 放行时只有服务端侧生效，客户端仍 fail-closed）。
// NODE_ENV 与放行变量只从 process.env 读；调用方传入的 env 参数只用来读 NEXT_PUBLIC_LOCAL_TEST_MODE，
// 不能借它传放行变量。NODE_ENV / NEXT_PUBLIC_* 在客户端构建期被内联，故两端一致安全。

export type EnvLike = Record<string, string | undefined>;

const NODE_ENV = process.env.NODE_ENV;
const ENV_ALLOWS_LOCAL_TEST = NODE_ENV === "development" || NODE_ENV === "test";

function gateOpen(): boolean {
  return ENV_ALLOWS_LOCAL_TEST || process.env.EIMU_ALLOW_LOCAL_TEST_MODE_IN_PROD === "1";
}

export function shouldBypassAuthForLocalTest(env: EnvLike): boolean {
  if (env.NEXT_PUBLIC_LOCAL_TEST_MODE !== "true") return false;
  return gateOpen();
}

// 仅服务端、仅模块加载时一次；不进客户端控制台。
if (typeof window === "undefined" && process.env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true" && !gateOpen()) {
  console.error(
    "[local-test-mode] 非 development/test 环境检测到 NEXT_PUBLIC_LOCAL_TEST_MODE=true，已强制忽略（如确需放行请显式设置 EIMU_ALLOW_LOCAL_TEST_MODE_IN_PROD=1）。",
  );
}

export const LOCAL_TEST_MODE = shouldBypassAuthForLocalTest({
  NEXT_PUBLIC_LOCAL_TEST_MODE: process.env.NEXT_PUBLIC_LOCAL_TEST_MODE,
});
