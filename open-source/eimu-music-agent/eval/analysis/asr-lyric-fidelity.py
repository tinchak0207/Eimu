#!/usr/bin/env python3
"""消融四臂的「指令遵循」测量：把题面给定歌词当作 ground truth，
用 ASR 转写每首成品，算字符级召回（matched / len(gt)）。

SongBench/SongEval 都是「听起来好不好」的感知裁判，对「有没有照着题面唱」结构性失明；
本脚本量的是那条被失明的轴。

用法：python asr-lyric-fidelity.py [--model small] [--device cpu]
"""
import argparse, json, re, sys, unicodedata
from difflib import SequenceMatcher
from pathlib import Path

REPO = Path("/home/lenovo/Desktop/image-app")
BENCH = REPO / "bench/music-bench"
ARMS = {
    "A 裸Lyria": BENCH / "sb-in/raw-lyria-pilot",
    "B Eimu→FlowMusic": BENCH / "sb-in/beast-on-pilot-9",
    "C Eimu→YuE2": BENCH / "sb-in/beast-on-yue2-9",
    "D 裸YuE2": BENCH / "sb-in/raw-yue2-9",
}
CONTROL = "media-1789821225748-t6qbpy.wav"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z]", "", s)
    return s.lower()


def ground_truth() -> dict:
    lines = (BENCH / "suite/wsb-prompts.jsonl").read_text(encoding="utf-8").split("\n")
    gt = {}
    for idx in (0, 15, 100):
        body = json.loads(lines[idx])["prompt"].split("\n")[1:]
        sung = [l for l in body if l.strip() and not l.strip().startswith("[")
                and l.strip() != "[start_of_user_prompt]"]
        gt[f"idx{idx}"] = norm("".join(sung))
    return gt


def recall(gt: str, hyp: str) -> float:
    sm = SequenceMatcher(None, gt, hyp, autojunk=False)
    return sum(b.size for b in sm.get_matching_blocks()) / max(1, len(gt))


def load16k(path: Path):
    """ffmpeg 解成 16 kHz 单声道 float32——绕开 faster-whisper 的 PyAV 解码路径（本机 av 版本不兼容）。"""
    import subprocess
    import numpy as np
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000",
         "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute", default="int8")
    ap.add_argument("--only", default="", help="只跑某个 idx（合并进已有结果）")
    a = ap.parse_args()

    LANG = {0: "zh", 15: "zh", 100: "en"}   # idx100 的题面是英文歌词，不能用 zh 转写

    from faster_whisper import WhisperModel
    model = WhisperModel(a.model, device=a.device, compute_type=a.compute)

    gt = ground_truth()
    outp = BENCH / "results/sb-lyric-fidelity/result_lyric-fidelity.json"
    out = json.loads(outp.read_text())["arms"] if (a.only and outp.exists()) else {}
    rows = []
    for arm, d in ARMS.items():
        for f in sorted(d.glob("*.wav")):
            if f.name == CONTROL:
                continue
            key = f.stem
            pi = re.search(r"idx(\d+)", key)
            if not pi:
                continue
            if a.only and pi.group(1) != a.only:
                continue
            g = gt[f"idx{pi.group(1)}"]
            lang = LANG[int(pi.group(1))]
            segs, info = model.transcribe(load16k(f), language=lang, beam_size=5)
            hyp = norm("".join(s.text for s in segs))
            r = recall(g, hyp)
            out.setdefault(arm, {})[key] = {"recall": round(r, 4), "lang": lang,
                                            "gt_chars": len(g), "asr_chars": len(hyp),
                                            "asr_head": hyp[:60]}
            rows.append((arm, key, r, len(g), len(hyp)))
            print(f"{arm:16} {key:20} lang={lang} recall={r:.3f} gt={len(g)} asr={len(hyp)}", flush=True)

    print("\n=== 臂均 ===")
    for arm in ARMS:
        v = [x["recall"] for x in out[arm].values()]
        byprompt = {}
        for k, x in out[arm].items():
            byprompt.setdefault(re.search(r"idx(\d+)", k).group(0), []).append(x["recall"])
        pb = "  ".join(f"{p}={sum(s)/len(s):.3f}" for p, s in sorted(byprompt.items(),
                                                                   key=lambda t: int(t[0][3:])))
        print(f"{arm:16} n={len(v)} recall={sum(v)/len(v):.4f}   [{pb}]")

    o = BENCH / "results/sb-lyric-fidelity"
    o.mkdir(parents=True, exist_ok=True)
    payload = {"experiment": "lyric fidelity (char-level recall) vs brief lyrics, wsb idx0/15/100",
               "evaluator": f"faster-whisper {a.model} ({a.device}/{a.compute}); per-prompt language "
                            f"(idx0/15=zh, idx100=en)",
               "ground_truth": "题面里 [Tags] 行与段落标记之后、逐行写给模型的歌词（去标点后逐字符比对）",
               "metric": "difflib SequenceMatcher 匹配字符数 / ground-truth 字符数",
               "note": "SongBench/SongEval 是「听起来好不好」的感知裁判，对「有没有照着题面唱」结构性失明；本条量的是那条被失明的轴。",
               "arms": out}
    (o / "result_lyric-fidelity.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1))
    print("wrote", o / "result_lyric-fidelity.json")


if __name__ == "__main__":
    main()
