#!/usr/bin/env -S npx tsx
//
// CLI for the generation control-plane canary.
//
// There is no live worker/supplier-adapter yet, so this cannot walk a real
// upstream end-to-end today. What it CAN do honestly, right now:
//
//   npx tsx tools/run-canary.ts sweep     — create one real generation_job
//     (source: 'canary') per currently-sellable (model, kind, ratio,
//     resolution) combination in supplier_capability.
//
//   npx tsx tools/run-canary.ts evaluate  — look at every still-pending
//     canary_run and classify it as succeeded / failed / stale_no_pickup /
//     stale_stuck based on what actually happened to its generation_job.
//     Exits non-zero if anything failed or went stale, so this can gate
//     CI/alerting.
//
// Once a real worker exists, canary jobs will actually get processed and
// `evaluate` starts reporting genuine successes automatically — no changes
// needed here.

import { closeGenerationSql } from "../src/lib/generation-core/database";
import { runFullCanarySweep, evaluatePendingCanaryRuns } from "../src/lib/generation-core/canary-service";

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "sweep") {
    const ids = await runFullCanarySweep();
    console.log(`[canary] created ${ids.length} canary run(s).`);
    if (ids.length === 0) {
      console.log("[canary] no enabled+current supplier_capability rows found — nothing to sweep.");
    }
    return;
  }

  if (mode === "evaluate") {
    const summary = await evaluatePendingCanaryRuns();
    console.log("[canary] evaluation summary:", JSON.stringify(summary));
    const unhealthy = summary.failed + summary.staleNoPickup + summary.staleStuck;
    if (unhealthy > 0) {
      console.error(
        `[canary] ${unhealthy} canary run(s) unhealthy (failed=${summary.failed}, ` +
          `stale_no_pickup=${summary.staleNoPickup}, stale_stuck=${summary.staleStuck}).`,
      );
      process.exitCode = 1;
    }
    return;
  }

  console.error("Usage: npx tsx tools/run-canary.ts <sweep|evaluate>");
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("[canary] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeGenerationSql();
  });
