// 模板預設補完：視頻模板預設模型 = seedance-2.0，錨點價 = 控面目錄真價（720p 13 / 1080p 16 幣/秒），不再有 minimax-h3 預設。
// 跑法：timeout 60 bun test deploy-staging/gateway/template-video-default.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { WORKFLOW_TEMPLATES } from "./workflow-templates/index.ts"

type Spec = { role: string; kind: string; defaults?: Record<string, unknown> }
const videoCfgs = WORKFLOW_TEMPLATES.flatMap((t) =>
  (t.nodes as Spec[]).filter((n) => n.kind === "config" && n.defaults?.kind === "video").map((n) => ({ tpl: t.id, ...n })),
)

test("所有視頻 config 預設不得是 minimax-h3，錨點價為 13/16", () => {
  assert.ok(videoCfgs.length >= 4)
  for (const c of videoCfgs) {
    assert.notEqual(c.defaults?.model, "minimax-h3", `${c.tpl}/${c.role}`)
    assert.equal(c.defaults?.unit_price_per_second, 13, `${c.tpl}/${c.role} 720p`)
    assert.equal(c.defaults?.unit_price_per_second_1080p, 16, `${c.tpl}/${c.role} 1080p`)
  }
})

test("single_video / novel_film 預設 model=seedance-2.0 且時長 ≥10s", () => {
  for (const id of ["single_video", "novel_film"]) {
    const c = videoCfgs.find((x) => x.tpl === id)!
    assert.equal(c.defaults?.model, "seedance-2.0", id)
    assert.ok(Number(c.defaults?.duration_seconds) >= 10, id)
  }
})

test("錨點價與控面目錄一致（目錄檔存在時，credits/10）", () => {
  const p = new URL("../../src/lib/generation-model-catalog/catalog.ts", import.meta.url)
  if (!existsSync(p)) return
  const src = readFileSync(p, "utf8")
  const m = src.match(/\[SEEDANCE_20_MODEL_ID\]: \{[\s\S]*?videoCreditsPerSecond: \{ "480p": (\d+), "720p": (\d+), "1080p": (\d+) \}/)
  assert.ok(m)
  assert.equal(Number(m![2]) / 10, 13)
  assert.equal(Number(m![3]) / 10, 16)
})
