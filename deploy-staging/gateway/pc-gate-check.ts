/**
 * 片 C 純函數驗收（臨時檔，跑完即刪）。
 * 驗的是**已落位的生產模組** /opt/agent-harness/gateway/delivery-gate.ts
 * （不重寫一份邏輯來驗自己 = 假驗收）。
 */
import { checkDelivery, DELIVERY_CONTRACTS, formatDeliveryGateNotice, DELIVERY_GATE_MARK } from "./delivery-gate"

let failed = 0
function assert(name: string, cond: boolean, got: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)}`)
  if (!cond) failed++
}

console.log(`--- 契约表载入：${Object.keys(DELIVERY_CONTRACTS).length} 個 Expert ---`)
console.log(`    music contract = ${JSON.stringify(DELIVERY_CONTRACTS["music"])}`)

// 組 1：契約 miss（music 交付缺 audio_url）→ ok:false, missing:["audio_url"]
const missText = [
  "emotion_contract: style=Suno, BPM=92, key=A minor",
  "lyrics: 第一段 …",
  "duration_source: 模型回報 128s",
  "qc: 已自檢",
].join("\n")
const r1 = checkDelivery("music", missText, DELIVERY_CONTRACTS)
assert(
  "組1 music 缺 audio_url → ok:false missing=[audio_url]",
  r1.ok === false && JSON.stringify(r1.missing) === JSON.stringify(["audio_url"]),
  r1,
)
console.log(`     reason=${r1.reason}`)
console.log(`     notice=${formatDeliveryGateNotice("music", r1, DELIVERY_CONTRACTS)}`)

// 組 2：契約齊 → ok:true
const fullText = missText + "\naudio_url: https://cdn.example.com/demo.mp3"
const r2 = checkDelivery("music", fullText, DELIVERY_CONTRACTS)
assert("組2 契約齊 → ok:true", r2.ok === true && r2.missing.length === 0, r2)

// 組 3：agent 未註冊 / undefined → ok:true（零回歸）
const r3a = checkDelivery(undefined, "随便一段話", DELIVERY_CONTRACTS)
const r3b = checkDelivery("no-such-expert", "随便一段話", DELIVERY_CONTRACTS)
assert("組3a agent=undefined → ok:true", r3a.ok === true, r3a)
assert("組3b agent 未註冊 → ok:true", r3b.ok === true, r3b)

// 補充：大小寫正規化命中（大寫欄位名也算）
const r4 = checkDelivery("music", "EMOTION_CONTRACT ...\nLYRICS\nAUDIO_URL\nDURATION_SOURCE\nQC", DELIVERY_CONTRACTS)
assert("組4 大写欄位名 → ok:true（大小寫正規化生效）", r4.ok === true, r4)

// 補充：qcSignatureRequired 獨立條款（契約有 qc 時重合，此處驗 multi-miss 排序保序）
const r5 = checkDelivery("web3d-director", "只寫了 scene_spec", DELIVERY_CONTRACTS)
assert(
  "組5 web3d 缺 bundle_ref+qc → missing=[bundle_ref,qc]（契约序）",
  r5.ok === false && JSON.stringify(r5.missing) === JSON.stringify(["bundle_ref", "qc"]),
  r5,
)

// 補充：marker 常數確實在人話前綴裡（前端/Orchestrator 靠它辨識）
assert("組6 標記常數在位", formatDeliveryGateNotice("music", r1, DELIVERY_CONTRACTS).startsWith(DELIVERY_GATE_MARK), DELIVERY_GATE_MARK)

console.log(`\nRESULT: ${failed === 0 ? "ALL_PASS" : failed + "_FAILED"}`)
process.exit(failed === 0 ? 0 : 1)
