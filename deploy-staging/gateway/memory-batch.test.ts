/**
 * memory-batch.test.ts — P1-1：G8 双模型一致闸矩阵＋PRD §5.6 抽检判据＋badcase 落盘＋dryRun。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/memory-batch.test.ts
 *
 * 全 fake deps（纯记忆体 harness＋每案独立 tmp 目录），不打真实 LLM／网路。
 * 抽检随机性：n≤3 时全抽（判据本身保证），需精确样本集的边界案用 t.mock 固定
 * Math.random 为 0.999（Fisher–Yates 退化为恒等洗牌 → 样本＝前列）。
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  MEMORY_SIGNATURE_HEADER,
  ORACLE_PROMPT_V1,
  VERIFIER_PROMPT_V1,
  createMemoryBatch,
  signMemoryBytes,
  type MemoryBatchEnv,
  type MemoryBatchReport,
} from "./memory-batch.ts"

const SECRET = "batch-test-secret-not-real"
const BATCH_ID = "2026-09-15"
const NOW_MS = Date.parse(`${BATCH_ID}T12:00:00Z`)
const OWNER = "a".repeat(24)

const PASS_ALL = '{"transferable":true,"evidenced":true,"clean":true,"reason":"ok"}'

function sharedCand(i: number): Record<string, unknown> {
  return {
    scope: "shared",
    domain: "日本动漫",
    slug: `note-${i}`,
    description: `shared knowledge note number ${i} distinct${i}`,
    type: "domain",
    body: "先铺冷色主光，再以暖色补色打阴影，形成层次对比。",
    links: [],
    evidence: "tool result: 第三次生成后用户确认补色光影有效",
    evidence_kind: "tool_result",
    self_score: 4,
  }
}

function privateCand(): Record<string, unknown> {
  return {
    scope: "private",
    domain: "账户偏好",
    slug: "pref-1",
    description: "user prefers warm tone color grading",
    type: "user",
    body: "交付前默认先给暖色调版本。",
    links: [],
    evidence: "user said: 暖色调更符合我店铺调性",
    evidence_kind: "user_confirmed",
    self_score: 3,
  }
}

function curatorText(candidates: unknown[]): string {
  return JSON.stringify({ session_id: "ses_1", candidates, rejected: [] })
}

function slugOf(prompt: string): string {
  const m = prompt.match(/"slug":"([^"]+)"/)
  return m ? m[1] : ""
}

interface HarnessOver {
  env?: Partial<MemoryBatchEnv>
  candidates?: unknown[]
  verifierText?: string | ((prompt: string) => string)
  oracleText?: string | ((prompt: string) => string)
  verifierThrows?: boolean
}

interface Harness {
  batch: ReturnType<typeof createMemoryBatch>
  report: MemoryBatchReport
  calls: { curator: number; verifier: number; oracle: number }
  prompts: { verifier: string[]; oracle: string[] }
  posts: Array<{ path: string; rawBody: string; headers: Record<string, string> }>
  stateDir: string
}

async function withHarness<T>(over: HarnessOver, fn: (h: Harness) => Promise<T>): Promise<T> {
  const stateDir = mkdtempSync(join(tmpdir(), "memory-batch-test-"))
  const calls = { curator: 0, verifier: 0, oracle: 0 }
  const prompts = { verifier: [] as string[], oracle: [] as string[] }
  const posts: Harness["posts"] = []
  const candidates = over.candidates ?? [sharedCand(1)]
  const env: MemoryBatchEnv = {
    MEMORY_INGEST_SECRET: SECRET,
    MEMORY_BATCH_ENABLED: "true",
    MEMORY_STATE_DIR: stateDir,
    MEMORY_VERIFIER_MODEL: "relay/verifier-x",
    MEMORY_ORACLE_MODEL: "relay/oracle-x",
    ...over.env,
  }
  const batch = createMemoryBatch({
    listSessions: async () => [
      {
        id: "ses_1",
        parentId: null,
        updatedAt: NOW_MS,
        ownerKey: OWNER,
        userMessages: 5,
        successfulToolCalls: 2,
        knowledgeToolCalls: 3,
      },
    ],
    transcriptOf: async () => "user: 做一个动漫夜景\nassistant: 已生成并确认冷暖补色。",
    callLlm: async () => {
      calls.curator += 1
      return curatorText(candidates)
    },
    callVerifierLlm: async (prompt) => {
      calls.verifier += 1
      prompts.verifier.push(prompt)
      if (over.verifierThrows) throw new Error("verifier unreachable")
      return typeof over.verifierText === "function" ? over.verifierText(prompt) : over.verifierText ?? PASS_ALL
    },
    callOracleLlm: async (prompt) => {
      calls.oracle += 1
      prompts.oracle.push(prompt)
      return typeof over.oracleText === "function" ? over.oracleText(prompt) : over.oracleText ?? '{"score":2,"reason":"fine"}'
    },
    postIngest: async (path, rawBody, headers) => {
      posts.push({ path, rawBody, headers })
      if (path === "/api/agent/memory/ingest") {
        const body = JSON.parse(rawBody) as { batch_id: string; docs: Array<{ slug: string }> }
        return {
          status: 200,
          json: {
            accepted: body.docs.map((d) => `${body.batch_id}-${d.slug}`),
            rejected: [],
            stats: {},
          },
        }
      }
      return { status: 200, json: { reviewed: [], action: "pending_review" } }
    },
    env,
    now: () => new Date(NOW_MS),
  })
  const report = await batch.runBatch({})
  return fn({ batch, report, calls, prompts, posts, stateDir })
    .finally(() => rmSync(stateDir, { recursive: true, force: true }))
}

describe("G8 双模型一致闸（仅 shared、postIngest 前逐条）", () => {
  it("三布尔全 true → 入库；prompt＝VERIFIER_PROMPT_V1＋候选 JSON", async () => {
    await withHarness({}, async (h) => {
      assert.equal(h.calls.verifier, 1)
      assert.ok(h.prompts.verifier[0].startsWith(VERIFIER_PROMPT_V1))
      assert.match(h.prompts.verifier[0], /"slug":"note-1"/)
      assert.equal(h.report.passed, 1)
      assert.equal(h.report.stored, 1)
      assert.equal(h.report.g8_skipped, 0)
      assert.equal(h.report.rejected.g8_rejected, undefined)
      const ingest = h.posts.find((p) => p.path === "/api/agent/memory/ingest")
      assert.ok(ingest && JSON.parse(ingest.rawBody).docs.length === 1)
    })
  })

  it("任一布尔 false → 丢弃计 g8_rejected，不入 ingest", async () => {
    await withHarness(
      { verifierText: '{"transferable":true,"evidenced":false,"clean":true,"reason":"无外部证据"}' },
      async (h) => {
        assert.equal(h.report.passed, 0)
        assert.equal(h.report.rejected.g8_rejected, 1)
        assert.equal(h.posts.filter((p) => p.path === "/api/agent/memory/ingest").length, 0)
      },
    )
  })

  it("非 JSON 回应 → 丢弃（围栏可救回：```json 全 true → 入库）", async () => {
    await withHarness({ verifierText: "I think this looks fine to me." }, async (h) => {
      assert.equal(h.report.rejected.g8_rejected, 1)
    })
    await withHarness(
      { verifierText: "```json\n" + PASS_ALL + "\n```" },
      async (h) => {
        assert.equal(h.report.passed, 1)
      },
    )
  })

  it("MEMORY_VERIFIER_MODEL 未配置 → 跳过并记 g8_skipped（不放过：留痕；不误杀：入库）", async () => {
    await withHarness({ env: { MEMORY_VERIFIER_MODEL: "", MEMORY_ORACLE_MODEL: "" } }, async (h) => {
      assert.equal(h.calls.verifier, 0)
      assert.equal(h.report.g8_skipped, 1)
      assert.equal(h.report.passed, 1)
      assert.equal(h.report.stored, 1)
    })
  })

  it("verifier 呼叫失败 → skip 记 g8_skipped（基础设施失败不判候选有罪）", async () => {
    await withHarness({ verifierThrows: true, env: { MEMORY_ORACLE_MODEL: "" } }, async (h) => {
      assert.equal(h.report.g8_skipped, 1)
      assert.equal(h.report.passed, 1)
    })
  })
})

describe("PRD §5.6 入库后抽检（30%、最少 3、不足全抽）", () => {
  it("平均 1.33（<1.5）→ POST /api/agent/memory/review {batch_id,action:pending_review}＋签名", async () => {
    const scores: Record<string, number> = { "note-1": 1, "note-2": 1, "note-3": 2 }
    await withHarness(
      {
        candidates: [sharedCand(1), sharedCand(2), sharedCand(3)],
        oracleText: (prompt) => `{"score":${scores[slugOf(prompt)]},"reason":"audit"}`,
      },
      async (h) => {
        assert.equal(h.calls.oracle, 3) // n=3 → 全抽
        assert.deepEqual(h.report.sampling, {
          sampled: 3,
          avg: 1.3333,
          triggered: true,
          errors: 0,
          skipped: 0,
          private_badged: 0,
        })
        const review = h.posts.find((p) => p.path === "/api/agent/memory/review")
        assert.ok(review, "必须送翻转请求")
        assert.deepEqual(JSON.parse(review.rawBody), { batch_id: BATCH_ID, action: "pending_review" })
        assert.equal(
          review.headers[MEMORY_SIGNATURE_HEADER],
          signMemoryBytes(review.rawBody, SECRET),
        )
        // 抽检样本逐条落 badcase 集。
        const files = readdirSync(join(h.stateDir, "memory-badcases"))
        assert.equal(files.length, 3)
        const one = JSON.parse(readFileSync(join(h.stateDir, "memory-badcases", files[0]), "utf8"))
        assert.equal(one.batch_id, BATCH_ID)
        assert.equal(one.oracle_reason, "audit")
        assert.ok(h.prompts.oracle[0].startsWith(ORACLE_PROMPT_V1))
      },
    )
  })

  it("平均恰好 1.5 → 不触发（严格小于判据）", async () => {
    const scores: Record<string, number> = { "note-1": 1, "note-2": 2 }
    await withHarness(
      {
        candidates: [sharedCand(1), sharedCand(2)],
        oracleText: (prompt) => `{"score":${scores[slugOf(prompt)] ?? 2},"reason":"ok"}`,
      },
      async (h) => {
        assert.equal(h.report.sampling.avg, 1.5)
        assert.equal(h.report.sampling.triggered, false)
        assert.equal(h.posts.filter((p) => p.path === "/api/agent/memory/review").length, 0)
      },
    )
  })

  it("任一 0 分（平均停 1.5）→ 仍触发翻转", async (t) => {
    // 11 条 → 抽 ceil(0.3*11)=4；mock random=0.999 使 Fisher–Yates 恒等 → 样本＝前 4 条。
    t.mock.method(Math, "random", () => 0.999)
    const cands = Array.from({ length: 11 }, (_, i) => sharedCand(i + 1))
    await withHarness(
      {
        candidates: cands,
        oracleText: (prompt) =>
          `{"score":${slugOf(prompt) === "note-1" ? 0 : 2},"reason":"trace-check"}`,
      },
      async (h) => {
        assert.equal(h.report.sampling.sampled, 4)
        assert.equal(h.report.sampling.avg, 1.5) // 平均不触发
        assert.equal(h.report.sampling.triggered, true) // 任一 0 分 → 触发
        assert.equal(
          h.posts.some((p) => p.path === "/api/agent/memory/review"),
          true,
        )
      },
    )
  })

  it("oracle 未配置 → 跳过抽检，sampling.skipped 诚实记数", async () => {
    await withHarness(
      {
        candidates: [sharedCand(1), sharedCand(2), sharedCand(3)],
        env: { MEMORY_ORACLE_MODEL: "" },
      },
      async (h) => {
        assert.equal(h.calls.oracle, 0)
        assert.equal(h.report.sampling.sampled, 0)
        assert.equal(h.report.sampling.triggered, false)
        assert.equal(h.report.sampling.skipped, 3)
      },
    )
  })

  it("畸形 oracle 输出 → fail-closed 记 0 分并触发翻转", async () => {
    await withHarness(
      { candidates: [sharedCand(1), sharedCand(2), sharedCand(3)], oracleText: "solid work, 2/10" },
      async (h) => {
        assert.equal(h.report.sampling.avg, 0)
        assert.equal(h.report.sampling.triggered, true)
      },
    )
  })

  it("private：同机制判分、只记 badge 不翻转", async () => {
    await withHarness(
      {
        candidates: [
          sharedCand(1),
          privateCand(),
        ],
        oracleText: (prompt) => `{"score":${slugOf(prompt) === "pref-1" ? 1 : 2},"reason":"ok"}`,
      },
      async (h) => {
        assert.equal(h.calls.oracle, 2)
        assert.equal(h.report.sampling.private_badged, 1)
        assert.equal(h.report.sampling.triggered, false)
        assert.equal(h.posts.filter((p) => p.path === "/api/agent/memory/review").length, 0)
      },
    )
  })
})

describe("dryRun 与总开关", () => {
  it("dryRun：curator 照跑（预览主体），闸 LLM／oracle／ingest 零呼叫", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "memory-batch-dry-"))
    try {
      const calls = { curator: 0, verifier: 0, oracle: 0 }
      const batch = createMemoryBatch({
        listSessions: async () => [
          { id: "ses_1", updatedAt: NOW_MS, ownerKey: OWNER, userMessages: 5 },
        ],
        transcriptOf: async () => "hello",
        callLlm: async () => {
          calls.curator += 1
          return curatorText([sharedCand(1)])
        },
        callVerifierLlm: async () => {
          calls.verifier += 1
          return PASS_ALL
        },
        callOracleLlm: async () => {
          calls.oracle += 1
          return '{"score":2}'
        },
        postIngest: async () => {
          throw new Error("dryRun 不得送出")
        },
        env: {
          MEMORY_BATCH_ENABLED: "false",
          MEMORY_STATE_DIR: stateDir,
          MEMORY_VERIFIER_MODEL: "relay/v",
          MEMORY_ORACLE_MODEL: "relay/o",
        },
        now: () => new Date(NOW_MS),
      })
      const report = await batch.runBatch({ dryRun: true })
      assert.equal(report.dry_run, true)
      assert.equal(calls.curator, 1)
      assert.equal(calls.verifier, 0) // dryRun 零闸 LLM
      assert.equal(calls.oracle, 0)
      assert.equal(report.stored, 0)
      assert.equal(report.sampling.sampled, 0)
      assert.equal(report.g8_skipped, 0) // dryRun 不启动 G8 属预览语义，不计「未配置」旗标
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("非 dryRun 且总开关 false → 拒绝（诚实报错，不假跑）", async () => {
    const batch = createMemoryBatch({
      listSessions: async () => [],
      transcriptOf: async () => "",
      callLlm: async () => "",
      callVerifierLlm: async () => "",
      callOracleLlm: async () => "",
      postIngest: async () => ({ status: 200, json: {} }),
      env: { MEMORY_BATCH_ENABLED: "false" },
      now: () => new Date(NOW_MS),
    })
    await assert.rejects(() => batch.runBatch({}), /MEMORY_BATCH_ENABLED=false/)
  })
})
