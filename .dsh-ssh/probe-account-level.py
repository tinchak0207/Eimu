#!/usr/bin/env python3
"""帳號級 vs IP 級 408 判定（v4）：用 index4 active token + 對比請求路徑。"""
import sys, time
sys.path.insert(0, "/app")
from core.token_mgr import token_manager
from adobe_client import AdobeClient

client = AdobeClient()
CONF = {
    "engine": "kling3", "upstream_model_id": "kling", "upstream_model_version": "kling_v3",
    "durations": (5, 10, 15), "ratios": ("16:9", "9:16"), "resolutions": ("720p",),
    "supports_audio": True, "duration": 5, "ratio": "16:9", "resolution": "720p",
}

toks = token_manager.tokens
active = [t for t in toks if t.get("status") == "active"]
print(f"active tokens: {len(active)}", flush=True)
for i, t in enumerate(active):
    val = t["value"]
    meta = token_manager.get_meta_by_value(val)
    acct = meta.get("token_account_id") or "?"
    # 同一 token submit 3 次看 408 是否穩定復現
    for attempt in (1, 2, 3):
        t0 = time.time()
        try:
            client.generate_video(
                token=val, video_conf=CONF,
                prompt="A snowflake drifting slowly in calm air, minimal",
                aspect_ratio="16:9", duration=5, timeout=3,
            )
            r = "SUCCESS(!!)"
        except Exception as e:
            r = f"{type(e).__name__}: {str(e)[:130]}"
        print(f"active{i}[{str(acct)[:10]}] try{attempt} ({time.time()-t0:.1f}s) {r}", flush=True)
        time.sleep(3)
