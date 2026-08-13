import { closeGenerationSql } from "../src/lib/generation-core/database";
import { runGenerationWorker } from "../src/lib/generation-core/worker-service";

runGenerationWorker()
  .catch((error) => {
    console.error("[generation-worker] fatal", error);
    process.exitCode = 1;
  })
  .finally(() => closeGenerationSql());
