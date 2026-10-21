import { tool } from "@opencode-ai/plugin/tool"
import { execFile } from "node:child_process"
import path from "node:path"

// 文档结构化原语（通用，不限书籍不限领域）：PDF/EPUB/TXT/MD → 分章分节结构。
// 重活由 .opencode/lib/doc_struct_extract.py（open-source PyMuPDF + 纯 python 启发式）完成，
// 本工具只做参数/进程/返回封装。
// 产出 items[{level,title,page_start?,txt_line_start,txt_line_end,chars}] 并落盘
// <原路径>.struct.txt；扫描版 PDF（无文字层）诚实回 ok:false。

const WORKSPACE = "/opt/agent-harness/workspace"
const SCRIPT = path.join(WORKSPACE, ".opencode", "lib", "doc_struct_extract.py")

export default tool({
  description:
    "文档结构化原语（通用，不限书籍）。path 栏位填 pdf/epub/txt/md 档案的绝对路径或 workspace 相对路径（含 uploads/** 同名解析），输出章节/标题结构 items（level/title/页码/txt 行号区间/字数）并落盘 <原路径>.struct.txt。适用：分章、分节、统计各段字数、定位章节边界。扫描版 PDF 会回 ok:false 并给原因。禁止用 awk/grep 链现造轮子做同样的事。",
  args: {
    path: tool.schema.string().describe("pdf/epub/txt/md 档案的绝对路径或 workspace 相对路径"),
    max_items: tool.schema.number().int().min(1).max(500).optional().describe("最多返回的结构项数，预设 500"),
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
            resolve({ ok: false, reason: `doc_struct_extract.py 执行失败：${err.message} ${stderr?.slice(0, 2000) ?? ""}`, output: stderr ?? "" })
            return
          }
          try {
            resolve({ ...JSON.parse(stdout), output: stdout })
          } catch (e) {
            resolve({ ok: false, reason: `解析器输出非法 JSON：${String(e)}；stdout 前缀：${stdout.slice(0, 500)}`, output: "" })
          }
        },
      )
    })
  },
})
