# B 端生图 API 设计（2026-07-26）

## 目标

把生图能力作为 OpenAI 兼容 API 上架到 API 聚合平台转售，需要一个专供 B 端的
Base URL 与独立签发的 API key。

## 关键约束

1. **聚合平台只发标准 `Authorization: Bearer`**，不会转发我方内部的 `x-user-id` 头。
   现有的 `authenticateImageUser` 同时要求两者，B 端不能直接复用它做认证。
2. **四个模型跨不同上游**：`gpt-image-2` 与 `gemini-3.1-flash-image` 走 `/admin` 配置
   的中转渠道池，`sensenova-u1-fast` 走独立密钥池，`adobe-firefly` 走 relay。
   这些编排只存在于 Next 应用里，上游 New API 并不知道怎么打 SenseNova 和 Firefly。
   → 因此 B 端层必须建在本仓库，不能直接把上游网关暴露出去。
3. `/api/generate-images` 有 128 条源码断言护着，且处于并发修改中。

## 选定方案

### 认证与计费

自建 B 端密钥表，**计费账本仍记在上游 New API**。

每个密钥绑定一个 New API 用户 id；扣费复用已有的
`reserveImageQuota` / `refundImageQuota`。不自建额度系统——那是钱的事，
现有实现经过生产验证，重造只会多一处出错的地方。

密钥格式 `sk-biz-` + 32 位十六进制。存储只留 `sha256`，明文仅在签发响应里出现一次。

存储沿用 `admin-pool-store` 已验证的模式：每次写入落到新路径名 + 修剪旧世代。
Blob 的 `cacheControlMaxAge` 下限是 60 秒，固定路径会让刚签发的密钥一分钟内校验不过。

### 为什么不抽取 `/api/generate-images` 的管线

`requestImageGeneration` 及其重试队列是路由文件的模块私有成员，而 Next 的 route
模块不允许导出任意函数。把它们抽出来会动到一个有 128 条断言护着、且正在被并发
修改的计费关键文件。

取舍：**涉及钱的部分本来就是共用 lib，不存在重复**；重复的只有上游请求与重试
队列这一段受控逻辑（约 100 行）。为防止两边悄悄走偏，
`src/app/api/v1/route.test.ts` 断言两处的超时与冷却常量必须相等。

这是一个明确的技术债，记录在此：日后 `/api/generate-images` 的源码断言改为行为
测试后，应把两份管线合并，并共享端点冷却状态。

### 分层

```
POST /v1/images/generations
  ├─ readBearerToken(Authorization)          biz-api-keys.ts     纯逻辑，可测
  ├─ authenticateBizApiKey                   biz-api-key-store.ts 查表 + 滑动窗口限流
  ├─ 入参校验（model/prompt/n/size/quality）
  ├─ reserveImageQuota(key.userId, …)        image-billing.ts    已有
  ├─ generateBizImage                        biz-image-pipeline.ts
  │    ├─ resolveBizEndpoints                复用 buildGatewayEndpointsWithPools
  │    └─ 依次尝试 + 失败冷却
  ├─ refundImageQuota（after，退未出满的部分）
  └─ 返回 OpenAI 形状
```

## 交付物

| 文件 | 作用 |
| --- | --- |
| `src/lib/biz-api-keys.ts` | 密钥生成、哈希、Bearer 解析、草稿校验、滑动窗口限流（纯逻辑） |
| `src/lib/biz-api-key-store.ts` | Blob 持久化、认证、用量缓冲落盘 |
| `src/lib/biz-image-pipeline.ts` | 端点编排、上游调用、故障转移、冷却 |
| `src/app/api/v1/images/generations/route.ts` | OpenAI 兼容生图端点 |
| `src/app/api/v1/models/route.ts` | 模型发现 |
| `src/app/api/admin/biz-keys/route.ts` | 列出 / 签发 |
| `src/app/api/admin/biz-keys/[id]/route.ts` | 修改 / 吊销 |
| `src/components/admin/AdminBizKeys.tsx` | `/admin` 的「B 端密钥」页 |
| `docs/biz-api.md` | 交给客户与聚合平台的接入文档 |

## 已知限制（文档里如实写明）

- **限流是进程内的**：多实例部署下实际放行量可能略高于名义 rpm。它拦滥用，不做
  精确配额；真正的花费上限由账户余额兜底。
- **用量计数不是账本**：攒在内存里定期落盘，实例重启会丢几条。账在 New API 的
  配额上。这样换来的是不把 Blob 写爆。
- **`n > 1` 串行出图**：并发会同时打满所有上游端点，反而更容易触发对方限流。
- 请求 `b64_json` 但上游只给 URL 时会退化为 `url` 字段，客户端需同时处理。

## 不做（YAGNI）

- 图生图 / `/v1/images/edits`：C 端有参考图上传，但聚合平台的图像转售基本只用
  文生图。等有真实需求再加。
- 独立子域 `api.tinchak0207.xyz`：先用同域跑通并上架，需要时再加 Vercel domain
  alias，路由代码不用改。
- B 端自助充值与用量报表：先用 `/admin` 手工签发与观察，验证有客户再做。

## 密钥签发的两条路径

1. **`/admin` → 「B 端密钥」页**：可视化签发，需要管理员密码。
2. **CLI**：`npm run bizkey:issue -- --label "客户名" --user-id 12`，只需要
   `BLOB_READ_WRITE_TOKEN`。管理员密码只以哈希形式存在，运维脚本与
   「密码不在手边」的场景用得上这条路。`npm run bizkey:list` 查看已签发的密钥。

两条路径共用 `biz-api-key-store` 的同一套读写逻辑，不另写一份 Blob 操作，
避免两边的记录格式走偏。

## 上线前的最后一步（未完成）

签发密钥必须绑定一个上游 New API 用户 id，消耗从该账户余额扣除。
选定做法：**新建一个专用 B 端账户**，让 B 端营收与自用额度彼此隔离，
对账清楚，客户跑量也不会吃掉自用余额。

待办：
- [ ] 在上游 New API 后台新建专用账户并充值
- [ ] `npm run bizkey:issue -- --label "<聚合平台名>" --user-id <id>`
- [ ] 用签发出的密钥跑一次真实生图，确认扣费与退款正确
      （看生产日志的 `[biz-api]` 行：requestId、模型、端点队列、出图数、扣币数）
- [ ] 把 Base URL 与密钥填进聚合平台后台
