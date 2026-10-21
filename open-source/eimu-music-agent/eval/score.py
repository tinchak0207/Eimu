#!/usr/bin/env python3
"""把 SongBench 逐档结果汇总成我们口径的分数表（七维 + 均分）。

用法：score.py <评分器输出目录> [输出 json]
"""
import json, sys
from pathlib import Path

DIMS = ["Melody", "Arrangement", "Musicality", "Vocal", "Instrumental", "Mixing", "Structure"]


def load(path: Path):
    for name in ("result.json", "result_average.json"):
        p = path / name
        if p.exists():
            return json.loads(p.read_text())
    files = sorted(path.glob("*.json"))
    if not files:
        raise SystemExit(f"{path} 下找不到结果 json")
    merged = {}
    for f in files:
        d = json.loads(f.read_text())
        if isinstance(d, dict) and all(isinstance(v, dict) for v in d.values()):
            merged.update(d)
    return merged


def main():
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    raw = load(src)
    rows = []
    for k, v in raw.items():
        if not isinstance(v, dict) or not all(d in v for d in DIMS):
            continue
        mean7 = sum(v[d] for d in DIMS) / len(DIMS)
        rows.append({"file": k, "dims": {d: round(v[d], 4) for d in DIMS}, "mean7": round(mean7, 4)})
    rows.sort(key=lambda r: -r["mean7"])
    summary = {"n": len(rows), "mean7": round(sum(r["mean7"] for r in rows) / len(rows), 4), "tracks": rows}
    print(f'n={summary["n"]}  mean7={summary["mean7"]}')
    for r in rows:
        print(f'  {r["mean7"]:.4f}  {r["file"]}')
    if out:
        out.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
        print("wrote", out)


if __name__ == "__main__":
    main()
