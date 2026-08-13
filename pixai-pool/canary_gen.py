import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath("pixai_pool_cli.py")))
from pixai_client import generate, task_image_url
from pool_store import PoolStore

store = PoolStore("pool.json")
acc = store.load()[0]
task = generate(acc["token"], "1983308862240288769",
                "masterpiece, best quality, 1girl, futuristic city, neon lights",
                "lowres, bad anatomy, watermark", batch=1)
print("task:", task)
for _ in range(30):
    time.sleep(5)
    status, urls = task_image_url(acc["token"], task["id"])
    print("poll:", status, {k: (v[:80]+"..." if v else "") for k, v in urls.items()})
    if status in ("completed", "failed", "cancelled", "expired"):
        break
