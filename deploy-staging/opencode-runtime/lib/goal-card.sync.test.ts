// 运行时侧的 goal-card.ts 是 gateway/project/goal-card.ts 的逐字副本（只多一段说明头）。
// 为什么要有这条测试：插件不能跨树 import（运行时只部署 .opencode/**），所以只能副本；
// 副本一旦和唯一实现分叉，目标卡折叠行为会在生产与网关不一致且没人发现。
import { readFileSync } from "node:fs"
import path from "node:path"
import { test, expect } from "bun:test"

const here = path.dirname(new URL(import.meta.url).pathname)
const runtimeCopy = path.join(here, "goal-card.ts")
const single = path.join(here, "..", "..", "gateway", "project", "goal-card.ts")

function body(file: string): string {
  const text = readFileSync(file, "utf8")
  // 去掉副本顶部那段说明头（以空行结束）；正文必须与唯一实现逐字相同。
  const cut = text.indexOf("\n\n")
  const stripped = text.startsWith("// 本档是 gateway/project/goal-card.ts") && cut > 0 ? text.slice(cut + 2) : text
  return stripped.replace(/\r\n/g, "\n").trimEnd()
}

test("运行时 goal-card 副本与 gateway 唯一实现逐字一致", () => {
  expect(body(runtimeCopy)).toBe(body(single))
})
