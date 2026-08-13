import urllib.request, re
from concurrent.futures import ThreadPoolExecutor, as_completed

with open("_assets.txt", encoding="utf-8") as f:
    assets = [l for l in f.read().splitlines() if l]

def grab(url):
    try:
        js = urllib.request.urlopen(url, timeout=25).read().decode("utf-8", "ignore")
    except Exception as e:
        return None
    hits = []
    for m in re.finditer(r'(query|mutation)\s+(\w+)', js):
        hits.append(m.group(0))
    return (url.split("/")[-1], len(js), hits[:8])

with ThreadPoolExecutor(max_workers=16) as ex:
    futs = [ex.submit(grab, u) for u in assets]
    for f in as_completed(futs):
        r = f.result()
        if r and r[1] > 30000 and r[2]:
            print(r[0], r[1], r[2])
