#!/usr/bin/env bash
# run-tests.sh — gateway 测试的**完整**跑法（逐档执行并汇总退出码）。
#
# 为什么需要它（2026-10-02 实测，两个独立的「假绿」来源）：
#   1. `bun test`（bun 1.4.2）单次呼叫最多只执行 **18 个测试档**，其余被静默丢弃，
#      exit code 仍是 0。gateway 目录现有 25 个 *.test.ts → 用 `bun test` 跑会有 7 档
#      从未执行。传入完整档名清单或 --max-concurrency 都无效。
#   2. 部分 *.test.ts 是**脚本式**自跑档（顶层 harness + 自报结果，跑法为
#      `bun run <file>`）：collaborate-gate / workflow-generate-reject /
#      workflow-gw-1002-fixes / workflow-h8-h13-m4。它们在 `bun test` 下回报
#      「Ran 0 tests」，看起来通过、实则一条断言都没跑。
#   本脚本逐档启动；某档在 `bun test` 下 Ran 0 tests 时，改以 `bun run` 执行并取其退出码。
#   任何一档失败 → 整体非零退出。
#
# 用法：bash deploy-staging/vps-tools/run-tests.sh [测试档相对 gateway 的路径...]
#   不给参数 = 跑 deploy-staging/gateway 下全部 *.test.ts（含子目录）。
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
# 脚本式自跑档的自报结尾（例：'52 passed, 0 failed' / 'ALL PASS: ...'）
# 每组两条 s///：第二条专门吃「数字在行首」的情形——只用 '.*[^0-9]\(...\)' 会漏掉
# '52 passed, 0 failed' 这种行（行首没有非数字字元可匹配），实测害 4 个脚本式档案
# 全部显示 pass=0（计数偏低，与退出码判定不一致的假象）。
count_script_pass() { printf '%s\n' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) passed.*/\1/p; s/^\([0-9][0-9]*\) passed.*/\1/p' | tail -1; }
count_script_fail() { printf '%s\n' "$1" | sed -n 's/.*[^0-9]\([0-9][0-9]*\) failed.*/\1/p; s/^\([0-9][0-9]*\) failed.*/\1/p' | tail -1; }
# 兜底：部分脚本式档案根本不印数字摘要，只逐条印 '✓ …'（如 workflow-generate-reject、
# workflow-h8-h13-m4）。此时改点 ✓ 的行数当通过数——否则会显示 pass=0，把「有跑」误报成
# 「没跑」。这类档案失败时一律 throw→process.exit(1)，故退出码仍是权威判定。
count_script_checks() { printf '%s\n' "$1" | grep -c '✓' || true; }

files=0 pass=0 fail=0 bad=0
for f in "${FILES[@]}"; do
  files=$((files + 1))
  out="$(bun test "$f" 2>&1)"
  rc=$?
  ran=$(printf '%s\n' "$out" | sed -n 's/.*Ran \([0-9][0-9]*\) tests\? across.*/\1/p' | tail -1)
  mode="bun test"
  if [ "${ran:-1}" = "0" ]; then
    # 脚本式自跑档：bun:test 不执行其 node:test 断言，改以 bun run 执行。
    mode="bun run"
    out="$(bun run "$f" 2>&1)"
    rc=$?
    p=$(count_script_pass "$out"); x=$(count_script_fail "$out")
    if [ -z "$p" ]; then p=$(count_script_checks "$out"); x=0; fi
  else
    p=$(count_pass "$out"); x=$(count_fail "$out")
  fi
  # 判定一律以退出码为准（grep 只作显示；日志文字含 failed/✗ 会造成假阳性）。
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
