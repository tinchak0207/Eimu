// H11 測試：delivery_assets 零參數自足（不依賴前置 canvas_get_state）。bun test。
import { test, expect } from "bun:test"

// 沙盒：複製工具到臨時目錄並備好 ../lib 與 plugin 樁（VPS 的 lib 不在鏡像內）。
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
;(globalThis as any).__snap = { has_state: false, state: null }
const root = mkdtempSync(join(tmpdir(), "da-"))
mkdirSync(join(root, "tools")); mkdirSync(join(root, "lib"))
mkdirSync(join(root, "node_modules/@opencode-ai/plugin"), { recursive: true })
writeFileSync(join(root, "node_modules/@opencode-ai/plugin/package.json"), '{"name":"@opencode-ai/plugin","exports":{"./tool":"./tool.js"}}')
writeFileSync(join(root, "node_modules/@opencode-ai/plugin/tool.js"), "const t=(d)=>d;const c=()=>({optional:()=>c(),describe:()=>c()});t.schema={string:c};export const tool=t")
writeFileSync(join(root, "lib/client.ts"), 'export const ok=(d:any)=>({output:JSON.stringify({ok:true,...d})});export const fail=(c:string,h:string)=>({output:JSON.stringify({ok:false,error:{code:c,hint:h}})})')
writeFileSync(join(root, "lib/canvas-flow.ts"), "export const gatewayReadSnapshot=async()=>(globalThis as any).__snap")
copyFileSync(join(import.meta.dir, "delivery_assets.ts"), join(root, "tools/delivery_assets.ts"))
const tool: any = (await import(join(root, "tools/delivery_assets.ts"))).default
const setSnap = (v: any) => { (globalThis as any).__snap = v }
const run = async (args: any) => JSON.parse((await tool.execute(args, { sessionID: "s1" })).output)

test("零參數 + 畫布有成品 → 自動交付，不回 empty_delivery", async () => {
  setSnap({ has_state: true, state: { nodes: [{ id: "a", type: "video", metadata: { content: "https://x/a.mp4" } }, { id: "b", type: "video", metadata: {} }] } })
  const r = await run({})
  expect(r.ok).toBe(true)
  expect(r.auto_discovered).toBe(true)
  expect(r.items.length).toBe(1)
  expect(r.missing.length).toBe(1)
})

test("零參數 + 無畫布 → 回退 session-tasks succeeded URL", async () => {
  setSnap({ has_state: false, state: null })
  const orig = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ ok: true, tasks: [{ status: "succeeded", url: "https://x/i.png" }, { status: "running" }] })) as any
  try {
    const r = await run({})
    expect(r.ok).toBe(true)
    expect(r.items[0].formats.original).toBe("https://x/i.png")
  } finally { globalThis.fetch = orig }
})

test("零參數 + 全空 → nothing_to_deliver（非 empty_delivery）", async () => {
  setSnap({ has_state: false, state: null })
  const orig = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ ok: true, tasks: [] })) as any
  try {
    const r = await run({})
    expect(r.error.code).toBe("nothing_to_deliver")
  } finally { globalThis.fetch = orig }
})
