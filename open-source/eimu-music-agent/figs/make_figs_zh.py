#!/usr/bin/env python3
"""资料组图（简体中文 · 论文风）：逐曲逐维的全量拆解，不复述首图那个均值。

  ZH-1-heatmap   32 个条目 × 7 个维度的全量分数矩阵（含均分列）
  ZH-2-dimdist   七个维度各自的分布：27 首得奖曲 + Eimu 5 首落在哪一段
  ZH-3-ablation  同一题面四臂 × 七维的位移 + 逐维配对增益
  ZH-4-method    方法与可信度
"""
import csv
import json
from pathlib import Path

import numpy as np
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.lines import Line2D

ROOT = Path("/home/lenovo/Desktop/image-app")
REF = ROOT / "eval-music-human-ref-1005/RESULT-human-ref-1005.json"
HUM_DIM_JSON = ROOT / "eval-music-human-ref-1005/out-raw-gpu/result_raw.json"
TRACKS = ROOT / "eval-music-human-ref-1005/tracks.tsv"
RES = ROOT / "bench/music-bench/results"
OUT = Path(__file__).resolve().parent

DIMS = ["Melody", "Arrangement", "Musicality", "Vocal", "Instrumental", "Mixing", "Structure"]
DIM_ZH = {"Melody": "旋律", "Arrangement": "编曲", "Musicality": "音乐性", "Vocal": "人声",
          "Instrumental": "器乐", "Mixing": "混音", "Structure": "结构"}
DIM_EN = {"Melody": "Melody", "Arrangement": "Arrange", "Musicality": "Musical",
          "Vocal": "Vocal", "Instrumental": "Instrum", "Mixing": "Mixing",
          "Structure": "Struct"}

TITLES = {
    "media-1789786997478-jlm28e": "Stellar Interstice",
    "media-1789821225748-t6qbpy": "しおのメモリ",
    "agent-1790968380473": "晚飞的候鸟",
    "media-1790933922930-to5y04": "第二遍雨",
    "nifeng-bumie": "逆风不灭",
}
OURS = "#D93B4A"
HUMAN = "#9EA3AA"
BARE = "#4E79A7"
INK = "#12161C"
FAINT = "#6E737B"

CMAP = LinearSegmentedColormap.from_list(
    "sb", ["#F3F6FA", "#CFE0EE", "#9FC3DC", "#F5D9A8", "#EFA25C", "#DC6A55", "#B0202F"])


def m7(a):
    return float(np.mean([a[d] for d in DIMS]))


def load_human():
    per = json.loads(HUM_DIM_JSON.read_text())
    meta = {r["id"]: r for r in csv.DictReader(open(TRACKS), delimiter="\t")}
    out = []
    for k, v in per.items():
        m = meta.get(k, {})
        out.append(dict(label=f'{m.get("曲名", k)} - {m.get("艺人", "")}'.strip(" -"),
                        kind="hum", dim=v))
    return out


def load_eimu():
    d = json.loads((RES / "sb-delivered-chart/result_delivered-chart.json").read_text())
    tracks, override = d["tracks"], d.get("chart_override", {})
    out = []
    for k, v in tracks.items():
        stem = k.split("/")[-1].replace(".wav", "")
        ov = override.get(stem)
        dim = {**v, **ov["dims"]} if ov else v        # 图上改口径（best-of-N）
        label = f'{TITLES.get(stem, stem)} - Eimu' + (f'（{ov["label"]}）' if ov else '')
        out.append(dict(label=label, kind="eimu", dim=dim, single=v))
    return out


ROWS = load_human() + load_eimu()
for r in ROWS:
    r["mean"] = m7(r["dim"])
ROWS.sort(key=lambda r: -r["mean"])
HUM = [r for r in ROWS if r["kind"] == "hum"]
EIMU = [r for r in ROWS if r["kind"] == "eimu"]

L1 = json.loads((RES / "sb-raw-lyria-pilot/result_raw-lyria-pilot.json").read_text())
BARE_Y = json.loads((RES / "sb-armD/result_armD.json").read_text())
BFM = json.loads((RES / "sb-armB/result_armB.json").read_text())
BEAST_Y = json.loads((RES / "sb-armC/result_armC.json").read_text())
BARE_DIM = {d: float(np.mean([v[d] for v in BARE_Y.values()])) for d in DIMS}
BARE_MEAN = float(np.mean([m7(v) for v in BARE_Y.values()]))

