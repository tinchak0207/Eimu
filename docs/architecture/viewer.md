# 赏阅（Viewer）— 成品预览系统架构（2026-11-04）

## 目的
生成只是半个闭环。另一半是：**看 → 评判 → 指出哪一处不对 → 回流给助理 → 再出一版**。赏阅是这条回路的唯一入口：
所有泛影音成品（图、视频、音乐、文本、3D 场景、文档、分镜、合集）都在同一套壳里被赏阅，
并共用同一个评审层——用户在成品的**具体位置**打标记，系统把标记整理成助理能逐处执行的一段话。

不是播放器，是「验收与反馈输入设备」。第三方查看器做不到：它们不知道这是第几个候选、歌词计时是真是估、
也无法把「01:08–01:29 太吵」交回 agent。

## 现状（被取代的碎片）
`ImageLightbox`、`history/HistoryLightbox`、`AgentVideoCard` 内置全屏、`AgentAudioCard`→外部静态播放器（store）、
`assets/AssetReviewPanel`、`assets/ShotReviewPanel`、OpenUI 的 ImageGallery/CompareView/VideoPlayer/AudioPlayer/AlbumPlayer 渲染。
各自一套能力，互不相通，均无「标记→助理」。

## 分层
1. **契约** `src/lib/viewer/types.ts`（已定，勿改形状；要加字段只可加可选字段并写明理由）
   - `ViewKind = DeliverableKind | text|scene3d|document|storyboard|collection`
   - `ViewAsset`（一件成品）/ `Locator`（指在哪：time|region|page|pose|span|whole）/ `Annotation` / `ViewerController` / `ViewerSurfaceProps` / `ViewerActions`
2. **评审层** `src/lib/viewer/review.ts`（已定）：各种类标签表、`describeLocator`、`composeFeedback`、本地存取。**所有种类的反馈长得一样**。
3. **适配器（每种类一个 Surface）** `src/components/viewer/adapters/<Kind>Surface.tsx`，`export default function XSurface(props: ViewerSurfaceProps)`。
   只负责：渲染该种类 + 经 `controllerRef` 发布 `capture()/reveal()`。**不负责**标签、反馈措辞、存取、全屏、动作按钮——那些在壳与评审层。
4. **壳** `src/components/viewer/`：`ViewerHost`（Provider + 全屏 portal + `useViewer().open(...)`）、`Viewer`（内嵌用）、`ReviewSheet`、`adapters/index.ts`（`Record<ViewKind, 懒加载 Surface>`——**用 Record 保证穷尽**：新增一种 ViewKind 漏适配器＝编译失败）。
5. **落点**：聊天媒体卡（inline）、全屏（取代各灯箱）、独立分享页 `/view`（深链，取代 store 静态播放器作为分享目标）、历史/画布/OpenUI 成品组件。

## 硬规矩
- **诚实**：只展示真实有的信息。无封面不占位；歌词是估算必须标「估算」；波形只在能解码时画（跨域无 CORS 就退化为朴素进度条，不造假波形）；来历（prompt/model/花费）没有就不显示。
- **回流不替用户花钱**：「发给助理」只预填输入框，不自动送出（沿用 onVariant 惯例）；无输入框的环境（独立页）退化为「复制给助理」+ `postMessage({type:"eimu-viewer:feedback"})`。
- **键盘一等公民**：空格播放/暂停、←/→ 步进（Shift 加大）、F 标记、Esc 关闭、[ ] 倍速、L 循环 A-B、0–9 跳转、?帮助。全屏壳处理 Esc/←→（切换集合成员）；适配器内部的 ←/→ 只在该种类有「时间/页」语义时使用，且全屏壳切成员用 `PageUp/PageDown` 或 `J/K` 兜底——冲突时以「种类内语义优先」。
- **触控**：目标 ≥44px，正文 ≥13px，`touch-action` 正确（拖选区/缩放不触发页面滚动）。
- **可降级**：任一适配器失败（URL 404/解码失败）显示可重试的错误态，不白屏，不影响壳与评审层。
- **inline 与 full 同源**：同一个 Surface 两种 density，不写两份。inline 只缩 chrome，不删能力入口（点开进 full）。
- 视觉：沿用 `design-system/MASTER.md` / `DESIGN.md` 与 `tailwind.config.ts` token；全屏壳为深色沉浸（参考 `ImageLightbox` 的 portal/背板语汇与 `eval-av-agent-bench/scripts/lyric-align/player/index.html` v2 的交互与观感）。
- 不写测试（项目铁律）；真路径验收由组装后统一做。

## 轮子（必须复用，不许重造）
- 音频：`eval-av-agent-bench/scripts/lyric-align/player/index.html`（v2，已验证）里的 LRC 解析、逐字高亮、估算歌词与「计时异常」识别、波形解码、A-B、倍速、Media Session——**移植成 React，不改语义**。
- 3D：`src/components/canvas/node-view/Scene3dGltfViewport.tsx`。
- Markdown：`src/components/agent-chat/AgentMarkdown.tsx`。
- 全屏/portal 语汇：`src/components/ImageLightbox.tsx`、`src/components/history/HistoryLightbox.tsx`。
- 种类真源：`src/lib/deliverable-kind.ts`。
