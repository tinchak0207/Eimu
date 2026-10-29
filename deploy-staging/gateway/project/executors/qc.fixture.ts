// 测试夹具。生产模块不再签发通过。canonical 必须与 qc.ts 的 verdictCanonical 逐字段一致。
import { createHash, createHmac } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Output } from "../types.ts"
import { CRITIC_VERDICT_TEST_KEY, criticSeat, type SignedCriticVerdict } from "./qc.ts"

function assertTestProcess(): void {
  // bun test 在模块加载前把 NODE_ENV 设为 test（未预先指定时）。没有 BUN_TEST 这类变量。
  if (process.env.NODE_ENV !== "test") {
    throw new Error("qc.fixture.ts 只许 bun test 进程使用：NODE_ENV 不是 test")
  }
}

assertTestProcess()

function verdictCanonical(body: Omit<SignedCriticVerdict, "sig">): string {
  return JSON.stringify({
    schema: body.schema,
    mode: body.mode,
    rubric: body.rubric,
    score: body.score,
    pass: body.pass,
    items: body.items,
    deficiencies: body.deficiencies,
    evidence: body.evidence,
    actor: body.actor,
    parentSessionId: body.parentSessionId,
    artifactSha256: body.artifactSha256,
    ...(body.goalRevision ? { goalRevision: body.goalRevision } : {}),
    ...(body.briefLedgerRevision ? { briefLedgerRevision: body.briefLedgerRevision } : {}),
    receiptCallIds: body.receiptCallIds,
  })
}

function signWithTestKey(body: Omit<SignedCriticVerdict, "sig">): SignedCriticVerdict {
  assertTestProcess()
  const sig = createHmac("sha256", CRITIC_VERDICT_TEST_KEY).update(verdictCanonical(body)).digest("hex")
  return { ...body, sig }
}

function writeVerdict(dir: string, full: SignedCriticVerdict): Output {
  assertTestProcess()
  const text = JSON.stringify(full)
  const sha = createHash("sha256").update(text).digest("hex")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `verdict-${sha.slice(0, 12)}.json`)
  writeFileSync(file, text)
  return {
    port: "out",
    artifactId: `art_${sha.slice(0, 16)}`,
    sha256: sha,
    path: file,
    mime: "application/json",
    bytes: Buffer.byteLength(text),
    origin: "derived",
  }
}

/** 旧夹具：critic:fixture / call_fixture / image_default / 90。验签必须拒，即使 HMAC 用测试钥匙对得上。 */
export function signedCriticVerdictOutput(dir: string, opts: { parentSessionId: string; artifactSha256: string; qcNodeId?: string }): Output {
  assertTestProcess()
  const body: Omit<SignedCriticVerdict, "sig"> = {
    schema: 1,
    mode: "critic",
    rubric: "image_default",
    score: 90,
    pass: true,
    items: [{ id: "subject", pass: true, evidence: opts.artifactSha256 }],
    deficiencies: [],
    evidence: [opts.artifactSha256],
    actor: { kind: "subagent", seat: criticSeat(), runId: "critic:fixture", lane: [opts.qcNodeId ?? "qc"], sessionId: `critic-child:${opts.parentSessionId}` },
    parentSessionId: opts.parentSessionId,
    artifactSha256: opts.artifactSha256,
    receiptCallIds: ["call_fixture"],
  }
  return writeVerdict(dir, signWithTestKey(body))
}

/** 测试里签发一条非夹具 verdict。runId / 回执不得带 fixture，rubric 必须与该测试的媒体一致。 */
export function signedTestCriticVerdictOutput(
  dir: string,
  opts: {
    parentSessionId: string
    artifactSha256: string
    rubric: "image_default" | "film_frame_critic" | "film_final_critic"
    goalRevision?: string
    briefLedgerRevision?: string
    qcNodeId?: string
    runId?: string
    receiptCallIds?: string[]
    score?: number
  },
): Output {
  assertTestProcess()
  const body: Omit<SignedCriticVerdict, "sig"> = {
    schema: 1,
    mode: "critic",
    rubric: opts.rubric,
    score: opts.score ?? 90,
    pass: true,
    items: [{ id: opts.rubric === "film_frame_critic" ? "shot_consistency" : "subject", pass: true, evidence: opts.artifactSha256 }],
    deficiencies: [],
    evidence: [opts.artifactSha256],
    actor: {
      kind: "subagent",
      seat: criticSeat(),
      runId: opts.runId ?? "critic:run",
      lane: [opts.qcNodeId ?? "qc"],
      sessionId: `critic-child:${opts.parentSessionId}`,
    },
    parentSessionId: opts.parentSessionId,
    artifactSha256: opts.artifactSha256,
    ...(opts.goalRevision ? { goalRevision: opts.goalRevision } : {}),
    ...(opts.briefLedgerRevision ? { briefLedgerRevision: opts.briefLedgerRevision } : {}),
    receiptCallIds: opts.receiptCallIds ?? ["call_review"],
  }
  return writeVerdict(dir, signWithTestKey(body))
}
