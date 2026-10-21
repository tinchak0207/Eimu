import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export function responseSpoolDirectory(): string {
  return process.env.GENERATION_RESPONSE_SPOOL_DIR ?? '/app/generation-response-spool';
}
export async function clearProviderOutputCheckpoint(attemptId: string): Promise<void> {
  await unlink(path.join(responseSpoolDirectory(), `${attemptId}.json`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.warn('[response-recovery] completed checkpoint cleanup deferred', attemptId);
  });
}
export async function writeProviderReceiptSpool(jobId:string,attemptId:string,response:string):Promise<void> {
  const directory = responseSpoolDirectory();
  await mkdir(directory, { recursive: true, mode: 0o770 });
  // UUID文件名、AES-GCM内容；fsync后才确认收到，卷必须由生产挂载持久保存。
  const finalPath = path.join(directory, `${attemptId}.json`);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx', 0o660);
  try { await file.writeFile(JSON.stringify({ jobId: jobId, attemptId: attemptId, ciphertext: response })); await file.sync(); }
  finally { await file.close(); }
  await rename(temporaryPath, finalPath);
  const directoryFile = await open(directory, 'r');
  try { await directoryFile.sync(); } finally { await directoryFile.close(); }

}
