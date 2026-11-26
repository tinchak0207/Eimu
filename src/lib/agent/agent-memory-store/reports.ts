import { AGENT_MEMORY_BLOB_PREFIX } from "./constants";
import { writeBlobText } from "./blob-io";
import { safeSegment } from "./keys";

/** 批次报告落盘（契约 §2 `agent-memory/batches/{batchId}.json`）。 */
export async function saveBatchReport(batchId: string, report: unknown): Promise<void> {
  await writeBlobText(
    `${AGENT_MEMORY_BLOB_PREFIX}/batches/${safeSegment(batchId, "batch")}.json`,
    JSON.stringify(report),
  );
}