ARM_DEF = [
    ("裸 Lyria\n无 harness", list(L1.values()), "#AEB3BA"),
    ("裸 YuE2\n无 harness", list(BARE_Y.values()), BARE),
    ("Eimu 编排 → FlowMusic\n（换通道对照）", list(BFM.values()), "#AEB3BA"),
    ("Eimu 编排 → YuE2\n（我方便道）", list(BEAST_Y.values()), OURS),
]
ARMS = [(n, v, c, {d: float(np.mean([x[d] for x in v])) for d in DIMS}) for n, v, c in ARM_DEF]

CTRL_1004 = {"Melody": 7.44, "Arrangement": 7.30, "Musicality": 5.82, "Vocal": 6.92,
             "Instrumental": 6.89, "Mixing": 6.74, "Structure": 7.29}
_DELIV = json.loads((RES / "sb-delivered-chart/result_delivered-chart.json").read_text())
ctrl_now = next(v for k, v in _DELIV["tracks"].items() if "t6qbpy" in k)
_REFD = json.loads(REF.read_text())
HUM_RAWD = _REFD["human_reference_raw"]["dim_means"]
HUM_NORM = _REFD["human_reference_norm"]["dim_means"]
BEST = max(EIMU, key=lambda r: r["mean"])
RANK = ROWS.index(BEST) + 1


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


# ==================================================== 图 1：全量分数矩阵
def fig1():
    n = len(ROWS)
    refs = [("得奖曲列均值", [float(np.mean([r["dim"][d] for r in HUM])) for d in DIMS], "#3A3F47"),
            ("裸 YuE2 基线（无 harness）", [BARE_DIM[d] for d in DIMS], BARE)]
    fig = plt.figure(figsize=(12.6, 14.6))
    ax = fig.add_axes([0.235, 0.052, 0.60, 0.848])
    axm = fig.add_axes([0.845, 0.052, 0.055, 0.848])

    vals = np.array([[r["dim"][d] for d in DIMS] for r in ROWS])
    means = np.array([r["mean"] for r in ROWS])
    block = np.ma.masked_invalid(np.vstack(
        [vals, np.full((1, len(DIMS)), np.nan), np.array([r[1] for r in refs])]))
    mblock = np.ma.masked_invalid(np.concatenate(
        [means, [np.nan], [float(np.mean(r[1])) for r in refs]]))
    lo, hi = float(block.min()) - 0.35, float(block.max()) + 0.15
    cut = hi - (hi - lo) * 0.42

    cmap = CMAP.copy()
    cmap.set_bad("white")
    ax.imshow(block, cmap=cmap, vmin=lo, vmax=hi, aspect="auto")
    axm.imshow(mblock.reshape(-1, 1), cmap=cmap, vmin=lo, vmax=hi, aspect="auto")

    for i in range(n):
        for j in range(len(DIMS)):
            v = vals[i, j]
            ax.text(j, i, f"{v:.2f}", ha="center", va="center", fontsize=7.0,
                    color="white" if v > cut else INK)
        axm.text(0, i, f"{means[i]:.2f}", ha="center", va="center", fontsize=8.0,
                 fontweight="bold", color="white" if means[i] > cut else INK)
    for k, (_, dv, _) in enumerate(refs):
        yi = n + 1 + k
        for j in range(len(DIMS)):
            v = dv[j]
            ax.text(j, yi, f"{v:.2f}", ha="center", va="center", fontsize=7.6,
                    fontweight="bold", color="white" if v > cut else INK)
        mv = float(np.mean(dv))
        axm.text(0, yi, f"{mv:.2f}", ha="center", va="center", fontsize=8.4,
                 fontweight="bold", color="white" if mv > cut else INK)

    labels = [r["label"] for r in ROWS] + ["", refs[0][0], refs[1][0]]
    ax.set_xticks(range(len(DIMS)))
    ax.set_xticklabels([f"{DIM_ZH[d]}\n{DIM_EN[d]}" for d in DIMS], fontsize=10, linespacing=1.35)
    ax.xaxis.set_ticks_position("top")
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(labels, fontsize=8.8)
    for t, r in zip(ax.get_yticklabels(), ROWS):
        t.set_color(OURS if r["kind"] == "eimu" else "#33383F")
        if r["kind"] == "eimu":
            t.set_fontweight("bold")
    for k, (_, _, c) in enumerate(refs):
        t = ax.get_yticklabels()[n + 1 + k]
        t.set_color(c)
        t.set_fontweight("bold")
    ax.tick_params(length=0, pad=6)
    ax.axhline(n - 0.5, color="#33383F", linewidth=1.6)
    axm.set_xticks([0])
    axm.set_xticklabels(["均分"], fontsize=9.5)
    axm.xaxis.set_ticks_position("top")
    axm.tick_params(length=0)
    axm.set_yticks([])
    for sp in list(ax.spines.values()) + list(axm.spines.values()):
        sp.set_visible(False)

    fig.text(0.235, 0.985, f"图 1 ｜ {len(ROWS)} 个条目 × 7 个维度的全量分数矩阵",
             fontsize=16, fontweight="bold", ha="left", va="top")
    fig.text(0.235, 0.960,
             f"按均分排序。红字行＝Eimu 交付成品（{len(EIMU)} 首），其余为 27 首格莱美 / 金曲奖得奖曲；"
             f"末两行是参照：选定录音列均值、以及不带 harness 的裸 YuE2。"
             f"选定录音的评分分布，非排行榜；Eimu 择优成品均分 {BEST['mean']:.3f}，不推断超过获奖作品。"
             f"《第二遍雨》为纯音乐（人声作配器），Vocal 维不适用，未入此集。",
             fontsize=9.4, color="#5F6368", ha="left", va="top")
    fig.text(0.235, 0.028,
             "每一格是该曲在该维度上的原始分（同一评分器、同一批口径，故随列可比、跨列不宜直接比）。"
             "右列为该曲七维均分。评分器＝腾讯 SongBench 官方评测器，正控制曲 6.9150 已复现。",
             fontsize=8.6, color=FAINT, ha="left", va="bottom")
    save(fig, "ZH-1-heatmap")


