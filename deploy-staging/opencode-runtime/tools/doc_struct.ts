import { tool } from "@opencode-ai/plugin/tool"
import { execFile } from "node:child_process"
import path from "node:path"

// 文檔結構化原語（通用，不限書籍不限領域）：PDF/EPUB/TXT/MD → 分章分節結構。
// 重活由 .opencode/lib/doc_struct_extract.py（open-source PyMuPDF + 純 python 啟發式）完成，
// 本工具只做參數/進程/返回封裝。
// 產出 items[{level,title,page_start?,txt_line_start,txt_line_end,chars}] 並落盤
// <原路徑>.struct.txt；掃描版 PDF（無文字層）誠實回 ok:false。

const WORKSPACE = "/opt/agent-harness/workspace"
const SCRIPT = path.join(WORKSPACE, ".opencode", "lib", "doc_struct_extract.py")

export default tool({
  description:
    "文檔結構化原語（通用，不限書籍）。path 欄位填 pdf/epub/txt/md 檔案的絕對路徑或 workspace 相對路徑（含 uploads/** 同名解析），輸出章節/標題結構 items（level/title/頁碼/txt 行號區間/字數）並落盤 <原路徑>.struct.txt。適用：分章、分節、統計各段字數、定位章節邊界。掃描版 PDF 會回 ok:false 並給原因。禁止用 awk/grep 鏈現造輪子做同樣的事。",
  args: {
    path: tool.schema.string().describe("pdf/epub/txt/md 檔案的絕對路徑或 workspace 相對路徑"),
    max_items: tool.schema.number().int().min(1).max(500).optional().describe("最多返回的結構項數，預設 500"),
  },
  async execute(args) {
    const maxItems = args.max_items ?? 500
    return await new Promise((resolve) => {
      execFile(
        "python3",
        [SCRIPT, JSON.stringify({ path: args.path, workspace: WORKSPACE, max_items: maxItems })],
        { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, cwd: WORKSPACE },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            resolve({ ok: false, reason: `doc_struct_extract.py 執行失敗：${err.message} ${stderr?.slice(0, 2000) ?? ""}`, output: stderr ?? "" })
            return
          }
          try {
            resolve({ ...JSON.parse(stdout), output: stdout })
          } catch (e) {
            resolve({ ok: false, reason: `解析器輸出非法 JSON：${String(e)}；stdout 前綴：${stdout.slice(0, 500)}`, output: "" })
          }
        },
      )
    })
  },
})
