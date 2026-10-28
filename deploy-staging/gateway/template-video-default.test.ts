// 模板预设：视频模板 config 不写死模型与单价（运行时选型），时长 5-15 秒、推荐 15 秒。
// 跑法：timeout 60 bun test deploy-staging/gateway/template-video-default.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { WORKFLOW_TEMPLATES } from "./workflow-templates/index.ts"

type Spec = { role: string; kind: string; defaults?: Record<string, unknown> }
const videoCfgs = WORKFLOW_TEMPLATES.flatMap((t) =>
  (t.nodes as Spec[]).filter((n) => n.kind === "config" && n.defaults?.kind === "video").map((n) => ({ tpl: t.id, ...n })),
)

// 2026-10-12 产品裁定（mem 2026-10-12-agent-video-cognition-minimax-h3；模板侧落地于 f6ab64753）：
// 影片认知从 seedance-2.0 换成 minimax-h3（单镜 5-15 秒、推荐 15 秒）；模板 video config 不再写死模型与单价，
// 模型由网关按交付证据运行时选型（video-model-select.ts），价格走报价而非模板锚点。
test("所有视频 config 预设：不写死模型、不残留 seedance 旧锚点价，时长落在 5-15 秒", () => {
  assert.ok(videoCfgs.length >= 4)
  for (const c of videoCfgs) {
    assert.equal(c.defaults?.model, undefined, `${c.tpl}/${c.role} 不应写死模型（由运行时选型）`)
    assert.equal(c.defaults?.unit_price_per_second, undefined, `${c.tpl}/${c.role} 不应残留 seedance 720p 锚点价`)
    assert.equal(c.defaults?.unit_price_per_second_1080p, undefined, `${c.tpl}/${c.role} 不应残留 seedance 1080p 锚点价`)
    if (c.defaults?.duration_seconds !== undefined) {
      const d = Number(c.defaults.duration_seconds)
      assert.ok(d >= 5 && d <= 15, `${c.tpl}/${c.role} duration_seconds=${d} 超出 minimax-h3 单镜 5-15 秒`)
    }
  }
})

test("single_video / novel_film 预设时长 = 推荐的 15 秒", () => {
  for (const id of ["single_video", "novel_film"]) {
    const c = videoCfgs.find((x) => x.tpl === id)!
    assert.equal(Number(c.defaults?.duration_seconds), 15, id)
  }
})

test("锚点价与控面目录一致（目录档存在时，credits/10）", () => {
  const p = new URL("../../src/lib/generation-model-catalog/catalog.ts", import.meta.url)
  if (!existsSync(p)) return
  const src = readFileSync(p, "utf8")
  const m = src.match(/\[SEEDANCE_20_MODEL_ID\]: \{[\s\S]*?videoCreditsPerSecond: \{ "480p": (\d+), "720p": (\d+), "1080p": (\d+) \}/)
  assert.ok(m)
  assert.equal(Number(m![2]) / 10, 13)
  assert.equal(Number(m![3]) / 10, 16)
})
