#!/usr/bin/env python3
"""深度评测图（简体中文）：评测过程与统计细节，不复述主结果。

  ZH-5-process   评测流程与每一道的守门件（正控制锚点、格式、档位等价）
  ZH-6-variance  采样方差 + 配对差的自助法置信区间（诚实交代 n 小）
  ZH-7-profile   四条通道相对「得奖曲分布」的逐维标准化画像
"""
import csv
import json
from pathlib import Path

import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from matplotlib.lines import Line2D

ROOT = Path("/home/lenovo/Desktop/image-app")
RES = ROOT / "bench/music-bench/results"
OUT = Path(__file__).resolve().parent

DIMS = ["Melody", "Arrangement", "Musicality", "Vocal", "Instrumental", "Mixing", "Structure"]
DIM_ZH = {"Melody": "旋律", "Arrangement": "编曲", "Musicality": "音乐性", "Vocal": "人声",
          "Instrumental": "器乐", "Mixing": "混音", "Structure": "结构"}

OURS = "#D93B4A"
BARE = "#4E79A7"
OTHER = "#AEB3BA"
INK = "#12161C"
FAINT = "#6E737B"
BOX = "#F4F6F8"


def m7(v):
    return float(np.mean([v[d] for d in DIMS]))


HUM = json.loads((ROOT / "eval-music-human-ref-1005/out-raw-gpu/result_raw.json").read_text())
L1 = json.loads((RES / "sb-raw-lyria-pilot/result_raw-lyria-pilot.json").read_text())
BY = json.loads((RES / "sb-armD/result_armD.json").read_text())
BF = json.loads((RES / "sb-armB/result_armB.json").read_text())
BY2 = json.loads((RES / "sb-armC/result_armC.json").read_text())

sub = lambda d, p: [v for k, v in d.items() if k.startswith(p)]
ARMS = [("裸 Lyria\n（无 harness）", list(L1.values()), OTHER),
        ("裸 YuE2\n（无 harness）", list(BY.values()), BARE),
        ("Eimu 编排\n→ FlowMusic", list(BF.values()), OTHER),
        ("Eimu 编排\n→ YuE2", list(BY2.values()), OURS)]


def style():
    mpl.rcParams.update({
        "font.family": ["Inter", "Noto Sans CJK SC", "DejaVu Sans"],
        "font.size": 10.5, "text.color": INK,
        "axes.edgecolor": "#C9CDD3", "axes.linewidth": 0.9,
        "axes.labelcolor": INK, "xtick.color": "#4A4F57", "ytick.color": "#4A4F57",
        "pdf.fonttype": 42, "ps.fonttype": 42,
        "savefig.bbox": "tight", "savefig.pad_inches": 0.28,
        "figure.facecolor": "white",
    })


def debox(ax, keep_left=True):
    ax.spines[["top", "right"]].set_visible(False)
    if not keep_left:
        ax.spines["left"].set_visible(False)
        ax.tick_params(axis="y", length=0)
    ax.set_axisbelow(True)


def save(fig, name):
    fig.savefig(OUT / f"{name}.png", dpi=200)
    fig.savefig(OUT / f"{name}.pdf")
    print("wrote", name)