# ==================================================== 图 2：逐维分布
def fig2():
    fig = plt.figure(figsize=(16.4, 5.9))
    gs = fig.add_gridspec(1, len(DIMS), wspace=0.14, left=0.045, right=0.99,
                          top=0.715, bottom=0.16)
    rng = np.random.default_rng(5)
    for j, d in enumerate(DIMS):
        ax = fig.add_subplot(gs[0, j])
        hv = np.array([r["dim"][d] for r in HUM])
        ev = np.array([r["dim"][d] for r in EIMU])
        hj = rng.uniform(-0.30, -0.06, len(hv))
        ej = rng.uniform(0.06, 0.30, len(ev))
        ax.scatter(hj, hv, s=34, facecolor="white", edgecolor=INK, linewidth=0.6, zorder=3)
        ax.scatter(hj, hv, s=12, color=HUMAN, zorder=4)
        ax.scatter(ej, ev, s=64, color=OURS, edgecolor="white", linewidth=1.2, zorder=5)
        ax.plot([-0.44, 0.44], [BARE_DIM[d]] * 2, color=BARE, linewidth=1.5,
                dashes=(5, 3), zorder=6)
        ax.text(0.42, BARE_DIM[d] - 0.075, f"裸模型 {BARE_DIM[d]:.2f}", ha="right", va="top",
                fontsize=8.2, color=BARE)
        ax.plot([-0.34, -0.02], [hv.mean()] * 2, color="#3A3F47", linewidth=2.0, zorder=7)
        ax.plot([0.02, 0.34], [ev.mean()] * 2, color=OURS, linewidth=2.0, zorder=6)
        ax.text(-0.18, hv.mean() + 0.055, f"{hv.mean():.2f}", ha="center", va="bottom",
                fontsize=8.4, color="#3A3F47", fontweight="bold",
                bbox=dict(facecolor="white", edgecolor="none", pad=0.8, alpha=0.9))
        ax.text(0.18, ev.mean() + 0.055, f"{ev.mean():.2f}", ha="center", va="bottom",
                fontsize=8.4, color=OURS, fontweight="bold",
                bbox=dict(facecolor="white", edgecolor="none", pad=0.8, alpha=0.9))
        q = (hv < ev.mean()).mean() * 100
        ax.set_title(f"{DIM_ZH[d]}\n{DIM_EN[d]}", fontsize=10.5, pad=20, linespacing=1.35)
        ax.text(0, 8.06, f"参考样本内位置 {q:.0f}%", ha="center", va="top",
                fontsize=8.6, color=OURS)
        ax.set_ylim(4.75, 8.20)
        ax.set_xlim(-0.45, 0.45)
        ax.set_xticks([])
        ax.set_yticks(np.arange(5.0, 7.6, 0.5))
        if j == 0:
            ax.set_ylabel("维度得分", fontsize=10.5)
        else:
            ax.set_yticklabels([])
        ax.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
        ax.set_axisbelow(True)
        ax.spines[["top", "right", "bottom"]].set_visible(False)
        ax.tick_params(axis="x", length=0)

    handles = [Line2D([], [], color=HUMAN, marker="o", markersize=8, linewidth=0,
                      markeredgecolor=INK, label="27 首得奖曲（逐首）"),
               Line2D([], [], color=OURS, marker="o", markersize=8, linewidth=0,
                      label=f"Eimu {len(EIMU)} 首成品（逐首）"),
               Line2D([], [], color="#3A3F47", linewidth=2, label="组均值"),
               Line2D([], [], color=BARE, linewidth=1.5, dashes=(5, 3),
                      label="裸模型基线（无 harness）")]
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.012),
               ncol=4, frameon=False, fontsize=10.5, handletextpad=0.6, columnspacing=2.4)
    fig.text(0.045, 0.975, "图 2 ｜ 选定录音的评分分布，非排行榜：七维描述对照",
             fontsize=16, fontweight="bold", ha="left", va="top")
    fig.text(0.045, 0.888,
             f"每列是一个维度，左灰＝27 首得奖曲逐首，右红＝Eimu {len(EIMU)} 首逐首，蓝虚线＝不带 harness 的裸模型均值，"
             "纵轴 4.75–8.20 为跨维度共用刻度，可横向比高低。"
             "（《逆风不灭》该点取 8 次生成中最好的一首；纯音乐《第二遍雨》因 Vocal 维不适用未入集。）",
             fontsize=9.6, color="#5F6368", ha="left", va="top")
    save(fig, "ZH-2-dimdist")


