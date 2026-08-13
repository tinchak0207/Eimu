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
