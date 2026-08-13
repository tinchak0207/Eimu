"""PixAI bridge: OpenAI-compatible /v1/images/generations in front of the PixAI pool.

Vercel (image.tinchak0207.xyz) treats this as a regular OpenAI-format channel:
  POST {base}/v1/images/generations  {model, prompt, n, size}
  -> { data: [{ url }] }            (OpenAI style)
Errors are OpenAI-style { error: { message } } so the upstream route surfaces them.
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


def _read_pool():
    store = PoolStore(str(POOL_FILE))
    accounts = [a for a in store.load() if a.get("status") == "active" and a.get("token")]
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


def _openai_error(message: str, status: int):
    return {"error": {"message": message, "type": "pixai_bridge_error", "code": status}}


async def generate_image(model: str, prompt: str) -> dict:
    version_id = MODEL_VERSION_MAP.get(model)
    if not version_id:
        return _openai_error(f"Unknown model '{model}'.", 400)

    accounts = _read_pool()
    if not accounts:
        return _openai_error("PixAI pool is empty or has no active accounts.", 503)

    loop = asyncio.get_running_loop()
    last_error = None
    async with _lock:
        start = _next_lease_index(len(accounts))
        for step in range(len(accounts)):
            account = accounts[(start + step) % len(accounts)]
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
                    _record_lease((start + step) % len(accounts))
                    return {"data": [{"url": url}], "provider": "pixai"}
                last_error = RuntimeError(f"task {task_id} ended {status}")
            except PixaiError as e:
                last_error = e
                if e.status == 401:
                    continue
            except Exception as e:
                last_error = e
    return _openai_error(f"All PixAI pool accounts failed: {last_error}", 502)


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
