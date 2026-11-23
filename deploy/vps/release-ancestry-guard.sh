#!/usr/bin/env bash
# release-ancestry-guard.sh — gateway-release.sh / opencode-release.sh 共用的「不许倒退」发版闸（source 进来用）
#
# 2026-10-30 事故：13:41 SGT 另一条路线从 image 分支发 c49279da，那条线不含 b3c825d（退款终态守卫）、
#   33006a8bc（连发不复用旧图）、31775fcf4（journal setgid）等 commit → 生产被静默回退；
#   另有循环在不带 --sha 的情况下直接发了 HEAD。recon 只比「生产 = 上次发的那版」，挡不住「新版比线上旧」。
#
# 规则：
#   1. release 必须显式 --sha（不再默认 HEAD）。
#   2. 候选 sha 必须包含线上当前在跑的每一个 commit（git merge-base --is-ancestor <线上> <候选>），
#      否则拒发，并列出候选缺的 commit。--fast / --skip-recon / --force 都不跳过本闸。
#   3. 唯一覆盖：--override-ancestry "<理由>"（理由 ≥8 字），本地＋VPS 各写一行审计。
#   4. 读线上状态是只读 SSH；--dry-run 时照样读真线上，只是不写远端审计。
#   5. 线上版本读不到/不可判定 → 拒发（fail-closed），同样只能带理由覆盖。
# 竞态：调用方必须「先抓激活身份（GW_EXPECTED/OC_EXPECTED）再跑本闸」，之后若有别人发版，
#   激活阶段的 ACTIVATION_CONFLICT 会拦下，因此本闸读到的线上版本不会过期。

RELEASE_OVERRIDE_REASON="${RELEASE_OVERRIDE_REASON:-}"
RELEASE_AUDIT_LOCAL="${RELEASE_AUDIT_LOCAL:-$HOME/.local/state/eimu/release-audit.log}"
RELEASE_AUDIT_REMOTE="${RELEASE_AUDIT_REMOTE:-/opt/agent-harness/releases/release-audit.log}"

guard_require_explicit_sha() {
  # $1=SHA 变量值 $2=子命令名
  if [ -z "${1:-}" ]; then
    printf 'ABORT: %s 必须显式 --sha <commit>（已取消默认 HEAD：2026-10-30 循环不带 --sha 发版覆盖生产）\n' "$2" >&2
    exit 1
  fi
}

guard_set_override() {
  local reason="${1:-}"
  reason="$(printf '%s' "$reason" | tr '\n\r\t' '   ')"
  if [ "${#reason}" -lt 8 ]; then
    printf 'ABORT: --override-ancestry 需要理由（≥8 字），例：--override-ancestry "回滚 c49 的坏版，暴君已同意"\n' >&2
    exit 1
  fi
  RELEASE_OVERRIDE_REASON="$reason"
}

