from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import json
import uvicorn

import app as bridge_core

API_KEY = __import__("os").environ.get("PIXAI_BRIDGE_API_KEY", "")

server = FastAPI(title="pixai-bridge", version="1.0.0")


def _authorized(request: Request) -> bool:
    if not API_KEY:
        return True
    header = request.headers.get("Authorization", "")
    return header == f"Bearer {API_KEY}"


@server.get("/healthz")
async def healthz():
    accounts = bridge_core._read_pool()
    return {"status": "ok", "pool_accounts": len(accounts)}


@server.get("/v1/models")
async def list_models(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": {"message": "Invalid API key."}}, status_code=401)
    return {"object": "list", "data": [{"id": m, "object": "model"} for m in bridge_core.MODEL_VERSION_MAP]}


@server.post("/v1/pool-sync")
async def pool_sync(request: Request):
    """接收刷新后的账号池,校验后原子替换 pool.json(自动备份旧池)。

    用于 24/7 token 刷新流水线:本地 Chrome 刷新 token 后推送新池,
    bridge 每次请求都重读文件,无需重启。
    """
    import os
    import time

    if not _authorized(request):
        return JSONResponse({"error": {"message": "Invalid API key."}}, status_code=401)
    try:
        pool = await request.json()
    except Exception:
        return JSONResponse({"error": {"message": "Invalid JSON body."}}, status_code=400)
    if not isinstance(pool, list) or not pool:
        return JSONResponse({"error": {"message": "Pool must be a non-empty list."}}, status_code=400)
    if any(not isinstance(a, dict) or not a.get("email") for a in pool):
        return JSONResponse({"error": {"message": "Every account must have an email."}}, status_code=400)
    active = [a for a in pool if a.get("status") == "active" and a.get("token")]
    if not active:
        return JSONResponse({"error": {"message": "Pool has no active account with token."}}, status_code=400)

    pool_file = str(bridge_core.POOL_FILE)
    tmp = pool_file + ".sync.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(pool, f, ensure_ascii=False, indent=2)
    if os.path.exists(pool_file):
        os.replace(pool_file, pool_file + ".bak-" + str(int(time.time())))
    os.replace(tmp, pool_file)
    return {
        "status": "ok",
        "accounts": len(pool),
        "active_with_token": len(active),
    }


@server.post("/v1/images/generations")
async def images_generations(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": {"message": "Invalid API key."}}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": {"message": "Invalid JSON body."}}, status_code=400)
    return JSONResponse(await bridge_core.handle_generation(body))


if __name__ == "__main__":
    uvicorn.run(server, host="0.0.0.0", port=18090)