# ==================================================== 图 5：评测流程与守门件
def fig5():
    fig, ax = plt.subplots(figsize=(15.0, 6.4))
    fig.subplots_adjust(left=0.02, right=0.98, top=0.80, bottom=0.05)
    ax.axis("off")
    ax.set_xlim(0, 104)
    ax.set_ylim(0, 46)

    steps = [
        ("① 题面", "3 道成熟 brief，四条通道\n同题输入一致\n导演层未测", "#EEF2F7"),
        ("② 生成", "裸 Lyria / 裸 YuE2\nEimu→FlowMusic / Eimu→YuE2\n逐 take 落盘，样本量不齐", "#EEF2F7"),
        ("③ 格式统一", "44.1 kHz 立体声 WAV\n（24 kHz 单声道会让七维\n系统性上移 +0.1）", "#FDF0E4"),
        ("④ 正控制", "控制曲先跑\n必须命中 6.9150\n对不上则不采信后续", "#FBE9EA"),
        ("⑤ 官方评分器", "Tencent SongBench 官方 eval\n+ 官方权重，公式未改\nmem_level 1 / 4：仅控制曲近似", "#FDF0E4"),
        ("⑥ 汇总", "七维均值 → 总均分\n与我方落盘分数对照", "#EEF2F7"),
    ]
    w, gap = 14.0, 3.2
    x0 = 1.0
    for i, (t, body, col) in enumerate(steps):
        x = x0 + i * (w + gap)
        ax.add_patch(FancyBboxPatch((x, 12), w, 22, boxstyle="round,pad=0.6,rounding_size=1.4",
                                    facecolor=col, edgecolor="#C9CDD3", linewidth=1.0))
        ax.text(x + w / 2, 30.5, t, ha="center", va="center", fontsize=12.5, fontweight="bold")
        ax.text(x + w / 2, 22.5, body, ha="center", va="center", fontsize=8.8,
                color="#3A3F47", linespacing=1.65)
        if i < len(steps) - 1:
            ax.add_patch(FancyArrowPatch((x + w + 0.4, 23), (x + w + gap - 0.4, 23),
                                         arrowstyle="-|>", mutation_scale=13,
                                         color="#8A9099", linewidth=1.4))

    ax.annotate("", xy=(x0 + 3 * (w + gap) + w / 2, 36.4), xytext=(x0 + 5 * (w + gap) + w / 2, 36.4),
                arrowprops=dict(arrowstyle="-", color=OURS, linewidth=1.6,
                                linestyle=(0, (4, 2.6))))
    ax.text(x0 + 4 * (w + gap) + w / 2, 37.6, "控制曲复现仅支持评分器稳定；不能证明人类录音与生成录音同分布",
            ha="center", va="bottom", fontsize=9.4, color=OURS, fontweight="bold")

    ax.text(1.0, 42.5, "图 5 ｜ 感知分数的处理流程：评分探针不等于自主任务验收",
            fontsize=16, fontweight="bold", va="top")
    ax.text(1.0, 8.6,
            "三个守门件是硬闸：① 格式（错格式分数系统性偏移）；② 正控制曲复现 6.9150（评分器漂移的探针）；"
            "③ 降内存档仅在控制曲上逐维近似，不能推断所有录音等价。上述探针不验证需求遵循或音乐效度。\n"
            "这套流程的可复现版本见 open-source/eimu-music-agent/eval/：install.sh → run.sh 两条命令。",
            fontsize=9.4, color="#5F6368", va="top", linespacing=1.8)
    save(fig, "ZH-5-process")


# ==================================================== 图 6：采样方差与自助区间
def fig6():
    fig = plt.figure(figsize=(15.0, 6.2))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.0, 1.1], wspace=0.24,
                          left=0.055, right=0.985, top=0.755, bottom=0.155)
    a1, a2 = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])

    # (a) 逐 take 离散
    for i, (name, vs, c) in enumerate(ARMS):
        vals = [m7(v) for v in vs]
        rng = np.random.default_rng(20 + i)
        a1.scatter(i + rng.uniform(-0.16, 0.16, len(vals)), vals, s=76, color=c,
                   edgecolor="white", linewidth=1.2, zorder=5)
        mu = float(np.mean(vals))
        a1.plot([i - 0.30, i + 0.30], [mu, mu], color=c, linewidth=2.4, zorder=4)
        lo, hi = min(vals), max(vals)
        a1.text(i + 0.34, mu, f"均 {mu:.3f}\n极差 {hi - lo:.3f}", va="center", ha="left",
                fontsize=8.4, color=c, fontweight="bold", linespacing=1.5)
    a1.set_xticks(range(len(ARMS)))
    a1.set_xticklabels([a[0] for a in ARMS], fontsize=9.8, linespacing=1.5)
    a1.set_xlim(-0.55, len(ARMS) + 0.42)
    a1.set_ylim(6.10, 7.42)
    a1.set_yticks(np.arange(6.1, 7.5, 0.2))
    a1.set_ylabel("SongBench 均分", fontsize=10.5)
    a1.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(a1, keep_left=False)
    a1.set_title("(a)  跨 3 题的 take 池分布：n=7–9，池极差 0.44–1.07",
                 fontsize=11.5, fontweight="bold", pad=12)

    # (b) 自助法
    rng = np.random.default_rng(7)
    base = [m7(v) for v in ARMS[1][1]]
    ours = [m7(v) for v in ARMS[3][1]]
    boot = np.array([np.mean(rng.choice(ours, len(ours), replace=True)) -
                     np.mean(rng.choice(base, len(base), replace=True)) for _ in range(20000)])
    lo, hi = np.percentile(boot, [2.5, 97.5])
    obs = float(np.mean(ours) - np.mean(base))
    a2.hist(boot, bins=60, color="#CFE0EE", edgecolor="white", linewidth=0.5, zorder=3)
    a2.axvline(obs, color=OURS, linewidth=2.4, zorder=5)
    a2.axvline(0, color="#33383F", linewidth=1.4, zorder=5)
    a2.plot([lo, hi], [0, 0], color=INK, linewidth=3.2, solid_capstyle="butt", zorder=6)
    for x, lab in ((lo, f"{lo:+.3f}"), (hi, f"{hi:+.3f}")):
        a2.text(x, -a2.get_ylim()[1] * 0.055 if False else 0, lab, ha="center", va="top",
                fontsize=9.4, fontweight="bold", color=INK)
    a2.annotate(f"观测差 {obs:+.3f}", xy=(obs, 0), xytext=(obs, a2.get_ylim()[1] * 0.05),
                ha="center", va="bottom", fontsize=11, fontweight="bold", color=OURS,
                bbox=dict(facecolor="white", edgecolor="none", pad=1.6, alpha=0.9))
    a2.text(0.02, 0.96, f"池均差自助分位区间：{lo:+.3f} ~ {hi:+.3f}\n"
                        f"take 非配对、未按3个题目聚类；仅描述性探针",
            transform=a2.transAxes, fontsize=9.8, va="top", linespacing=1.7, color=INK,
            bbox=dict(facecolor=BOX, edgecolor="none", pad=4.0))
    a2.set_xlabel("Eimu 编排 → YuE2  −  裸 YuE2 （均分差）", fontsize=10.5)
    a2.set_ylabel("自助样本数", fontsize=10.5)
    a2.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(a2, keep_left=False)
    a2.set_title(f"(b)  take 层池均差 {obs:+.3f}：自助抽样 20 000 次",
                 fontsize=11.5, fontweight="bold", pad=12)

    fig.text(0.055, 0.975, "图 6 ｜ 跨 3 题的 take 观测分布：非单题采样方差",
             fontsize=16, fontweight="bold", ha="left", va="top")
    fig.text(0.055, 0.895,
             "同一通道跨 3 题的 take 池极差为 0.44–1.07 分，混合了题间差异与题内采样，不能读成纯采样噪声。"
             "右图按take池均值抽样，n=7/9、未按题目聚类，不是配对因果估计；不能据此判断自主创作价值。",
             fontsize=9.6, color="#5F6368", ha="left", va="top")
    save(fig, "ZH-6-variance")


