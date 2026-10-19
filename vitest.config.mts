// Vitest 配置（2026-09-27）：本仓测试主体走 node:test（`npm test` = tsx --test）。
// 这里做两件事：①开启 globals，让同一份测试档在 vitest 与 tsx --test 两种
// 执行器下都能注册测试（测试档以 globalThis.test 优先、fallback node:test.test）；
// ②补 `@/*` → `src/*` 别名（2026-09-27 追加）——Vite 不读 tsconfig 的 paths，
// 没有这条的话任何 import 了 `@/lib/...` 的测试档在 vitest 下一律
// "Cannot find package '@/lib/...'" 而整档收集失败。
// 不引入第二套断言库：断言仍用 node:assert/strict。
import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
};
