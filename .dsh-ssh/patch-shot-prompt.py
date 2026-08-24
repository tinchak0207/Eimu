#!/usr/bin/env python3
"""patch-shot-prompt.py — gateway index.ts 的 submitWorkflowNode 支援結構化 shot JSON prompt。

用法（VPS 上）：python3 patch-shot-prompt.py
  1. 備份 /opt/agent-harness/gateway/index.ts → index.ts.bak-shot-prompt
  2. 精確字符串替換 A-E（B-E 每個 pattern 必須在全文恰好出現一次，0 次或多次都報錯
     印出失敗 pattern 名並 exit 1，原檔不動——所有替換在記憶體完成後才寫回）
  3. 全部成功後印 PATCHED OK 與替換計數

替換內容：
  A  import video-prompt-schema（條件：全文尚無該 import 時才插入，錨點為 WorkflowService import 行）
  B  刪舊的 prompt 解析行（移到 model/size 之後——shot JSON 需要 model 做按族編譯）
  C  size 行後插入 shot 編譯段（parseShotCandidate → compileShotPrompt 按模型族編譯，
     回寫 shotSize / payloadDurationHint）
  D  payload 的 size → size: shotSize（用 model/size/n/response_format 五行 context 鎖定唯一）
  E  duration 默認 5 → payloadDurationHint ?? 5
"""

import shutil
import sys
from pathlib import Path

TARGET = Path("/opt/agent-harness/gateway/index.ts")
BACKUP = TARGET.with_name("index.ts.bak-shot-prompt")

# 替換 A（條件插入）
A_ANCHOR = 'import { WorkflowService } from "./workflow-service"'
A_NEW_IMPORT = 'import { compileShotPrompt, parseShotCandidate, shotOutputParams, type ShotJson } from "./video-prompt-schema"'

# 替換 C 插入的代碼塊（緊跟 size 行之後，縮進 2 空格）
C_BLOCK = """  const size = typeof meta.size === "string" ? meta.size : "1024x1024"
  // 結構化 shot JSON 優先：video 節點 prompt 來自 shot JSON 時按模型族編譯成模型最愛的格式。
  let prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""
  let shotSize = size
  let payloadDurationHint: number | undefined = undefined
  const shotCandidate = (parseShotCandidate(meta.shot) ?? parseShotCandidate(prompt)) as ShotJson | null
  if (node.kind === "video" && shotCandidate) {
    prompt = compileShotPrompt(shotCandidate, model)
    const shotParams = shotOutputParams(shotCandidate)
    if (shotParams.duration_seconds !== undefined && typeof meta.duration_seconds !== "number") payloadDurationHint = shotParams.duration_seconds
    if (shotParams.aspect_ratio && typeof meta.size !== "string") shotSize = shotParams.aspect_ratio
  }"""

# 替換 D 的五行 context（單獨 "    size," 會多重匹配，用整段 payload 尾鎖定唯一）
D_OLD = """    model,
    size,
    n: 1,
    response_format: "url",
  }"""
D_NEW = """    model,
    size: shotSize,
    n: 1,
    response_format: "url",
  }"""

REPLACEMENTS = [
    (
        "B-prompt-line",
        '  const prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""',
        "  // prompt 解析移到 model/size 之後（shot JSON 需要 model 做按族編譯）",
    ),
    (
        "C-shot-compile-block",
        '  const size = typeof meta.size === "string" ? meta.size : "1024x1024"',
        C_BLOCK,
    ),
    ("D-payload-size", D_OLD, D_NEW),
    (
        "E-duration-hint",
        '    payload.duration_seconds = typeof meta.duration_seconds === "number" ? meta.duration_seconds : 5',
        "    payload.duration_seconds = typeof meta.duration_seconds === \"number\" ? meta.duration_seconds : (payloadDurationHint ?? 5)",
    ),
]


def replace_once(text: str, name: str, old: str, new: str) -> str:
    count = text.count(old)
    if count != 1:
        print(f"FAIL[{name}] pattern 出現 {count} 次（預期恰好 1 次），不做任何修改", file=sys.stderr)
        sys.exit(1)
    return text.replace(old, new, 1)


def main() -> None:
    original = TARGET.read_text(encoding="utf-8")
    shutil.copyfile(TARGET, BACKUP)
    text = original
    applied = 0

    # A：條件插入（冪等——已 import 則跳過）
    if "video-prompt-schema" in text:
        print("SKIP[A-import] 全文已含 video-prompt-schema import，跳過插入")
    else:
        text = replace_once(text, "A-import-anchor", A_ANCHOR, A_ANCHOR + "\n" + A_NEW_IMPORT)
        applied += 1

    for name, old, new in REPLACEMENTS:
        text = replace_once(text, name, old, new)
        applied += 1

    TARGET.write_text(text, encoding="utf-8")
    print(f"PATCHED OK ({applied} replacements, backup: {BACKUP})")


if __name__ == "__main__":
    main()
