# 冻结的音乐历史集成脚本

这里保留 11 个原先混在音频数据目录里的 image-app 实验脚本，后缀为 `.ts.txt` / `.py.txt` / `.sh.txt`，不进入站点编译。本轮未执行、未重写其正文。`MANIFEST.json` 记录原路径、长度与 SHA256，归档件逐字节与迁移前一致。

这些脚本依赖主仓的音乐 client / reducer / canvas 等内部实现，不属于独立服务或离线评分器。部分脚本会读取本机认证、启动真实会话或生成付费音频；归档不构成执行授权。

若未来确需恢复：先按 MANIFEST 校验正文，按原始相对路径恢复 `.ts`，从 image-app 根目录运行。原 `bench/music-bench`、`deploy-staging/yue2-modal` 目前为独立项目兼容链接；题面在 `bench/music-bench/suite/`，服务实物在 `deploy-staging/yue2-modal/out_local/service/runs`，历史生成件仍保留。不得把本档当当前生产启动说明。

脚本里的 `../../../../src` 导入要求原目录层级；读写数据多处以当前工作目录为根（包括 `.env.biz-key`）。未来恢复要按当时主仓契约重新核对，不能从归档完整推断当前可运行。

现役服务与离线评分器独立仓库：`/home/lenovo/Projects/eimu-audio-lab/`。
