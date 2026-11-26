#!/usr/bin/env python3
"""记忆覆盖率闸门（2026-10-19）：把「该写记忆却没写」量化为可判定的数字。

定义（固定，不放宽）：
  信号会话 = 窗口内出现 `event=enqueue` 的 sessionId（session.idle 的确定性侦测入队）。
  覆盖会话 = 信号会话中，窗口内出现 `event=stored` 且 stored>0 的会话。
  覆盖率   = 覆盖会话 / 信号会话。

判定：
  审计档不存在或信号会话 < MEMORY_COV_MIN_SESSIONS → exit 3（资料不足，不假装通过）
  覆盖率 < MEMORY_COV_MIN                          → exit 2
  达标                                             → exit 0

环境变量：
  MEMORY_QUEUE_DIR       队列目录（首个候选；不存在时回退 /opt/agent-harness/state/memory-queue
                         再回退 ./.memory-queue）
  MEMORY_AUDIT_PATH      审计 JSONL（默认 <选中的 queueDir>/memory-audit.jsonl）
  MEMORY_COV_DAYS        窗口天数（默认 7；窗口为 cut <= t <= now，未来时间戳忽略）
  MEMORY_COV_MIN         覆盖率门槛（默认 0.3）
  MEMORY_COV_MIN_SESSIONS 最小信号样本（默认 5）

只读、stdlib、简体中文输出；不写任何档案。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))

# 2026-10-19 P2-6：队列目录不再在 import 时一次定死；依次尝试
# MEMORY_QUEUE_DIR → /opt/agent-harness/state/memory-queue → ./.memory-queue，
# 选第一个存在的目录。审计档默认跟随选中的目录（MEMORY_AUDIT_PATH 可显式覆盖）。
DEFAULT_QUEUE_DIRS = ["/opt/agent-harness/state/memory-queue", "./.memory-queue"]
AUDIT_FILENAME = "memory-audit.jsonl"

DAYS = int(os.environ.get("MEMORY_COV_DAYS", "7"))
MIN_COV = float(os.environ.get("MEMORY_COV_MIN", "0.3"))
MIN_SESSIONS = int(os.environ.get("MEMORY_COV_MIN_SESSIONS", "5"))


def resolve_queue_dir() -> tuple[Path | None, list[str]]:
    """依序找第一个存在的队列目录；回传 (目录或 None, 已检查路径清单)。"""
    candidates: list[str] = []
    env_dir = os.environ.get("MEMORY_QUEUE_DIR", "").strip()
    if env_dir:
        candidates.append(env_dir)
    candidates.extend(DEFAULT_QUEUE_DIRS)
    checked: list[str] = []
    seen: set[str] = set()
    for cand in candidates:
        if cand in seen:
            continue
        seen.add(cand)
        checked.append(cand)
        p = Path(cand)
        if p.is_dir():
            return p, checked
    return None, checked


def parse_at(raw: object) -> datetime | None:
    """解析审计行的 `at`；缺失/畸形 → None（不计入窗口，单独计数）。"""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        t = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except Exception:
        return None
    if t.tzinfo is None:
        # 我们写入的是 UTC ISO；缺失时区按 UTC 保守解释（不乱猜本地时区）。
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(CST)


def main() -> int:
    now = datetime.now(CST)
    cut = now - timedelta(days=DAYS)

    queue_dir, checked_dirs = resolve_queue_dir()
    explicit_audit = os.environ.get("MEMORY_AUDIT_PATH", "").strip()
    if explicit_audit and Path(explicit_audit).is_file():
        audit = Path(explicit_audit)
    elif queue_dir is not None:
        audit = queue_dir / AUDIT_FILENAME
    else:
        print(f"无资料（已检查：{'、'.join(checked_dirs)}）", file=sys.stderr)
        return 3

    print(f"窗口：近 {DAYS} 天（CST {now.isoformat()}，起点 {cut.isoformat()}，终点 {now.isoformat()}）")
    print(f"队列目录：{queue_dir if queue_dir is not None else '（未找到；使用显式 MEMORY_AUDIT_PATH）'}")
    print(f"审计档：{audit}")
    print(f"门槛：覆盖率 >= {MIN_COV:.0%}，最小信号会话数 >= {MIN_SESSIONS}")

    if not audit.is_file():
        print(f"无资料：审计档不存在或不可读（{audit}）", file=sys.stderr)
        return 3

    enqueue_sessions: set[str] = set()
    stored_sessions: set[str] = set()
    kind_counts: dict[str, int] = {}
    malformed = 0
    undated = 0
    future = 0
    total_lines = 0

    try:
        with open(audit, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total_lines += 1
                try:
                    o = json.loads(line)
                except Exception:
                    malformed += 1
                    continue
                if not isinstance(o, dict):
                    malformed += 1
                    continue
                event = o.get("event")
                sid = o.get("sessionId")
                if not isinstance(sid, str) or not sid:
                    malformed += 1
                    continue
                t = parse_at(o.get("at"))
                if t is None:
                    undated += 1
                    continue
                # P2-6：窗口 = cut <= t <= now；未来时间戳一律忽略（时钟漂移/伪造不虚增覆盖）。
                if t > now:
                    future += 1
                    continue
                if t < cut:
                    continue
                if event == "enqueue":
                    enqueue_sessions.add(sid)
                    kinds = o.get("kinds")
                    if isinstance(kinds, list):
                        for k in kinds:
                            if isinstance(k, str) and k:
                                kind_counts[k] = kind_counts.get(k, 0) + 1
                elif event == "stored":
                    stored = o.get("stored")
                    if isinstance(stored, (int, float)) and stored > 0:
                        stored_sessions.add(sid)
                # no_docs 只作审计留痕，不进入覆盖定义。
    except OSError as e:
        print(f"无资料：审计档读取失败（{e}）", file=sys.stderr)
        return 3

    covered = enqueue_sessions & stored_sessions
    uncovered = sorted(enqueue_sessions - stored_sessions)
    cov = (len(covered) / len(enqueue_sessions)) if enqueue_sessions else 0.0

    print(f"审计行：{total_lines}（畸形 {malformed}，无时间戳 {undated}，未来时间戳 {future}，窗口外已排除）")
    print(f"信号会话数：{len(enqueue_sessions)}")
    print(f"覆盖会话数：{len(covered)}")
    print(f"覆盖率：{cov:.1%}")
    if kind_counts:
        kinds_text = "，".join(
            f"{k}={kind_counts[k]}" for k in sorted(kind_counts)
        )
        print(f"按 kind 计数（窗口内 enqueue 事件，一次多 kind 各计 1）：{kinds_text}")
    else:
        print("按 kind 计数：无")
    if uncovered:
        shown = uncovered[:10]
        print(f"未覆盖 sessionId（最多 10 个，共 {len(uncovered)}）：")
        for sid in shown:
            print(f"  - {sid}")
    else:
        print("未覆盖 sessionId：无")

    if len(enqueue_sessions) < MIN_SESSIONS:
        print(
            f"资料不足：信号会话数 {len(enqueue_sessions)} < {MIN_SESSIONS}"
            f"（样本不足，不假装通过；请确认 MEMORY_QUEUE_DIR / MEMORY_AUDIT_PATH 与收盘入队是否生效）",
            file=sys.stderr,
        )
        return 3

    if cov + 1e-12 < MIN_COV:
        print(
            f"FAIL：记忆覆盖率 {cov:.1%} < 门槛 {MIN_COV:.0%}"
            f"（近 {DAYS} 天；该写记忆却没写＝信号会话未被批次提炼）",
            file=sys.stderr,
        )
        return 2

    print(f"PASS：记忆覆盖率 {cov:.1%} >= {MIN_COV:.0%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
