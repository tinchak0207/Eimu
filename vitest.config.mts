// Vitest 配置（2026-09-27）：本倉測試主體走 node:test（`npm test` = tsx --test）。
// 這裡做兩件事：①開啟 globals，讓同一份測試檔在 vitest 與 tsx --test 兩種
// 執行器下都能註冊測試（測試檔以 globalThis.test 優先、fallback node:test.test）；
// ②補 `@/*` → `src/*` 別名（2026-09-27 追加）——Vite 不讀 tsconfig 的 paths，
// 沒有這條的話任何 import 了 `@/lib/...` 的測試檔在 vitest 下一律
// "Cannot find package '@/lib/...'" 而整檔收集失敗。
// 不引入第二套斷言庫：斷言仍用 node:assert/strict。
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
