import { expect, test } from "bun:test"
import { parseCardLine } from "./card"

const ok = JSON.stringify({
  lineId: "single_video",
  workTitle: "样例",
  sourceUrl: "https://example.com/shot",
  timecode: "0:36–0:44",
  shotSec: 8,
  scale: "特写",
  subjectPosition: "屏中",
  headroom: "",
  cameraMove: "固定",
  transition: "硬切",
  transitionAt: "0:44",
  subtitleSize: "",
  subtitlePlace: "",
  subtitleInOut: "",
  paletteHex: [],
  beat: "",
  note: "",
})

test("合法行通过", () => {
  const card = parseCardLine(ok)
  expect(card.lineId).toBe("single_video")
  expect(card.timecode).toBe("0:36–0:44")
  expect(card.scale).toBe("特写")
  expect(card.cameraMove).toBe("固定")
  expect(card.paletteHex).toEqual([])
})

test("缺 timecode 失败", () => {
  const broken = JSON.parse(ok) as Record<string, unknown>
  delete broken.timecode
  expect(() => parseCardLine(JSON.stringify(broken))).toThrow("缺 timecode")
})

test("非法 lineId 失败", () => {
  const broken = JSON.parse(ok) as Record<string, unknown>
  broken.lineId = "not_a_line"
  expect(() => parseCardLine(JSON.stringify(broken))).toThrow("非法 lineId")
})
