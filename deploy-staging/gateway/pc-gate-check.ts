/**
 * 片 C 纯函数验收（临时档，跑完即删）。
 * 验的是**已落位的生产模组** /opt/eimu-harness/gateway/delivery-gate.ts
 * （不重写一份逻辑来验自己 = 假验收）。
 */
import { checkDelivery, DELIVERY_CONTRACTS, formatDeliveryGateNotice, DELIVERY_GATE_MARK } from "./delivery-gate"

let failed = 0
function assert(name: string, cond: boolean, got: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  got=${JSON.stringify(got)}`)
  if (!cond) failed++
}

console.log(`--- 契约表载入：${Object.keys(DELIVERY_CONTRACTS).length} 个 Expert ---`)
console.log(`    music contract = ${JSON.stringify(DELIVERY_CONTRACTS["music"])}`)

// 组 1：契约 miss（music 交付缺 audio_url）→ ok:false, missing:["audio_url"]
const missText = [
  "emotion_contract: style=Suno, BPM=92, key=A minor",
  "lyrics: 第一段 …",
  "duration_source: 模型回报 128s",
  "qc: 已自检",
].join("\n")
const r1 = checkDelivery("music", missText, DELIVERY_CONTRACTS)
assert(
  "组1 music 缺 audio_url → ok:false missing=[audio_url]",
  r1.ok === false && JSON.stringify(r1.missing) === JSON.stringify(["audio_url"]),
  r1,
)
console.log(`     reason=${r1.reason}`)
console.log(`     notice=${formatDeliveryGateNotice("music", r1, DELIVERY_CONTRACTS)}`)

// 组 2：契约齐 → ok:true
const fullText = missText + "\naudio_url: https://cdn.example.com/demo.mp3"
const r2 = checkDelivery("music", fullText, DELIVERY_CONTRACTS)
assert("组2 契约齐 → ok:true", r2.ok === true && r2.missing.length === 0, r2)

// 组 3：agent 未注册 / undefined → ok:true（零回归）
const r3a = checkDelivery(undefined, "随便一段话", DELIVERY_CONTRACTS)
const r3b = checkDelivery("no-such-expert", "随便一段话", DELIVERY_CONTRACTS)
assert("组3a agent=undefined → ok:true", r3a.ok === true, r3a)
assert("组3b agent 未注册 → ok:true", r3b.ok === true, r3b)

// 补充：大小写正规化命中（大写栏位名也算）
const r4 = checkDelivery("music", "EMOTION_CONTRACT ...\nLYRICS\nAUDIO_URL\nDURATION_SOURCE\nQC", DELIVERY_CONTRACTS)
assert("组4 大写栏位名 → ok:true（大小写正规化生效）", r4.ok === true, r4)

// 补充：qcSignatureRequired 独立条款（契约有 qc 时重合，此处验 multi-miss 排序保序）
const r5 = checkDelivery("web3d-director", "只写了 scene_spec", DELIVERY_CONTRACTS)
assert(
  "组5 web3d 缺 bundle_ref+qc → missing=[bundle_ref,qc]（契约序）",
  r5.ok === false && JSON.stringify(r5.missing) === JSON.stringify(["bundle_ref", "qc"]),
  r5,
)

// 补充：marker 常数确实在人话前缀里（前端/Orchestrator 靠它辨识）
assert("组6 标记常数在位", formatDeliveryGateNotice("music", r1, DELIVERY_CONTRACTS).startsWith(DELIVERY_GATE_MARK), DELIVERY_GATE_MARK)

console.log(`\nRESULT: ${failed === 0 ? "ALL_PASS" : failed + "_FAILED"}`)
process.exit(failed === 0 ? 0 : 1)
