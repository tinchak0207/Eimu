# 许可与第三方声明

## 我方代码
`agent/`、`eval/`（补丁与脚本）、`figs/`、本仓库文档 —— MIT，见 LICENSE。

## SongBench（腾讯）— 学术用途限定
评测所用的 SongBench 评测器、模型权重、提示词集合来自
[Tencent/SongBench](https://github.com/Tencent/SongBench)，其许可条款明确规定：

> You agree to use the SongBench only for academic purposes, and refrain from using it
> for any commercial or production purposes under any circumstances.

因此：

- **本仓库不重新分发 SongBench 的任何代码或权重。** `eval/eval_gpu.patch` 只是对官方
  `eval.py` 的**差分**，请自行从官方仓库获取原始文件后再应用。
- 使用本仓库的评测路径时，你同样受该学术用途限制约束。
- 由此得到的分数**不得用于任何商业宣传或产品物料**。

## 人类得奖曲音频
参考集里的 27 首录音均为受版权保护的商业发行作品。**仓库不含其音频**，
只公开曲目元数据（曲名 / 艺人 / 奖项与年份）与分数，供他人独立核对榜单排序。

## 我方成品音频（`eval/audio/`）
12 个文件均为本流水线自己生成的输出，按 MIT 提供，用于让任何人能重跑评测、核对分数：

- 4 首入榜成品的单次版本（`media-*` / `agent-*` / `逆风不灭`）
- 《逆风不灭》同一句提示词另外 7 个 take（`nifengbumie2..8.m4a`）——榜单上该曲取 best-of-8，
  这 7 个文件是那 8 次生成的其余部分，缺了就无法复现榜首那个数字
- 《第二遍雨》为纯音乐，已按口径排除出榜，音频与分数一并保留以备复核

## 模型与上游
生成所用的上游模型服务、编排层调用的语言模型均为第三方服务，各自适用其自身条款；
本仓库不含任何密钥，全部通过环境变量注入。
