// 本地测试模式的判定，独立成模块的唯一原因：客户端 hook（use-auth.tsx）
// 需要它，而 sub2api.ts 依赖服务端模块（node:fs / node:zlib）——从那里
// import 会把服务端代码拖进浏览器 bundle，webpack 直接拒收。
// 放在这里的只有纯环境变量判断，两端都安全。

export type EnvLike = Record<string, string | undefined>;

export function shouldBypassAuthForLocalTest(env: EnvLike): boolean {
  return env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true";
}

export const LOCAL_TEST_MODE = process.env.NEXT_PUBLIC_LOCAL_TEST_MODE === "true";
