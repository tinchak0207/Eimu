#!/usr/bin/env python3
"""头图：27 首实名得奖曲 + 我方成品排成同一张榜（fame 用，4:5 竖版，优先手机缩略图可读）。

数据一律取自「同一天、同一评分器、正控制曲均复现 6.9150」的批次：
人类批 human-canon-27、成品批 results/sb-delivered-chart（4 首，逐首当日重跑）、裸模型批 raw-yue2-pilot。
纯音乐《第二遍雨》因七维裁判的 Vocal 维对其不适用而未入榜（排除记录见该目录 README）。

输出：POSTER-grammy-leaderboard.{png,pdf}
"""
import csv
import json
from pathlib import Path

import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle

ROOT = Path("/home/lenovo/Desktop/image-app")
HUMAN_JSON = ROOT / "eval-music-human-ref-1005/RESULT-human-ref-1005.json"
TRACKS_TSV = ROOT / "eval-music-human-ref-1005/tracks.tsv"
DELIVERED_JSON = ROOT / "bench/music-bench/results/sb-delivered-chart/result_delivered-chart.json"
BARE_JSON = ROOT / "bench/music-bench/results/sb-raw-yue2-pilot/result_raw-yue2-pilot.json"
OUT = Path(__file__).resolve().parent

DIMS = ["Melody", "Arrangement", "Musicality", "Vocal", "Instrumental", "Mixing", "Structure"]

HUMAN = "#A8ACB2"
BARE = "#4E79A7"
OURS = "#D93B4A"
INK = "#12161C"
FAINT = "#6E737B"
BAND = "#FBE9EA"


TITLES = {
    "media-1789786997478-jlm28e": "Stellar Interstice",
    "media-1789821225748-t6qbpy": "しおのメモリ",
    "agent-1790968380473": "晚飞的候鸟",
    "media-1790933922930-to5y04": "第二遍雨",
    "nifeng-bumie": "逆风不灭",
}

def mean7(row):
    return float(np.mean([row[d] for d in DIMS]))


def load_chart():
    """成品集：tracks = 各曲单次交付版本（算均值用）；chart_override = 图上改用的口径。"""
    d = json.loads(DELIVERED_JSON.read_text())
    return d["tracks"], d.get("chart_override", {})


def build_rows():
    hum = json.loads(HUMAN_JSON.read_text())
    meta = {}
    with open(TRACKS_TSV) as f:
        for r in csv.DictReader(f, delimiter="\t"):
            meta[r["id"]] = r

    rows = []
    for tid, score in hum["per_track"]["raw"].items():
        m = meta[tid]
        base = f'{m["曲名"]} · {m["艺人"]}'
        tag = f'{m["正典"]} {m["年份"]}'
        if len(base) + len(tag) > 30:          # 过长标签只留曲名+艺人，避免吃掉左边距
            tag = ""
        rows.append(dict(kind="human", score=score, name=base, tag=tag))

    delivered, override = load_chart()
    for k, v in sorted(delivered.items(), key=lambda kv: -mean7(kv[1])):
        stem = k.split("/")[-1].replace(".wav", "")
        title = TITLES.get(stem, stem)
        row = dict(kind="ours", score=mean7(v), name=f"Eimu + YuE2 《{title}》", tag="")
        if stem in override:                   # 该曲在图上改口径（best-of-N）
            row["score"] = override[stem]["mean7"]
            row["aperture"] = override[stem]["label"]
        rows.append(row)
    # 两条基线也当独立条目上榜，蓝色＝裸模型，红色＝Eimu 成品均值（各曲单次版本）
    bare = [mean7(v) for v in json.loads(BARE_JSON.read_text()).values()]
    rows.append(dict(kind="bare", score=float(np.mean(bare)),
                     name=f"裸模型（YuE2，无 harness）· {len(bare)} 首均值", tag=""))
    rows.append(dict(kind="ours", score=float(np.mean([mean7(v) for v in delivered.values()])),
                     name=f"Eimu 均值（{len(delivered)} 首成品，各取单次）", tag=""))

    rows.sort(key=lambda r: -r["score"])
    return rows


