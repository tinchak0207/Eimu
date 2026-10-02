#!/usr/bin/env bash
# run-tests.sh — gateway 測試的**完整**跑法（逐檔執行並彙總退出碼）。
#
# 為什麼需要它（2026-10-02 實測，兩個獨立的「假綠」來源）：
#   1. `bun test`（bun 1.4.2）單次呼叫最多只執行 **18 個測試檔**，其餘被靜默丟棄，
#      exit code 仍是 0。gateway 目錄現有 25 個 *.test.ts → 用 `bun test` 跑會有 7 檔
#      從未執行。傳入完整檔名清單或 --max-concurrency 都無效。
#   2. 部分 *.test.ts 是**腳本式**自跑檔（頂層 harness + 自報結果，跑法為
#      `bun run <file>`）：collaborate-gate / workflow-generate-reject /
#      workflow-gw-1002-fixes / workflow-h8-h13-m4。它們在 `bun test` 下回報
#      「Ran 0 tests」，看起來通過、實則一條斷言都沒跑。
#   本腳本逐檔啟動；某檔在 `bun test` 下 Ran 0 tests 時，改以 `bun run` 執行並取其退出碼。
#   任何一檔失敗 → 整體非零退出。
#
# 用法：bash deploy-staging/vps-tools/run-tests.sh [測試檔相對 gateway 的路徑...]
#   不給參數 = 跑 deploy-staging/gateway 下全部 *.test.ts（含子目錄）。
set -uo pipefail

GW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../gateway" && pwd)"
cd "$GW_DIR" || exit 2

if [ "$#" -gt 0 ]; then
  mapfile -t FILES < <(printf '%s\n' "$@")
else
  mapfile -t FILES < <(find . -name '*.test.ts' -not -path './node_modules/*' | sed 's|^\./||' | sort)
fi

count_pass() { printf '%s\n' "$1" | sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' | tail -1; }
count_fail() { printf '%s\n' "$1" | sed -n 's/^[[:space:]]*\([0-9][0-9]*\) fail$/\1/p' | tail -1; }
# 腳本式自跑檔的自報結尾（例：'52 passed, 0 failed' / 'ALL PASS: ...'）
# 每組兩條 s///：第二條專門吃「數字在行首」的情形——只用 '.*[^0-9]\(...\)' 會漏掉
# '52 passed, 0 failed' 這種行（行首沒有非數字字元可匹配），實測害 4 個腳本式檔案
# 全部顯示 pass=0（計數偏低，與退出碼判定不一致的假象）。
count_script_pass() { printf '%s\n' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) passed.*/\1/p; s/^\([0-9][0-9]*\) passed.*/\1/p' | tail -1; }
count_script_fail() { printf '%s\n' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) failed.*/\1/p; s/^\([0-9][0-9]*\) failed.*/\1/p' | tail -1; }
# 兜底：部分腳本式檔案根本不印數字摘要，只逐條印 '✓ …'（如 workflow-generate-reject、
# workflow-h8-h13-m4）。此時改點 ✓ 的行數當通過數——否則會顯示 pass=0，把「有跑」誤報成
# 「沒跑」。這類檔案失敗時一律 throw→process.exit(1)，故退出碼仍是權威判定。
count_script_checks() { printf '%s\n' "$1" | grep -c '✓' || true; }

files=0 pass=0 fail=0 bad=0
for f in "${FILES[@]}"; do
  files=$((files + 1))
  out="$(bun test "$f" 2>&1)"
  rc=$?
  ran=$(printf '%s\n' "$out" | sed -n 's/.*Ran \([0-9][0-9]*\) tests\? across.*/\1/p' | tail -1)
  mode="bun test"
  if [ "${ran:-1}" = "0" ]; then
    # 腳本式自跑檔：bun:test 不執行其 node:test 斷言，改以 bun run 執行。
    mode="bun run"
    out="$(bun run "$f" 2>&1)"
    rc=$?
    p=$(count_script_pass "$out"); x=$(count_script_fail "$out")
    if [ -z "$p" ]; then p=$(count_script_checks "$out"); x=0; fi
  else
    p=$(count_pass "$out"); x=$(count_fail "$out")
  fi
  # 判定一律以退出碼為準（grep 只作顯示；日誌文字含 failed/✗ 會造成假陽性）。
  p=${p:-0}; x=${x:-0}
  pass=$((pass + p))
  fail=$((fail + x))
  if [ "$rc" -ne 0 ]; then
    bad=$((bad + 1))
    printf 'FAIL %-40s mode=%s pass=%s fail=%s rc=%s\n' "$f" "$mode" "$p" "$x" "$rc"
    printf '%s\n' "$out" | grep -E '\(fail\)|✗' | head -10 | sed 's/^/       /'
  else
    printf 'ok   %-40s mode=%-8s pass=%s fail=%s\n' "$f" "$mode" "$p" "$x"
  fi
done

echo "──────────────────────────────────────────────────────"
echo "files=$files pass=$pass fail=$fail failing_files=$bad"
[ "$bad" -eq 0 ]