# ==================================================== 图 7：相对得奖曲分布的标准化画像
def fig7():
    mu = {d: float(np.mean([v[d] for v in HUM.values()])) for d in DIMS}
    sd = {d: float(np.std([v[d] for v in HUM.values()], ddof=1)) for d in DIMS}

    fig, ax = plt.subplots(figsize=(13.2, 6.2))
    fig.subplots_adjust(left=0.075, right=0.985, top=0.775, bottom=0.20)
    xs = np.arange(len(DIMS))
    ax.axhline(0, color="#33383F", linewidth=1.4, zorder=2)
    ax.axhspan(-1, 1, color="#EDEFF2", alpha=0.55, zorder=0)
    ax.text(-0.58, 1.0, "27 首参考录音 ±1 样本标准差", fontsize=9.2, color=FAINT, va="bottom")

    for name, vs, c, lw in [a[:3] + (2.6 if a[2] == OURS else 1.9,) for a in ARMS]:
        ys = [float(np.mean([(v[d] - mu[d]) / sd[d] for v in vs])) for d in DIMS]
        ax.plot(xs, ys, marker="o", markersize=8.5, color=c, linewidth=lw,
                markeredgecolor="white", markeredgewidth=1.4, zorder=4,
                label=name.replace("\n", ""))

    ax.set_xticks(xs)
    ax.set_xticklabels([f"{DIM_ZH[d]}\n{d}" for d in DIMS], fontsize=10, linespacing=1.45)
    ax.set_ylim(-1.6, 1.5)
    ax.set_yticks(np.arange(-1.5, 1.6, 0.5))
    ax.set_ylabel("相对得奖曲分布的标准差（z 分数）", fontsize=10.5)
    ax.set_xlim(-0.6, len(DIMS) - 0.4)
    ax.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(ax)
    ax.legend(loc="lower right", frameon=False, fontsize=10.2, ncol=2,
              handletextpad=0.6, columnspacing=1.6)
    ax.set_xlabel("每维按 27 首得奖曲的均值/标准差标准化：0＝得奖曲平均水平", fontsize=10, labelpad=12)

    fig.text(0.075, 0.975, "图 7 ｜ 四条通道相对「得奖曲分布」的逐维画像",
             fontsize=16, fontweight="bold", ha="left", va="top")
    fig.text(0.075, 0.9,
             "纵轴按选取的 27 首参考录音标准化，仅描述这批样本内的相对位置；它们不是人类音乐的随机代表样本。"
             "灰带是 ±1 样本标准差，不是置信区间或显著性界限。",
             fontsize=9.6, color="#5F6368", ha="left", va="top")
    save(fig, "ZH-7-profile")


if __name__ == "__main__":
    style()
    fig5()
    fig6()
    fig7()