# $1=组件名 $2=候选 sha（完整）$3=repo $4=是否 dry-run(0/1) $5=远端审计写入函数名 其余=线上 commit 列表（可为空＝不可判定）
guard_check_ancestry() {
  local component="$1" cand="$2" repo="$3" dry="$4" remote_writer="$5"; shift 5
  local -a online=("$@")
  local problem="" o full missing_total=0 report="" n
  if [ "${#online[@]}" -eq 0 ]; then
    problem="线上版本不可判定（读不到 meta/history，或最后一条记录不是 commit）"
  fi
  for o in "${online[@]}"; do
    if ! full="$(git -C "$repo" rev-parse --verify --quiet "${o}^{commit}")"; then
      problem="${problem:+$problem；}本地仓库没有线上 commit $o（先 git fetch github，再判断）"
      continue
    fi
    if git -C "$repo" merge-base --is-ancestor "$full" "$cand"; then
      report+="  OK   线上 ${full:0:12} ⊂ 候选 ${cand:0:12}"$'\n'
    else
      n="$(git -C "$repo" rev-list --count "$cand..$full")"
      missing_total=$((missing_total + n))
      report+="  MISS 线上 ${full:0:12} 不在候选 ${cand:0:12} 的祖先里；候选缺 $n 个 commit："$'\n'
      report+="$(git -C "$repo" log --oneline --no-decorate -n 40 "$cand..$full" | sed 's/^/         /')"$'\n'
      [ "$n" -gt 40 ] && report+="         …（另有 $((n - 40)) 个）"$'\n'
    fi
  done
  printf '== 发版祖先闸（%s）候选 %s；线上 %s ==\n' "$component" "${cand:0:12}" "${online[*]:-<未知>}" >&2
  [ -n "$report" ] && printf '%s' "$report" >&2
  if [ -z "$problem" ] && [ "$missing_total" -eq 0 ]; then
    printf 'ANCESTRY_OK %s 候选包含线上全部 commit\n' "$component" >&2
    return 0
  fi
  [ -n "$problem" ] && printf '  %s\n' "$problem" >&2
  if [ -z "$RELEASE_OVERRIDE_REASON" ]; then
    printf 'ABORT: ANCESTRY_REJECT %s：候选 %s 会回退线上（缺 %s 个 commit%s）。\n' \
      "$component" "${cand:0:12}" "$missing_total" "${problem:+；$problem}" >&2
    printf '  正确做法：把线上版本 merge/rebase 进候选后重发。确属有意回退：--override-ancestry "<理由>"（会写审计）。\n' >&2
    exit 1
  fi
  local line
  line="$(printf '%s\tcomponent=%s\tdecision=OVERRIDE\tdry_run=%s\tcandidate=%s\tonline=%s\tmissing=%s\tactor=%s@%s\treason=%s' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$component" "$dry" "$cand" "$(IFS=,; echo "${online[*]:-unknown}")" \
    "$missing_total" "$(id -un)" "$(uname -n 2>/dev/null || echo ?)" "$RELEASE_OVERRIDE_REASON")"
  mkdir -p "$(dirname "$RELEASE_AUDIT_LOCAL")"
  printf '%s\n' "$line" >> "$RELEASE_AUDIT_LOCAL"
  if [ "$dry" -eq 1 ]; then
    printf 'ANCESTRY_OVERRIDE（dry-run，只写本地审计 %s，不写远端）\n' "$RELEASE_AUDIT_LOCAL" >&2
  else
    printf '%s\n' "$line" | "$remote_writer" "$RELEASE_AUDIT_REMOTE" \
      || { printf 'ABORT: 远端审计写入失败 → 不发\n' >&2; exit 1; }
    printf 'ANCESTRY_OVERRIDE 已写审计（本地 %s ＋ VPS %s）\n' "$RELEASE_AUDIT_LOCAL" "$RELEASE_AUDIT_REMOTE" >&2
  fi
}

# opencode-history.log → 线上生效的 commit 集合（stdin 读 history）。
#   release 行：<tag> <sha> <ts> release …   → 生效集合重置为 {sha}，并记住发版前的集合
#   prompts-only 行：prompts-only <sha> <ts> prompts → 追加（AGENTS.md/_prompt-routing 来自它）
#   rollback 行：rollback <备份路径> <ts> …   → 恢复「最近一次全量发版之前」的集合（脚本永远取最新 -pre 备份）
guard_opencode_online_from_history() {
  awk '
    function hex(s){ return s ~ /^[0-9a-f]{40}$/ }
    $1=="prompts-only" { if (hex($2)) cur = cur " " $2; else cur = "BAD"; next }
    $1=="rollback"     { cur = before; next }
    $4=="release"      { before = cur; cur = hex($2) ? $2 : "BAD"; next }
    END { if (cur !~ /BAD/) print cur }
  ' | tr ' ' '\n' | sed '/^$/d' | awk '!seen[$0]++'
}
