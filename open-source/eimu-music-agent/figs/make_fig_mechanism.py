#!/usr/bin/env python3
"""图 8 ｜ Beast Mode 底层原理（逐条对应真源实现，非示意）。

真源：src/lib/orchestrator-beast-frame.ts（闸门与注入）、music-director-persona.ts（专家白名单与
隔离铁律）、music-delegate.ts（交付物六栏）、music-tools.ts（工具内部：导演层/多 take/通道路由）。
"""
from pathlib import Path
import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

OUT = Path(__file__).resolve().parent
INK, FAINT, OURS, BARE = "#12161C", "#6E737B", "#D93B4A", "#4E79A7"
BG = ["#EEF2F7", "#FBE9EA", "#EAF2EA", "#FDF0E4", "#F2EFF7", "#EEF2F7"]


def style():
    mpl.rcParams.update({
        "font.family": ["Inter", "Noto Sans CJK SC", "DejaVu Sans"],
        "font.size": 10.5, "text.color": INK,
        "pdf.fonttype": 42, "ps.fonttype": 42,
        "savefig.bbox": "tight", "savefig.pad_inches": 0.3,
        "figure.facecolor": "white",
    })


def chip(ax, x, y, w, h, text, fc="white", tc=INK, fs=8.6):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.32,rounding_size=0.9",
                                facecolor=fc, edgecolor="#C9CDD3", linewidth=0.9))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs, color=tc)


