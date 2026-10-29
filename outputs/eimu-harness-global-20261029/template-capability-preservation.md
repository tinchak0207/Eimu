# 八个复杂模板的能力去处与证据边界

现场注册表实际有13个recipe，用户提到的八个复杂模板对应下表；另有single_image、character_sheet、scene_setup、single_video、shortdrama_poster。这里以现有源码身份逐项列，不把四电影配方通过扩成八模板端到端通过。旧模板说明卡可保留研究理由与艺术要求；它们存在不代表研究/生成已执行。

| 模板 | 原位去处 | 本轮改动/保全 | 未覆盖 |
|---|---|---|---|
| feature_film | project/recipes/feature_film.ts | 原研究/剧本/分镜/生成链保留；final-candidate→双QC→publish | 实际研究与模型动态看片、真实付费整片 |
| novel_film | project/recipes/novel_film.ts | 原小说改编链保留；最终候选评审 | 复杂改编内容和真实长片 |
| shortdrama_visual | project/recipes/shortdrama_visual.ts | 原资产/连续性/多镜内容保留；最终候选评审 | 实际角色跨镜一致性、表演与声音 |
| ecom_launch | project/recipes/ecom_launch.ts | 原电商发布内容保留；最终候选评审 | 商品事实、平台适配与真用户路径 |
| novel_ip | project/recipes/novel_ip.ts | 本轮不删除原IP研究/设定/图片交付节点 | 尚未做实际全链生成验收 |
| ecom_model | project/recipes/ecom_model.ts | 本轮保留模特/商品图生成与图片包出口 | 尚未做真实商品一致性验收 |
| art_curation | project/recipes/art_curation.ts | 本轮保留策展研究/作品选择/图片出口 | 尚未做真实策展深度和材料权属验收 |
| art_style | project/recipes/art_style.ts | 本轮保留五维风格研究、参考/盲样和泛化图片产物 | 尚未做真实风格理解与泛化验收 |

四电影配方的真实store.apply_recipe拓扑与最终candidate测试已由非QC作者运行24/24；E3真实合成、MP4与两种可编辑包换手19断言通过。图片出口有九图fixture保全，不代表所有图片模板真实审美与生成完成。完整席位的研究、并发、独立评审和返工仍走原工具/调度，未切lean砍掉手艺；“完整保全”仍须后续真实委托验证。

最后候选需同时包含gateway、runtime tools/lib/plugin/exec-bridge和站点compile/decompile路由；版本接线与发布风险见release-dependencies.md。未提交、未发布、未调用付费上游。