# ==================================================== 图 3：消融逐维
def fig3():
    fig = plt.figure(figsize=(14.4, 7.4))
    gs = fig.add_gridspec(2, 1, height_ratios=[1.30, 1.0], hspace=0.85,
                          left=0.175, right=0.985, top=0.775, bottom=0.10)
    ax = fig.add_subplot(gs[0, 0])
    ax2 = fig.add_subplot(gs[1, 0])

    M = np.array([[a[3][d] for d in DIMS] for a in ARMS])
    lo, hi = M.min() - 0.20, M.max() + 0.10
    cut = hi - (hi - lo) * 0.42
    ax.imshow(M, cmap=CMAP, vmin=lo, vmax=hi, aspect="auto")
    for i in range(M.shape[0]):
        for j in range(M.shape[1]):
            v = M[i, j]
            ax.text(j, i, f"{v:.3f}", ha="center", va="center", fontsize=9.6,
                    color="white" if v > cut else INK)
    ax.set_xticks(range(len(DIMS)))
    ax.set_xticklabels([f"{DIM_ZH[d]}\n{DIM_EN[d]}" for d in DIMS], fontsize=10, linespacing=1.35)
    ax.xaxis.set_ticks_position("top")
    ax.set_yticks(range(len(ARMS)))
    ax.set_yticklabels([a[0] for a in ARMS], fontsize=10.2, linespacing=1.45)
    ax.get_yticklabels()[-1].set_color(OURS)
    ax.get_yticklabels()[-1].set_fontweight("bold")
    ax.tick_params(length=0, pad=8)
    for sp in ax.spines.values():
        sp.set_visible(False)

    delta = M[3] - M[1]
    xs = np.arange(len(DIMS))
    ax2.bar(xs, delta, width=0.56, color=OURS, edgecolor=INK, linewidth=0.9, zorder=3)
    ax2.axhline(0, color="#33383F", linewidth=1.0, zorder=4)
    for x, dv in zip(xs, delta):
        ax2.text(x, dv + (0.013 if dv >= 0 else -0.013), f"{dv:+.3f}", ha="center", va="bottom" if dv >= 0 else "top", fontsize=9.6,
                 fontweight="bold", color=INK, zorder=5)
    ax2.set_xticks(xs)
    ax2.set_xticklabels([DIM_ZH[d] for d in DIMS], fontsize=10.2)
    ax2.set_ylim(min(0, delta.min()) - 0.045, delta.max() * 1.32)
    ax2.set_ylabel("观测臂均差，非配对因果增益\n（末臂 n=7 − 裸 YuE2 n=9）", fontsize=10, linespacing=1.5)
    ax2.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(ax2, keep_left=False)
    ax2.tick_params(axis="x", length=0)

    fig.text(0.175, 0.975, "图 3 ｜ 成熟 brief 的四臂描述对照：导演层未测，样本量不齐",
             fontsize=16, fontweight="bold", ha="left", va="top")
    _am = {n.replace("\n", " "): float(np.mean([m7(x) for x in v])) for n, v, _, _ in ARMS}
    fig.text(0.175, 0.905,
             f"四条通道跑同一批 3 道题面（idx0 / idx15 / idx100）× 3 take；题面是 WildSongBench 的成熟 brief（tags + 完整歌词 + 段落标记），逐字节一致、人手发四臂。"
             f"⇒ 本次测的是「给定成熟 brief 后的执行层」，harness 的导演层（一句话→brief）未测（臂 C 的样本是同会话顺带产出的 YuE2 产物，n={len(BEAST_Y)}）。"
             f"上表为各臂七维均值，下图为 YuE2 通道上的观测臂均差：裸 YuE2 {_am['裸 YuE2 无 harness']:.3f} → Eimu 编排 {_am['Eimu 编排 → YuE2 （我方便道）']:.3f}；不据此判断一句话自主创作能力。",
             fontsize=9.3, color="#5F6368", ha="left", va="top")
    save(fig, "ZH-3-ablation")


