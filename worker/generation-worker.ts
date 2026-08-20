import { closeGenerationSql } from "../src/lib/generation-core/database";
import { runGenerationWorker } from "../src/lib/generation-core/worker-service";

// 容器重啟等於在飛任務全部停擺 → deadline_exceeded 退款；浮動 promise（心跳/遙測）的 rejection 只記錄，不殺進程。
process.on("unhandledRejection", (reason) => {
  console.error("[generation-worker] unhandledRejection（記錄不退出）", reason);
});

runGenerationWorker()
  .catch((error) => {
    console.error("[generation-worker] fatal", error);
    process.exitCode = 1;
  })
  .finally(() => closeGenerationSql());
