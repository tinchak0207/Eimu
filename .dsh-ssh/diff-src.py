import re
def load(p, strip):
    d = {}
    for line in open(p):
        m = re.match(r'([0-9a-f]{32})\s+(.*)', line.strip())
        if m:
            path = m.group(2)
            for s in strip:
                if path.startswith(s):
                    path = path[len(s):]
                    break
            d[path] = m.group(1)
    return d
vps = load('.dsh-ssh/vps-md5.txt', ['./'])
loc = load('.dsh-ssh/local-md5.txt', ['src/'])
common = [p for p in loc if p in vps]
diff = sorted(p for p in common if loc[p] != vps[p])
missing = sorted(p for p in loc if p not in vps)
extra = sorted(p for p in vps if p not in loc)
print("COMMON:", len(common), "DIFFERING:", len(diff), "LOCAL-ONLY:", len(missing), "VPS-ONLY:", len(extra))
for p in diff:
    print("  D", p)
for p in missing:
    print("  +", p)
for p in extra:
    print("  -", p)