def main():
    style()
    fig, ax = plt.subplots(figsize=(15.6, 10.2))
    fig.subplots_adjust(left=0.012, right=0.988, top=0.955, bottom=0.012)
    ax.axis("off"); ax.set_xlim(0, 100); ax.set_ylim(0, 100)

    fig.text(0.012, 0.998, "图 8 ｜ 音乐 Agent 的设计机制（源码说明，非真实任务轨迹）",
             fontsize=16.5, fontweight="bold", va="top", ha="left")
    fig.text(0.012, 0.962,
             "它不是一句提示词模板。它把主 agent 从「全能工匠」改成「导演」，把领域工作路由给带白名单工具的专家子代理，"
             "交付契约与回传隔离约束格式；实际效果须逐对话核验。",
             fontsize=10, color="#5F6368", va="top", ha="left")

    def band(y, h, i, title, sub=None):
        ax.add_patch(FancyBboxPatch((1, y), 98, h, boxstyle="round,pad=0.55,rounding_size=1.5",
                                    facecolor=BG[i], edgecolor="#C9CDD3", linewidth=1.1))
        ax.text(3.2, y + h - 2.6, title, fontsize=13, fontweight="bold", va="top")
        if sub:
            ax.text(3.2, y + h - 6.2, sub, fontsize=9.6, color="#3A3F47", va="top")

    # ① 闸门
    band(79.0, 19.0, 1, "① 野兽模式闸门 · 注入而非开关",
         "BEAST_MODE=ON 时，往主 agent 的 system prompt 头部注入下列信息：")
    chip(ax, 5, 85.0, 25.5, 4.2, "派遣手册 Orchestrator Dispatch Playbook", fs=8.4)
    chip(ax, 32.0, 85.0, 25.0, 4.2, "Expert 注册表摘要（能力断路真源）", fs=8.4)
    chip(ax, 58.5, 85.0, 17.5, 4.2, "当前状态声明", fs=8.4)
    ax.text(77.6, 87.1, "堵死「gate 可能没开」\n的保守路径", fontsize=8.2, color=FAINT,
            va="center", linespacing=1.5)
    ax.text(3.2, 83.0, "OFF → 该注入分支不追加此段　｜　手册不可读或空档 → 结构化报错 "
                       "playbook_unavailable，拒绝裸奔：假 ON 比不开更糟。",
            fontsize=9.4, color=OURS, va="top")

    # ② 导演
    band(63.0, 14.0, 2, "② 主 agent 变「导演」：本体不内联动手")
    steps = ["定位目标", "写 spec\n（验收标准·必读配方·交付契约）", "routeExpert\n路由到领域专家",
             "派遣 · 收结果", "验收"]
    for i, st in enumerate(steps):
        chip(ax, 5 + i * 17.6, 66.6, 15.6, 5.8, st, fs=8.6)
        if i < len(steps) - 1:
            ax.add_patch(FancyArrowPatch((5 + i * 17.6 + 16.0, 69.5),
                                         (5 + (i + 1) * 17.6 - 0.4, 69.5),
                                         arrowstyle="-|>", mutation_scale=12,
                                         color="#8A9099", linewidth=1.3))
    ax.text(3.2, 65.0, "路由依据是注册表里的 taskTypes 与工具表——域外工具不存在于该专家的工具面，从机制上做不了越界的事。",
            fontsize=9.4, color="#3A3F47", va="top")

    # ③ 专家
    band(48.0, 13.0, 3, "③ 领域专家子代理：白名单工具 ＋ 进专家即载配方库")
    chip(ax, 5, 50.4, 22.5, 4.4, "工具白名单 music_gen · image_quote", fs=8.4, tc=OURS)
    chip(ax, 29.5, 50.4, 25.5, 4.4, "配方库 .opencode/skills/music-director/", fs=8.4)
    chip(ax, 57.0, 50.4, 20.0, 4.4, "拿不到画图 / Blender", fs=8.4, tc=FAINT)
    ax.text(3.2, 49.2, "音乐导演不是「被叫别用」画图与 3D 工具，是它的工具表里根本没有。",
            fontsize=9.4, color="#3A3F47", va="top")

    # ④ 工具内部
    band(26.0, 20.0, 3, "④ 子会话里真正干活的一步：music_gen 工具内部")
    inner = [("六层导演层\n确定性改写题面", "genre→mood→instrumentation\n→vocal→structure→production"),
             ("多 take 采样\n按 8 条距离轴", "人声窗口 / 关键句覆盖 / 风格提示\n歌词文本 / 吻合度 / 标题 / 时长"),
             ("集合熵选优", "熵 ＝ 相异度分布熵 × 平均距离\nN≤12 穷举；N>12 贪婪 max-min"),
             ("三通道路由", "Lyria / FlowMusic / YuE2\n健康探针 ＋ 失败降级")]
    for i, (t, sub) in enumerate(inner):
        x = 5 + i * 23.4
        chip(ax, x, 36.6, 21.6, 4.6, t, fs=8.8)
        ax.text(x + 10.8, 35.6, sub, ha="center", va="top", fontsize=7.8,
                color=FAINT, linespacing=1.55)
        if i < 3:
            ax.add_patch(FancyArrowPatch((x + 21.9, 38.9), (x + 23.4 - 0.3, 38.9),
                                         arrowstyle="-|>", mutation_scale=11,
                                         color="#8A9099", linewidth=1.2))
    ax.text(3.2, 29.4, "提示词改写规则可审计；上游音乐生成仍有采样随机性，源码存在不证明每次会话执行了这些步骤。",
            fontsize=9.4, color="#3A3F47", va="top")

    # ⑤ 回传与交付契约
    band(7.0, 17.0, 4, "⑤ 回传隔离 ＋ 交付契约闸门")
    chip(ax, 5, 14.6, 30.0, 5.0, "子代理只回：交付物契约 ＋ 交付摘要 ≤500 token", fs=8.4, tc=OURS)
    chip(ax, 36.5, 14.6, 32.0, 5.0, "过程不出子代理：生成日志 / 试听中间态 / 多轮痕迹", fs=8.4)
    ax.text(70.5, 17.1, "子会话用后即删", fontsize=8.2, color=FAINT, va="center")
    ax.text(3.2, 12.8, "交付物六栏（缺一不算交付）：emotion_contract ｜ lyrics ｜ melody_notation ｜ audio_url ｜ "
                       "duration_source ｜ qc；其中 qcSignature 为必需项。",
            fontsize=9.2, color="#3A3F47", va="top")
    ax.text(3.2, 10.2, "四臂对照使用现成成熟 brief，未测一句话到设计；本图的五段机制须用真实决策与交付轨迹另行核验。",
            fontsize=9.4, color=OURS, va="top")

    fig.text(0.012, 0.006,
             "说人话：Beast Mode ＝ 把主 agent 降级成导演 ＋ 把领域工作连工具一起交给专家子代理 ＋ 用六栏交付契约和回传隔离管住产出。"
             "编排层不是「更会写提示词」，是把不可控的自由度从流程里拿掉。",
             fontsize=10.4, color=OURS, fontweight="bold", va="bottom", ha="left")
    fig.savefig(OUT / "ZH-8-mechanism.png", dpi=200)
    fig.savefig(OUT / "ZH-8-mechanism.pdf")
    print("wrote ZH-8-mechanism")


if __name__ == "__main__":
    main()