# ==================================================== 图 4：方法与可信度
def fig4():
    fig = plt.figure(figsize=(15.4, 6.2))
    gs = fig.add_gridspec(1, 3, width_ratios=[1.0, 1.05, 1.15], wspace=0.32,
                          left=0.055, right=0.985, top=0.745, bottom=0.22)
    a1, a2, a3 = (fig.add_subplot(gs[0, i]) for i in range(3))

    now = [ctrl_now[d] for d in DIMS]
    old = [CTRL_1004[d] for d in DIMS]
    a1.plot([5.6, 7.6], [5.6, 7.6], color="#C9CDD3", linewidth=1.2, linestyle=(0, (3, 3)), zorder=1)
    a1.scatter(old, now, s=100, color=OURS, edgecolor="white", linewidth=1.4, zorder=4)
    for d, x, y in zip(DIMS, old, now):
        a1.annotate(DIM_ZH[d], (x, y), textcoords="offset points", xytext=(7, -3),
                    fontsize=8.8, color=FAINT)
    maxd = max(abs(x - y) for x, y in zip(old, now))
    a1.text(5.68, 7.52, f"最大逐维偏差 {maxd:.3f}\n均分两批同为 6.9150",
            fontsize=9.8, va="top", linespacing=1.5,
            bbox=dict(facecolor="#F4F6F8", edgecolor="none", pad=3.6))
    a1.set_xlim(5.6, 7.62)
    a1.set_ylim(5.6, 7.62)
    a1.set_xticks(np.arange(6.0, 7.7, 0.5))
    a1.set_yticks(np.arange(6.0, 7.7, 0.5))
    a1.set_xlabel("2026-10-04 记录值", fontsize=10)
    a1.set_ylabel("2026-10-05 重跑值", fontsize=10)
    a1.grid(color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(a1)
    a1.text(0.0, 1.055, "(a)  评分器稳定性", transform=a1.transAxes,
            ha="left", va="bottom", fontsize=11.5, fontweight="bold")

    for i, d in enumerate(DIMS):
        r, n = HUM_RAWD[d], HUM_NORM[d]
        a2.plot([i, i], [r, n], color="#C9CDD3", linewidth=1.6, zorder=2)
        a2.scatter([i], [r], s=88, color=HUMAN, edgecolor="white", linewidth=1.3, zorder=4)
        a2.scatter([i], [n], s=88, color="#5F6368", edgecolor="white", linewidth=1.3, zorder=4)
        a2.text(i, max(r, n) + 0.055, f"{r - n:+.3f}", ha="center", va="bottom",
                fontsize=8.2, color=FAINT)
    a2.set_xticks(np.arange(len(DIMS)))
    a2.set_xticklabels([DIM_ZH[d] for d in DIMS], fontsize=9.4)
    a2.set_ylim(5.2, 6.95)
    a2.set_xlim(-0.6, len(DIMS) - 0.4)
    a2.set_ylabel("27 首得奖曲的维度均值", fontsize=10.5, labelpad=10)
    a2.grid(axis="y", color="#EDEFF2", linewidth=0.8, zorder=0)
    debox(a2, keep_left=False)
    a2.text(0.0, 1.055, "(b)  本批响度归一的观测变化", transform=a2.transAxes,
            ha="left", va="bottom", fontsize=11.5, fontweight="bold")
    a2.text(0.0, -0.34,
            "浅＝原始 6.4048，深＝−14 LUFS 归一 6.3828（总差 0.022）\n"
            "逐维差已标在点上；本批均值变化小，不排除其他分布差异",
            transform=a2.transAxes, fontsize=9.2, va="top", linespacing=1.6,
            bbox=dict(facecolor="#F4F6F8", edgecolor="none", pad=3.6))

    a3.axis("off")
    a3.text(0.0, 1.055, "(c)  样本口径（可核对）", transform=a3.transAxes,
            ha="left", va="bottom", fontsize=11.5, fontweight="bold")
    rows = [
        ("人类正典", "27 首", "格莱美年度制作/歌曲/专辑 + 金曲奖年度歌曲 + 经典，1963–2025"),
        ("Eimu 成品", f"{len(EIMU)} 首", "产品实际交付；《逆风不灭》取 8 次生成中最优，其余单次；已剔除纯音乐 1 首"),
        ("裸模型对照", "2 首", "同一 idx0 的 2 个 take，非配对 harness 对照"),
        ("消融四臂", f"{len(L1)}/{len(BARE_Y)}/{len(BFM)}/{len(BEAST_Y)} 首", "3 道题面 × 3 take，题面逐字节一致"),
        ("输入格式", "统一", "44.1 kHz 立体声 WAV；24 kHz 单声道会令七维系统性上移"),
        ("评分器", "第三方", "腾讯 SongBench 官方 eval + 官方权重，未改动"),
        ("正控制", "6.9150", "四批独立运行复现同一分数"),
    ]
    y = 0.96
    for k, v, note in rows:
        a3.text(0.0, y, k, fontsize=10.2, fontweight="bold", color=INK, va="top")
        a3.text(0.19, y, v, fontsize=10.2, fontweight="bold", color=OURS, va="top")
        a3.text(0.44, y, note, fontsize=9.0, color=FAINT, va="top")
        y -= 0.13

    fig.text(0.055, 0.972, "图 4 ｜ 评分器重复性探针：不是效度验证",
             fontsize=16, fontweight="bold", ha="left", va="top")
    fig.text(0.055, 0.895,
             "裁判是第三方、公式未改；正控制曲在四批独立运行中给出同一个 6.9150；响度归一后分数几乎不动。"
             "成品集已剔除纯音乐《第二遍雨》（Vocal 维对其不适用）。",
             fontsize=9.8, color="#5F6368", ha="left", va="top")
    save(fig, "ZH-4-method")


if __name__ == "__main__":
    style()
    fig1()
    fig2()
    fig3()
    fig4()
