---
name: minimax-h3
description: MiniMax H3 出片前按官方 Content IR 改写 prompt。关键帧模式用三栏；参考素材不是具体帧时用 Ref2VA 六栏。提交字符串就是这份改写。
---

# MiniMax H3

出片模型是 minimax-h3 时，提交前先读 [content-ir.md](content-ir.md)，按它改写 prompt，再调用生成。改写结果就是 `prompt` 字符串，不要再包六槽，不要再包 shot JSON。

官方原文在 `upstream/`（MiniMax-AI/MiniMax-H3 `d21241f`，2026-10-25 入库）。文件名从 `SKILL.md` 改成了 `GUIDE.md`，避免被技能扫描整份注入。方法没有改。

- 写法真源：`upstream/h3-prompt-writing/references/base-en.txt`（T2VA / I2VA / FL2VA / L2VA）、`upstream/h3-prompt-writing/references/ref-en.txt`（Ref2VA）。例子以这两份为准，content-ir.md 只留操作规则。
- 八个风格流程（极简产品广告、3D 动画短片、纸艺定格、品牌宣传、歌词字幕 MV、双人游戏开场、拼贴讲解、手绘实拍）在 `upstream/<名字>/GUIDE.md`。只在题材对上时读。它们的工具名是 MiniMax Hub 的 `hub_generate_*` 和画布节点，本平台没有这些工具。分镜和提示词留下，生成走 `image_generate` / 影片节点。

托管的 H3-Context-IR API 不在开源包里。本目录的改写就是官方要求自建的那一层。