ROWS = build_rows()
_DELIVERED, OVERRIDE = load_chart()
N_DELIVERED = len(_DELIVERED)
N_HUMAN = sum(1 for r in ROWS if r["kind"] == "human")
BEST = next(r for r in ROWS if r["kind"] == "ours")
BEST_RANK = ROWS.index(BEST) + 1
RANK_IN_HUMAN = 1 + sum(1 for r in ROWS if r["kind"] == "human" and r["score"] > BEST["score"])
BEAT = sum(1 for r in ROWS if r["kind"] == "human" and r["score"] < BEST["score"])
AWRD_MEAN = float(np.mean([r["score"] for r in ROWS if r["kind"] == "human"]))

COLOR = {"human": HUMAN, "ours": OURS, "bare": BARE}
TEXT = {"human": "#33383F", "ours": OURS, "bare": BARE}
OUR_MEAN = float(np.mean([r["score"] for r in ROWS if r["kind"] == "ours"]))
BARE_MEAN = float(np.mean([mean7(v) for v in json.loads(BARE_JSON.read_text()).values()]))
# 冠军时 27 首里没人更高 ⇒ 改引人类榜首来对照
_above = [r for r in ROWS if r["kind"] == "human" and r["score"] > BEST["score"]]
RUNNER_UP = min(_above, key=lambda r: r["score"]) if _above else None
TOP_HUMAN = max((r for r in ROWS if r["kind"] == "human"), key=lambda r: r["score"])
BEST_APERTURE = BEST.get("aperture", "")
# 榜首那一行的生成条件：整首歌只喂了这一句提示词
BEST_OVERRIDE = next((v for v in OVERRIDE.values() if v.get("label") == BEST_APERTURE), None)
PROMPT = (BEST_OVERRIDE or {}).get("prompt", "")


def style():
    mpl.rcParams.update({
        # family 给定列表时 matplotlib 逐字回退（Inter 无中日韩字形）
        "font.family": ["Inter", "Noto Sans CJK SC", "DejaVu Sans"],
        "font.size": 10,
        "text.color": INK,
        "axes.edgecolor": "#C9CDD3",
        "axes.linewidth": 0.8,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.32,
        "figure.facecolor": "white",
    })


