// turn-image-parts.test.ts — 真檔案驗收（2026-10-02）：buildTurnImageParts 把
// [ATTACHMENTS_BLOCK] 的圖片列轉成 opencode file part（data: URL）。用 mkdtempSync 造
// 真的 <tmp>/uploads/<sid>/a.png（真 PNG bytes），斷言 url 可解回同一 bytes；並驗安全閘
// （跨會話/穿越被拒）、上限（>4 張截斷、超大檔跳過）、非圖片列忽略、非視覺模型回報。
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildTurnImageParts, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES } from "./turn-image-parts.ts"

// 1x1 透明 PNG（合法最小圖）。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

let root = ""   // <tmp>/uploads
let sid = "ses_test_images"

const blockOf = (rows: string[]): string =>
  `\n[ATTACHMENTS_BLOCK]\n[附件]\n${rows.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n[/ATTACHMENTS_BLOCK]`

const writeFile = (rel: string, bytes: Buffer | string): string => {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return abs
}

beforeAll(() => {
  root = path.join(mkdtempSync(path.join(os.tmpdir(), "turn-img-")), "uploads")
  mkdirSync(path.join(root, sid), { recursive: true })
  writeFile(`${sid}/a.png`, PNG_1X1)
  // 其他會話的圖（跨會話拒絕用）＋uploads 目錄外的穿越目標。
  writeFile(`other/secret.png`, PNG_1X1)
  writeFileSync(path.join(path.dirname(root), "evil.png"), PNG_1X1)
})

afterAll(() => {
  try {
    rmSync(path.dirname(root), { recursive: true, force: true })
  } catch {
    /* 清理失敗不影響驗收 */
  }
})

describe("buildTurnImageParts — 真檔案", () => {
  test("① 正常單圖：產出 file part，url 以 data:image/png;base64, 開頭且可解回同一 bytes", async () => {
    const content = blockOf([`uploads/${sid}/a.png | image/png | ${PNG_1X1.length}`])
    const out = await buildTurnImageParts({ sessionId: sid, content, vision: true, uploadsRoot: root })
    expect(out.skipped).toEqual([])
    expect(out.parts.length).toBe(1)
    const p = out.parts[0]
    expect(p.type).toBe("file")
    expect(p.mime).toBe("image/png")
    expect(p.filename).toBe("a.png")
    expect(p.url.startsWith("data:image/png;base64,")).toBe(true)
    const decoded = Buffer.from(p.url.slice("data:image/png;base64,".length), "base64")
    expect(decoded.equals(PNG_1X1)).toBe(true)
  })

  test("② 跨會話路徑與路徑穿越一律被拒（outside_session_uploads）", async () => {
    const content = blockOf([
      `uploads/other/secret.png | image/png | ${PNG_1X1.length}`,
      `../evil.png | image/png | ${PNG_1X1.length}`,
    ])
    const out = await buildTurnImageParts({ sessionId: sid, content, vision: true, uploadsRoot: root })
    expect(out.parts).toEqual([])
    expect(out.skipped.length).toBe(2)
    expect(out.skipped.every((s) => s.reason === "outside_session_uploads")).toBe(true)
  })

  test("③ 超過 4 張被截：前 4 張附上、其餘記 over_image_limit", async () => {
    const rows: string[] = []
    for (let i = 0; i < 6; i++) {
      writeFile(`${sid}/m${i}.png`, PNG_1X1)
      rows.push(`uploads/${sid}/m${i}.png | image/png | ${PNG_1X1.length}`)
    }
    const out = await buildTurnImageParts({ sessionId: sid, content: blockOf(rows), vision: true, uploadsRoot: root })
    expect(out.parts.length).toBe(4)
    expect(out.skipped.length).toBe(2)
    expect(out.skipped.every((s) => s.reason === "over_image_limit")).toBe(true)
  })

  test("④ 超大單檔被跳（image_too_large），不拋錯、不靜默", async () => {
    const bigLen = MAX_IMAGE_BYTES + 1
    writeFile(`${sid}/big.png`, Buffer.alloc(bigLen, 1))
    const content = blockOf([`uploads/${sid}/big.png | image/png | ${bigLen}`])
    const out = await buildTurnImageParts({ sessionId: sid, content, vision: true, uploadsRoot: root })
    expect(out.parts).toEqual([])
    expect(out.skipped).toEqual([{ path: `uploads/${sid}/big.png`, reason: "image_too_large" }])
  })

  test("⑤ 非圖片列被忽略（不進 parts 也不進 skipped）", async () => {
    writeFile(`${sid}/doc.pdf`, "%PDF-1.4\n")
    const content = blockOf([
      `uploads/${sid}/doc.pdf | application/pdf | 10`,
      `uploads/${sid}/a.png | image/png | ${PNG_1X1.length}`,
    ])
    const out = await buildTurnImageParts({ sessionId: sid, content, vision: true, uploadsRoot: root })
    expect(out.parts.length).toBe(1)
    expect(out.parts[0].filename).toBe("a.png")
    expect(out.skipped).toEqual([])
  })

  test("⑥ 非視覺模型：不讀檔、不產 parts，圖片列以 model_no_vision 回報（供誠實提示）", async () => {
    const content = blockOf([`uploads/${sid}/a.png | image/png | ${PNG_1X1.length}`])
    const out = await buildTurnImageParts({ sessionId: sid, content, vision: false, uploadsRoot: root })
    expect(out.parts).toEqual([])
    expect(out.skipped).toEqual([{ path: `uploads/${sid}/a.png`, reason: "model_no_vision" }])
  })

  test("⑦ 合計超 12MB：超出者記 total_too_large", async () => {
    const per = 4 * 1024 * 1024 // 4MB，單檔不超 8MB；3 張剛好 12MB，第 4 張超合計
    const rows: string[] = []
    for (let i = 0; i < 4; i++) {
      writeFile(`${sid}/t${i}.png`, Buffer.alloc(per, 1))
      rows.push(`uploads/${sid}/t${i}.png | image/png | ${per}`)
    }
    const out = await buildTurnImageParts({ sessionId: sid, content: blockOf(rows), vision: true, uploadsRoot: root })
    expect(out.parts.length).toBe(3)
    expect(out.skipped).toEqual([{ path: `uploads/${sid}/t3.png`, reason: "total_too_large" }])
    expect(3 * per).toBeLessThanOrEqual(MAX_TOTAL_BYTES)
  })

  test("⑧ 格式認不出（缺 marker／亂碼）→ 回空，絕不拋錯", async () => {
    for (const bad of ["", "no marker here", "[ATTACHMENTS_BLOCK]\ngarbage line no pipes\n[/ATTACHMENTS_BLOCK]", "| | |"]) {
      const out = await buildTurnImageParts({ sessionId: sid, content: bad, vision: true, uploadsRoot: root })
      expect(out.parts).toEqual([])
      expect(out.skipped).toEqual([])
    }
  })
})
