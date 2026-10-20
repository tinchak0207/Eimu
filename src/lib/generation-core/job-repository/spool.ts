import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { decryptGenerationPrompt, encryptGenerationPrompt } from "../crypto";
import { getGenerationSql, type GenerationSql } from "../database";
import type { ProviderProtocol, SupplierGenerationOutput } from "../types";
import { getGenerationJob, listCompletedGenerationArtifacts } from "./query";
import { responseSpoolDirectory, writeProviderReceiptSpool } from "./spool-io";
import { jobHasUnresolvedProviderTask, markProviderTaskSubmitted, reviveGenerationJobWithArtifacts } from "./write";

/** 供应商已返回成品：先保存响应，再做下载/验证；这些恢复绝不再次提交生成。 */
export async function checkpointProviderOutput(input: {
  jobId: string; attemptId: string; output: SupplierGenerationOutput;
}, sql: GenerationSql = getGenerationSql()): Promise<void> {
  const unparsed=input.output.evidence?.source==='unparsed-provider-response';
  const response = encryptGenerationPrompt(JSON.stringify({...input.output,receipt_kind:unparsed?'unparsed_response':'output'}));
  await writeProviderReceiptSpool(input.jobId,input.attemptId,response);
  const rows = await sql<{ id: string }[]>`
    UPDATE generation_attempt SET response_ciphertext = ${response}, provider_state = ${unparsed?'unknown':'succeeded'},
      provider_request_id = COALESCE(${input.output.providerRequestId ?? null}, provider_request_id),
      provider_task_id = COALESCE(${input.output.providerTaskId ?? null}, provider_task_id),
      provider_http_status = ${input.output.httpStatus},
      evidence_json = ${sql.json(JSON.parse(JSON.stringify(input.output.evidence ?? {})) as never)}, recovery_status = ${unparsed?'manual':'pending'},
      provider_next_poll_at = CASE WHEN ${unparsed} THEN NULL ELSE now()+interval '2 minutes' END,
      provider_reconcile_deadline_at = COALESCE(provider_reconcile_deadline_at, now() + interval '24 hours'),
      recovery_owner = ${unparsed?'control-plane:manual-reconciliation':'control-plane:provider-reconciliation'},
      recovery_detail = CASE WHEN ${unparsed} THEN 'Successful HTTP response has no recognized media pointer; original encrypted response retained, never resubmit.' ELSE recovery_detail END, updated_at = now()
    WHERE id = ${input.attemptId} AND job_id = ${input.jobId} RETURNING id
  `;
  if (!rows[0]) throw new Error('Provider response has no durable attempt owner.');
}
/** 重启或DB写入失败后只重放保存成品，不重新生成；成功后回收加密日志。 */
export async function restoreProviderResponsesFromSpool(sql: GenerationSql = getGenerationSql()): Promise<void> {
  const directory = responseSpoolDirectory();
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const name of names.filter((value) => /^[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(value)).slice(0, 100)) {
    let invalidReceipt=false;
    try {
    const filename = path.join(directory, name);
    if (name.endsWith('.tmp') && Date.now()-(await stat(filename)).mtimeMs<120_000) continue;
    const content=await readFile(filename,'utf8');
    invalidReceipt=true;
    const record = JSON.parse(content) as { jobId: string; attemptId: string; ciphertext: string };
    if (record.attemptId!==name.slice(0,36) || !/^[a-f0-9-]{36}$/.test(record.jobId)) throw new Error('Invalid checkpoint owner');
    invalidReceipt=false;
    const rows = await sql<{ status: string; recovery_status:string; live: boolean }[]>`SELECT attempt.status,attempt.recovery_status, (job.lease_expires_at>now() AND job.status IN ('submitting','running','leased')) AS live FROM generation_attempt attempt JOIN generation_job job ON job.id=attempt.job_id WHERE attempt.id=${record.attemptId} AND attempt.job_id=${record.jobId}`;
    if (rows[0]?.status === 'succeeded' || (rows[0]?.status==='failed' && rows[0]?.recovery_status==='resolved')) { await unlink(filename); continue; }
    if (!rows[0] || rows[0].live) continue;
    invalidReceipt=true;
    const receipt=JSON.parse(decryptGenerationPrompt(record.ciphertext)) as SupplierGenerationOutput & {receipt_kind?:string;protocol?:string};
    if(receipt.receipt_kind==='provider_task') {
      if(!receipt.providerTaskId || !receipt.protocol) throw new Error('Incomplete original provider task receipt');
      invalidReceipt=false;
      const assigned=await markProviderTaskSubmitted({jobId:record.jobId,attemptId:record.attemptId,
        providerTaskId:receipt.providerTaskId,protocol:receipt.protocol,firstPollDelayMs:1},sql);
      if(!assigned) {invalidReceipt=true;throw new Error('Original task receipt cannot overwrite a different provider owner');}
      await sql`UPDATE generation_attempt SET recovery_status='pending',recovery_owner='control-plane:provider-reconciliation',updated_at=now() WHERE id=${record.attemptId}`;
    } else if(receipt.receipt_kind==='unparsed_response') {
      invalidReceipt=false;
      await checkpointProviderOutput({jobId:record.jobId,attemptId:record.attemptId,output:receipt},sql);
      await rename(filename,`${filename}.manual`);
    } else {
      invalidReceipt=false;
      if(!receipt.url && !receipt.base64) {invalidReceipt=true;throw new Error('Original response has no media pointer');}
      await checkpointProviderOutput({jobId:record.jobId,attemptId:record.attemptId,output:receipt},sql);
    }
    await sql`UPDATE generation_attempt SET status='submit_unknown', provider_next_poll_at=CASE WHEN ${receipt.receipt_kind==='provider_task'} THEN provider_next_poll_at ELSE now() END
      WHERE id=${record.attemptId} AND status NOT IN ('succeeded')`;
    if (name.endsWith('.tmp') || receipt.receipt_kind==='provider_task') await unlink(filename);
    } catch {
      // 瞬态DB/IO失败保留原扩展名，下一维护轮继续；只有确定无效证据才进入人工。
      if (!invalidReceipt) continue;
      // 保留坏文件供人工恢复，单个文件不得堵住整批维护与所有已受理订单。
      await sql`UPDATE generation_attempt SET recovery_status='manual', recovery_owner='control-plane:manual-reconciliation',
        recovery_detail='Encrypted response journal cannot be restored; original journal retained for operator.',
        updated_at=now() WHERE id=${name.slice(0,36)}`.catch(() => undefined);
      await rename(path.join(directory,name),path.join(directory,`${name}.manual`)).catch(()=>undefined);
    }
  }
}
/** 产物已落、job收口前进程退出：canonical事实优先，不依赖待轮询attempt。 */
export async function recoverJobsFromCanonicalArtifacts(sql: GenerationSql = getGenerationSql()): Promise<void> {
  const jobs = await sql<{ id: string; requested_count: number }[]>`
    SELECT job.id,job.requested_count FROM generation_job job
    WHERE (job.status='submit_unknown' OR (job.cancel_requested_at IS NOT NULL AND job.status IN ('running','submitting')))
      AND EXISTS(SELECT 1 FROM artifact a WHERE a.job_id=job.id AND a.role='output')
    ORDER BY job.updated_at LIMIT 100
  `;
  for (const job of jobs) {
    const current = await getGenerationJob(job.id,sql);
    if (current?.cancelRequestedAt) { await settleRequestedGenerationCancellation(job.id,sql); continue; }
    const artifacts = await listCompletedGenerationArtifacts(job.id, sql);
    if (artifacts.length >= Number(job.requested_count)) {
      await reviveGenerationJobWithArtifacts({jobId:job.id,workerId:'recovery:canonical-artifacts',artifacts},sql);
    } else {
      await sql`UPDATE generation_job SET status='queued',completed_count=${artifacts.length},
        available_at=now(),failure_class=NULL,failure_detail=NULL,updated_at=now()
        WHERE id=${job.id} AND status='submit_unknown' AND NOT EXISTS(
          SELECT 1 FROM generation_attempt a WHERE a.job_id=${job.id}
          AND a.status IN ('submitting','running','submit_unknown') AND a.recovery_status<>'resolved'
        )`;
    }
  }
}
/** 已在飞的取消请求：先保留全部已知产物，再终结未执行部分；账务由既有维护幂等结算。 */
export async function settleRequestedGenerationCancellation(jobId: string, sql: GenerationSql=getGenerationSql()): Promise<boolean> {
  if (await jobHasUnresolvedProviderTask(jobId,sql)) return false;
  const artifacts=await listCompletedGenerationArtifacts(jobId,sql);
  const result={created:Math.floor(Date.now()/1000),artifacts,endpointLabel:artifacts.at(-1)?.endpointLabel};
  const rows=await sql<{id:string}[]>`UPDATE generation_job SET status='cancelled',completed_count=${artifacts.length},
    primary_artifact_id=${artifacts[0]?.id ?? null},result_json=${sql.json(result as never)},
    failure_class='cancelled',failure_detail='Cancellation settled after preserving all known submitted output.',
    finished_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE id=${jobId} AND cancel_requested_at IS NOT NULL AND status IN ('running','submitting','submit_unknown','leased','queued')
    AND NOT EXISTS(SELECT 1 FROM generation_attempt a WHERE a.job_id=${jobId} AND a.status IN ('submitting','running','submit_unknown') AND a.recovery_status<>'resolved') RETURNING id`;
  return !!rows[0];
}
/** 异步受理回执先fsync再落DB；DB故障或退出也不能丢掉原上游task关联。 */
export async function checkpointProviderTaskReceipt(input:{jobId:string;attemptId:string;providerTaskId:string;protocol:ProviderProtocol}):Promise<void> {
  const ciphertext=encryptGenerationPrompt(JSON.stringify({receipt_kind:'provider_task',...input}));
  await writeProviderReceiptSpool(input.jobId,input.attemptId,ciphertext);
}