def main():
    style()
    n = len(ROWS)
    fig = plt.figure(figsize=(11.5, 14.0))
    ax = fig.add_axes([0.295, 0.130, 0.675, 0.660])
    ys = np.arange(n)
    xmax = 9.3

    ax.add_patch(Rectangle((0, BEST_RANK - 0.5), xmax, n - BEST_RANK + 0.5,
                           facecolor=BAND, edgecolor="none", zorder=0))
    ax.axhline(BEST_RANK - 0.5, color=OURS, linewidth=2.2, zorder=2)

    for y, r in zip(ys, ROWS):
        ax.barh(y, r["score"], height=0.64, color=COLOR[r["kind"]],
                edgecolor="none", zorder=3)
        ax.text(xmax - 0.08, y, f'{r["score"]:.3f}', ha="right", va="center",
                fontsize=9.6, color=TEXT[r["kind"]],
                fontweight="bold" if r["kind"] != "human" else "normal", zorder=5)


    labels = [f'{r["name"]}'
              + (f'   {r["tag"]}' if r["tag"] else "")
              + (f'   · {r["aperture"]}' if r.get("aperture") else "")
              for r in ROWS]
    ax.set_yticks(ys)
    ax.set_yticklabels(labels, fontsize=9.0)
    for t, r in zip(ax.get_yticklabels(), ROWS):
        t.set_color(TEXT[r["kind"]])
        if r["kind"] != "human":
            t.set_fontweight("bold")
    ax.tick_params(axis="y", length=0, pad=7)
    ax.tick_params(axis="x", labelsize=9, length=3, color="#C9CDD3")

    ax.set_xlim(0, xmax)
    ax.set_ylim(n - 0.5, -2.1)
    ax.set_xticks(np.arange(0, 7.6, 1.0))
    ax.set_xlabel("SongBench 均分（七维平均，满分 0–10，柱自 0 起）", fontsize=10, labelpad=9)
    ax.grid(axis="x", color="#EDEFF2", linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    ax.spines[["top", "right", "left"]].set_visible(False)


    # ---- 页眉 ----
    fig.text(0.045, 0.988, "SONGBENCH · 腾讯　—　第三方模型裁判评测，公式未改",
             fontsize=10.5, color=FAINT, ha="left", va="top")
    fig.text(0.045, 0.960,
             "一句话生成音乐：选定录音的评分分布，非排行榜",
             fontsize=21, fontweight="bold", color=INK, ha="left", va="top")
    big = fig.text(0.045, 0.884, f"{BEST['score']:.3f}", fontsize=44, fontweight="bold",
                   color=OURS, ha="left", va="baseline")
    fig.canvas.draw()                      # 先量宽度，再让 "/ 27" 与「第 1」共基线、紧贴
    x_end = fig.transFigure.inverted().transform(big.get_window_extent().get_points()[1])[0]
    fig.text(x_end + 0.024, 0.884, "/ 10 · best-of-8", fontsize=25, fontweight="bold",
             color=OURS, ha="left", va="baseline", alpha=0.45)
    if RUNNER_UP is not None:
        副标 = (f"27 首得奖曲里只有《{RUNNER_UP['name']}》（{RUNNER_UP['score']:.3f}）更高。"
                f"Eimu 最好一首 {BEST['score']:.3f}，另有 {BEAT} 首得奖曲低于它。")
    else:                                  # 已登顶
        副标 = (f"27 首得奖曲全部低于它，最高的一首《{TOP_HUMAN['name']}》为 {TOP_HUMAN['score']:.3f}，"
                f"比它低 {BEST['score'] - TOP_HUMAN['score']:.3f}。")
    副标 = "单曲、best-of-8 和臂均值混合展示，不能排名产品，也不能推断超过获奖作品。"
    fig.text(0.045, 0.861, 副标, fontsize=12.5, color="#9E5A60", ha="left", va="top")
    if PROMPT:                             # 整首歌的输入＝这一句，单独站一行
        fig.text(0.045, 0.839, f"只输入了一句提示词：「{PROMPT}」",
                 fontsize=13.5, fontweight="bold", color=OURS, ha="left", va="top")
        fig.text(0.045, 0.820, f"（同一句跑 {BEST_OVERRIDE.get('n', 8)} 次，图上取下表中最好的那一首）",
                 fontsize=9.5, color=FAINT, ha="left", va="top")

    handles = [
        Line2D([], [], color=OURS, marker="s", markersize=9, linewidth=0, label=f"Eimu — YuE2 编排（{N_DELIVERED} 首成品）"),
        Line2D([], [], color=HUMAN, marker="s", markersize=9, linewidth=0, label=f"人类得奖曲（{N_HUMAN} 首）"),
        Line2D([], [], color=OURS, linewidth=2.2, label="红线 = Eimu 最好一首"),
        Line2D([], [], color=BARE, marker="s", markersize=9, linewidth=0, label="裸模型（无 harness）"),
    ]
    fig.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.042, 0.806),
               ncol=4, frameon=False, fontsize=9.8, handletextpad=0.6,
               columnspacing=1.5)

    fig.text(0.045, 0.018,
             "评分器：腾讯 SongBench（arXiv 2604.25937）官方评测器 + 官方权重，公式一字未改；正控制曲在四批独立运行中均复现 6.9150。\n"
             f"得奖曲集合：27 首格莱美年度制作/歌曲/专辑 + 金曲奖年度歌曲 + 公认经典，1963–2025，44.1 kHz 立体声、未做响度归一。Eimu {N_DELIVERED} 首为产品实际交付成品，本次与人类批同一评分器重跑。\n"
             f"口径说明：《逆风不灭》一行取 8 次生成里最好的一首——创作起始输入为「{PROMPT}」，随后人工要求「再来N组」（8 首 mean7 7.028、sd 0.175，单次版本 6.972）。"
             f"其余 3 首为单次交付；best-of-8 与单首参考录音筛选强度不同。此处不作名次、品质优越或编排因果增益主张。\n"
             "排入口径：交付成品中《第二遍雨》为纯音乐（人声作配器使用），七维裁判的 Vocal 维对其不适用，故不入本榜（测量值保留在台账）。\n"
             "故以上是同一把尺上的相对分数，不等于「音乐价值更高」。该基准禁止商用，请勿用于商业物料。",
             fontsize=7.4, color=FAINT, ha="left", va="bottom", linespacing=1.75)

    png = OUT / "POSTER-grammy-leaderboard.png"
    pdf = OUT / "POSTER-grammy-leaderboard.pdf"
    fig.savefig(png, dpi=180)
    fig.savefig(pdf)
    print("wrote", png)
    print("wrote", pdf)
    print(f"selected best-of-8 {BEST['score']:.4f}; reference sample mean {AWRD_MEAN:.4f}; not a leaderboard")


if __name__ == "__main__":
    main()
