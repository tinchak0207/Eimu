# Contributing

感谢你愿意改进 Eimu。

## 开发环境

```bash
npm install
npm run dev        # Next.js 开发服务器
npm run lint
npm test           # 仓库内既有测试；不是交付闸门
```

更完整的部署说明见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。

## 提交前

- 不要提交任何凭据、Cookie、Token、私钥或真实账号信息。
- 新增配置项必须同时更新 `.env.example` 与相关文档。
- 数据库变更必须新增迁移文件，不要修改已发布的迁移。
- 涉及生成、计费、取消与退款的改动，请说明：幂等键、失败分类、对账路径分别如何被覆盖。
- 涉及画布或工作流 DSL 的改动，请说明 world1/world2 的边界是否仍然成立。

## 代码风格

- 跟随周边代码的风格与命名，不引入无关重构。
- 注释只解释代码无法表达的约束，不写变更日志。
- 客户端可达代码不得出现内部渠道标识或任何密钥。

## 许可

提交即表示你同意以 [AGPL-3.0](LICENSE) 许可你的贡献。

## 安全问题

请不要用公开 issue 报告漏洞，见 [SECURITY.md](SECURITY.md)。
