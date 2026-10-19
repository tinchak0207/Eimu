# Third-Party Notices

本仓库引入的第三方开源组件及其许可信息。

## kunpeng

- 来源：https://github.com/pengfeiqiao/kunpeng
- 版本 / commit：`872a58b`
- 许可证：MIT License，Copyright (c) 2026 Kunpeng Contributors
- 引入方式：源码逐行复制（白名单仅 import 路径改写），副本位于 `src/vendor-bridges/editor/`，随附的许可证副本见 `src/vendor-bridges/editor/LICENSE`。
- 改动记录：`vendor/kunpeng/PATCHES.md`。
- 完整许可证文本（摘自随附副本）：

```
MIT License

Copyright (c) 2026 Kunpeng Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AID (aid-server)

- 来源：https://github.com/gzxx-2025/aid-server
- 版本：`main` @ 2026-09-15 取证（v2.1.4，2026-09-14 发布）
- 许可证：MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司（另含 RuoYi-Vue 部分，MIT）
- 引入方式：数据逐字复制（原 `sql/aid-init.sql` 的 `aid_prompt_lib` 初始资料，142 条词条），
  白名单改写见副本档头注释；副本位于 `src/lib/lens-language-library.ts`。
- 改动记录：副本档头「白名单改写」段（仅三处：剔除 `cover_url`、同型同名去重一笔、新增展示层分组 label）。
- 追加引入（2026-09-15，刀 1 作品/剧集实体链）：流程步骤枚举与剧集表语义，
  来源 `CreationStepEnum.java`（`aid-interface/.../enums/`）、`createFlowStepMeta.ts`、
  `sql/aid-init.sql` 的 `aid_comic_episode` / `aid_comic_script`；
  改写见 `src/lib/creation-flow-steps.ts` 与 `src/lib/canvas/types.ts` 的 `CanvasEpisode` 档头
  （砍 AID 审核三态与 `pending_*` 字段，本站无审核队列）。
- 追加引入（2026-09-15，刀 2 分镜实体 + 21 栏位契约）：分镜 21 栏位契约（栏名与顺序逐字保留）
  与 `aid_storyboard` 表栏位语义，来源 `doc/提示词开发指南.md` §「分镜脚本与画师链路」输出栏位表、
  `sql/aid-init.sql` 的 `aid_storyboard`（21 栏 + `final_image_id`/`final_video_id`/`final_audio_id`）；
  改写见 `src/lib/storyboard-contract.ts` 档头（**剔除已废的第 22 栏 `sceneCode`**——AID v2.1.4
  同档 §开发要点 5 已明令禁输出 sceneCode，场景归属只认外层 sceneName；本站不建 shot 表，
  改挂 `CanvasNode.metadata`，即 `CanvasNodeMetadata.storyboardShot` / `.storyboardScene`）。
- 完整许可证文本：

```
MIT License

Copyright (c) 2026 光子讯息(杭州)科技有限公司
Portions Copyright (c) 2018 RuoYi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Agent Skills（随仓库分发的技能语料）

以下技能文本按上游原文收录，文件头保留来源与作者标注。除特别注明外均为 MIT License；MIT 完整文本见本文档「kunpeng」一节。

| 上游 | 许可证 | 位置 |
| --- | --- | --- |
| [jangtrinh/design-os-3d-blender](https://github.com/jangtrinh/design-os-3d-blender) | MIT | `skills/blender-agent-os/` |
| [arjun988/blender-skills](https://github.com/arjun988/blender-skills) | MIT | `skills/blender-director/` |
| [RobLe3/cc-blender-skill](https://github.com/RobLe3/cc-blender-skill) | MIT | `skills/blender-agent-os/` 中标注 RobLe3 的配方 |
| [LobzyJay/motion-design-with-claude](https://github.com/LobzyJay/motion-design-with-claude) | MIT | `skills/motion-design/` |
| [tsogjavklann/awwwards-3d](https://github.com/tsogjavklann/awwwards-3d) | MIT | `skills/web-3d-awwwards/` |
| [sunxiayi/make-blender-education-video-skill](https://github.com/sunxiayi/make-blender-education-video-skill) | MIT | `skills/make-blender-education-video/` |
| [Kappaemme-git/astra-ad-studio](https://github.com/Kappaemme-git/astra-ad-studio) | MIT | `skills/astra-ad-studio/` |
| SunoForge v3.0 | MIT | `skills/music-director/files/` |
| 南鸢 nuyoah | MIT | `deploy-staging/opencode-runtime/skills/nuyoah-*/` |
| jangtrinh img2threejs | Apache-2.0 | `skills/blender-agent-os/img2threejs/LICENSE` |

`src/vendor-bridges/editor/`、`deploy-staging/gateway/editor/`、`src/lib/openui/` 的第三方声明见上文对应小节与随附 LICENSE / THIRD_PARTY_NOTICES。
