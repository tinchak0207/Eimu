"""PixAI bridge: OpenAI-compatible /v1/images/generations in front of the PixAI pool.

Vercel (image.tinchak0207.xyz) treats this as a regular OpenAI-format channel:
  POST {base}/v1/images/generations  {model, prompt, n, size}
  -> { data: [{ url }] }            (OpenAI style)
Errors are OpenAI-style { error: { message } } so the upstream route surfaces them.

=== 分层重试策略 ===
Layer 1: 单账号重试（槽位重试 1 次，最多 3 次）
Layer 2: 账号轮换（遍历全池，跳过不健康账号）
Layer 3: 整池冷却（全池失败后冷却 60s，连续失败 2 次触发告警）
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "pixai_pool"))

from pixai_client import PixaiError, generate, task_image_url
from pool_store import PoolStore

BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
POOL_FILE = BASE_DIR / "pixai_pool" / "pool.json"

# PixAI official top models (modelVersionIdMap from pixai.art app config).
MODEL_VERSION_MAP = {
    "pixai-moonbeam": "1648918127446573124",
    "pixai-diamond": "1648918125563330623",
    "pixai-neverland": "1648918123654922298",
    "pixai-whimsical": "1648918121624879157",
    "pixai-hassaku": "1648918119460618288",
}

_LEASE_FILE = BASE_DIR / ".lease"
_lock = asyncio.Lock()

# ── 重试策略（环境变量驱动，有界） ────────────────────────────────────

def _bounded_env_int(name: str, default: int, *, minimum: int = 0, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))

# 单账号槽位重试次数（默认 1，范围 0-3）
SLOT_RETRIES = _bounded_env_int("PIXAI_SLOT_RETRIES", 1, minimum=0, maximum=3)
# 整池故障冷却秒数（默认 60，范围 10-600）
POOL_COOLDOWN_SECONDS = _bounded_env_int(
    "PIXAI_POOL_COOLDOWN_SECONDS", 60, minimum=10, maximum=600,
)
# 连续失败触发告警阈值（默认 2，范围 1-10）
CONSECUTIVE_FAILURE_ALERT = _bounded_env_int(
    "PIXAI_CONSECUTIVE_FAILURE_ALERT", 2, minimum=1, maximum=10,
)

# 运行时状态
_pool_failure_streak = 0
_pool_cooldown_until = 0.0
_health_skip_accounts: set[str] = set()  # 临时不健康的账号 token


def _pool_on_cooldown() -> bool:
    """整池冷却中？"""
    return time.time() < _pool_cooldown_until


def _read_pool():
    store = PoolStore(str(POOL_FILE))
    accounts = [a for a in store.load() if a.get("status") == "active" and a.get("token")]
    # 排除临时不健康的账号
    accounts = [a for a in accounts if a["token"] not in _health_skip_accounts]
    accounts.sort(key=lambda a: (a.get("priority") is not None, -int(a.get("priority") or 0)))
    return accounts


def _next_lease_index(total: int) -> int:
    try:
        idx = int(_LEASE_FILE.read_text().strip() or "0")
    except Exception:
        idx = 0
    return (idx + 1) % total if total else 0


def _record_lease(idx: int):
    try:
        _LEASE_FILE.write_text(str(idx))
    except Exception:
        pass


def _health_skip(token: str, duration: float = 60.0):
    """临时跳过某账号（不写 pool.json，免競態）。"""
    _health_skip_accounts.add(token)
    # duration 秒後自動恢復
    try:
        loop = asyncio.get_running_loop()
        loop.call_later(duration, _health_restore, token)
    except RuntimeError:
        # 不在事件循環中，用線程定時器
        import threading
        threading.Timer(duration, _health_restore, args=(token,)).start()


def _health_restore(token: str):
    _health_skip_accounts.discard(token)


def _openai_error(message: str, status: int):
    return {"error": {"message": message, "type": "pixai_bridge_error", "code": status}}


async def generate_image(model: str, prompt: str) -> dict:
    global _pool_failure_streak, _pool_cooldown_until
    version_id = MODEL_VERSION_MAP.get(model)
    if not version_id:
        return _openai_error(f"Unknown model '{model}'.", 400)

    # 整池冷却檢查
    if _pool_on_cooldown():
        remaining = int(_pool_cooldown_until - time.time())
        return _openai_error(
            f"PixAI pool is cooling down ({remaining}s remaining).", 503,
        )

    # 用全局鎖排列請求，避免多 worker 同時搶同一帳號
    async with _lock:
        accounts = _read_pool()
        if not accounts:
            return _openai_error("PixAI pool is empty or has no active accounts.", 503)

        loop = asyncio.get_running_loop()
        last_error = None
        start = _next_lease_index(len(accounts))
        total_accounts = len(accounts)

        # 外層：遍歷帳號（輪換）
        for step in range(total_accounts):
            account = accounts[(start + step) % total_accounts]

            # 內層：槽位重試
            for attempt in range(1 + SLOT_RETRIES):
                try:
                    task = await loop.run_in_executor(
                        None,
                        lambda a=account, v=version_id, p=prompt: generate(
                            a["token"], v, p, "lowres, bad anatomy, watermark",
                            width=768, height=1024, steps=20, cfg=7, batch=1,
                        ),
                    )
                    task_id = task["id"]

                    deadline = time.time() + 180
                    status = "waiting"
                    url = None
                    while time.time() < deadline:
                        await asyncio.sleep(4)
                        status, urls = await loop.run_in_executor(
                            None, lambda t=task_id, a=account: task_image_url(a["token"], t),
                        )
                        if status in ("completed", "failed", "cancelled", "expired"):
                            url = urls.get("PUBLIC") or urls.get("ORIGINAL") or urls.get("THUMBNAIL")
                            break
                    if status == "completed" and url:
                        _record_lease((start + step) % total_accounts)
                        _pool_failure_streak = 0  # 成功，重置連續失敗計數
                        return {"data": [{"url": url}], "provider": "pixai"}
                    last_error = RuntimeError(f"task {task_id} ended {status}")
                except PixaiError as e:
                    last_error = e
                    if e.status == 401:
                        # token 無效，標記不健康，跳到下一個帳號
                        _health_skip(account["token"], duration=300.0)
                        break  # 跳出槽位重試，換帳號
                    if attempt < SLOT_RETRIES:
                        await asyncio.sleep(2)  # 重試前短暫等待
                        continue
                except Exception as e:
                    last_error = e
                    if attempt < SLOT_RETRIES:
                        await asyncio.sleep(2)
                        continue
                    break  # 超出重試次數，換帳號

        # 全池都失敗了
        _pool_failure_streak += 1
        cooldown = POOL_COOLDOWN_SECONDS * _pool_failure_streak  # 線性退避
        _pool_cooldown_until = time.time() + cooldown

        if _pool_failure_streak >= CONSECUTIVE_FAILURE_ALERT:
            # TODO: 發送告警（通知渠道）
            pass

        return _openai_error(
            f"All PixAI pool accounts failed (streak={_pool_failure_streak}, "
            f"cooldown={cooldown}s): {last_error}", 502,
        )


async def handle_generation(body: dict) -> dict:
    model = body.get("model") or ""
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return _openai_error("prompt is required.", 400)
    return await generate_image(model, prompt)


def run_generation(payload: dict) -> dict:
    return asyncio.run(handle_generation(payload))


if __name__ == "__main__":
    print(json.dumps(run_generation({"model": sys.argv[1], "prompt": sys.argv[2]}), ensure_ascii=False))