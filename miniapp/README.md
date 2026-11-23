# Eimu 微信小程序（miniapp）

Eimu 的微信小程序客户端：以 Agent 聊天页为唯一入口（无 tabBar），另有直接生成、生成历史、
我的资产、帐号、详情、模板与定价（web-view）页。Taro 4.3.0 + React 18 + TypeScript，直接对接网页版
（`https://eimu.dev`）同一套生产后端。它不是网页版的套壳 web-view，而是逐层搬网页版手机端
UI 与 Agent 交互的原生小程序渲染。本目录自包含，不引用仓库其他目录的源码。

## 前置条件

| 需要 | 说明 |
| --- | --- |
| Node | >= 18；本仓库实测 **Node 24.19.0** 构建通过 |
| 微信开发者工具 | Linux 用**社区版**（`wechat-devtools`），需在 设置 → 安全设置 开启「服务端口」才能用 CLI |
| AppID | 测试号 `wx36c17af50b441f2d`（已写进 `project.config.json`，可公开） |

`project.config.json` 里 `"miniprogramRoot": "dist/"`，所以开发者工具要导入的是 **`miniapp/` 目录**，
不是 `miniapp/dist/`。

## 只想在开发者工具里打开（不改代码）

Taro 的产物必须先构建出来，**开发者工具不会替你跑 npm 或编译源码**：`dist/` 缺失时导入会因为
`app.json` 无法解析直接失败（devtools 报 `GENERIC_ERROR (code 10)`）。

所以分两种情况：

- **拿到的是带 `dist/` 的发布包（`eimu-miniapp.tar.gz`）**：解压 → 开发者工具导入 `miniapp/` →
  直接就能编译运行，**不需要 npm 和 Node**。适合给别人看效果、或没有前端工具链的机器。
- **拿到的是不带 `dist/` 的源码快照 / git clone**：必须先走下面「5 步上手」的前 3 步（`npm ci` +
  `npm run build:weapp`）再导入。

改过源码之后也一样：`dist/` 是构建产物，源码改动不重建就不会进开发者工具。

## 5 步上手

```bash
cd miniapp
npm ci                     # 1. 严格按 package-lock.json 装依赖
cp .env.example .env       # 2. 生成环境配置（不改也能跑，默认就是生产域名）
npm run build:weapp        # 3. 构建，产物在 miniapp/dist
```

4. 微信开发者工具 → 导入项目 → 目录选 `miniapp/`（appid 用测试号）。
5. 真机预览：工具栏「真机调试」扫码，手机微信里点右上角 `···` → **打开调试**（见下节）。

`npm ci` 而不是 `npm install`：lockfile 是依赖树唯一真源，`npm ci` 会严格按它安装并在
lockfile 与 `package.json` 不一致时直接失败；`npm install` 可能悄悄升级并把别人的 lockfile 改脏。

### 环境变量

`config/env.js`（零依赖，不引入 dotenv）先读 `miniapp/.env`，再让真实 `process.env` 覆盖，
最后在 `config/index.ts` 里用 `defineConstants` 把这些值**编译期**注入（小程序运行时没有
`process.env`）。不建 `.env` 时全部走默认值，所以干净环境不改配置也能构建。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `TARO_APP_API_BASE_URL` | `https://image.tinchak0207.xyz` | 主 API 域名 |
| `TARO_APP_AGENT_ORIGIN` | `https://store.tinchak0207.xyz` | Agent 上传/媒体票据域名 |
| `TARO_APP_WEB_ORIGIN` | `https://eimu.dev` | 定价页 web-view |

`.env` 已被 `.gitignore` 忽略；`.env.example` 必须保留可提交。

## 真机必做：打开调试

测试号无法配置业务域名与服务器域名白名单，所以**真机上必须**在小程序内点右上角 `···` →
「打开调试」（开发调试模式），否则第一条请求就会报
`url not in domain list`（`image.tinchak0207.xyz` / `store.tinchak0207.xyz` 都不在白名单里）。

开发者工具模拟器内不受影响：`project.config.json` 已设 `"urlCheck": false`。
「预览」码能打开页面，但网络请求仍按域名白名单校验，真机跑通请用「真机调试」或打开调试。

## AppSecret 与后端配置

小程序 AppSecret **不在本仓库、不在任何提交里**，需要向项目维护者索取；它只配置在服务端
（Vercel → Environment Variables，Sensitive 类型），绝不写入小程序端或本地 `.env`。

服务端需要三个变量：

| 变量 | 作用 |
| --- | --- |
| `WX_MINIPROGRAM_APPID` | 小程序 AppID |
| `WX_MINIPROGRAM_SECRET` | 小程序 AppSecret（`sns/jscode2session` 用） |
| `WECHAT_CALLBACK_SECRET` | 复用网页版微信登录链路的上游建号/登录密钥 |

## 后端登录链路

```
Taro.login() → code
  → POST /api/auth/wechat-mini/login   { code }
  → 服务端调微信 jscode2session 换 openid
  → 复用网页版 loginWechatPeer 建号/登录
  → 返回 { success, isNewUser, token, user }
```

- 返回 **HTTP 503 `{ success:false, message:"not_configured" }`** ＝ 服务端没配上面三个变量。
- 无效 code 会返回 `{ success:false, message:"wechat_login_failed", errcode:40029 }`；
  40029 说明 appid/secret 本身有效（配错是 40013 / 40125）。

## 接口契约（最容易踩错的几条）

- 网页/小程序用户走 **`POST /api/generation-jobs`**。`/api/v1/*` 是 B 端 API key 通道，
  网页用户 token 打过去无效。
- 用户态请求头必须**成对**：`Authorization: Bearer <token>` + `x-user-id: <数字 id>`，缺一即 401。
- 登录成功后**必须**调一次 `GET /api/auth/me` 触发新人礼；否则新账号 `quota = 0`，第一次生成直接 402。
- 历史与收藏用 `/api/history`：列表参数 `cursor` / `keyword` / `modelId` / `imageSize` /
  `starred` / `withImage` / `since` / `until` / `facets`；`PATCH { starred }` 改收藏；
  `DELETE { ids }` 或 `{ all: true }` 删除。

## 目录结构（六层地图）

| 层 | 位置 |
| --- | --- |
| 传输（SSE 分帧/续传/轮询降级、消息与会话 CRUD） | `src/lib/agent.ts` |
| 状态（归一、快照、设置、流式合批） | `src/lib/agent-history-normalize.ts`、`agent-persistence.ts`、`agent-settings.ts`、`agent-frame-batch.ts` |
| 输入 | `src/components/agent-chat/AgentComposer*`（menus / send-pipeline / interaction / attachments / upload-limits / placeholder / local-file-mode） |
| 渲染 | `src/lib/agent-markdown.ts` + `AgentMessageBubble` / `AgentToolCard` / `AgentImageCard` |
| 会话 | `src/components/agent-chat/AgentSessionList.tsx` |
| 资源（历史/收藏/导出） | `src/lib/history.ts` |
| 请求封装（头注入、超时、ApiError） | `src/lib/request.ts` |

页面入口在 `src/app.config.ts`，共 7 个页面、无 tabBar，首屏是 `pages/agent/index`
（Agent 聊天，自绘顶栏）。其余页面分两类：顶栏汉堡抽屉内页 `pages/index/index`（直接生成）、
`pages/works/index`（生成历史）、`pages/mine/index`（帐号），以及从列表或入口点入的
`pages/detail/index/index`（详情）、`pages/templates/index/index`（模板，从直接生成进入）、
`pages/pricing/index`（web-view 定价，保留可用但不在抽屉里）。
抽屉第三项「我的资产」不是独立路由——与网页版一致，它是 Agent 页上的浮层：抽屉触发
`onOpenAssets` → `pages/agent/index` 递增 `assetsSignal` → `AgentChatSurface` 打开面板并拉
`/api/assets`，全程留在聊天页。
图标是 `src/assets/icons/` 下的 74 个 PNG，无外部资源依赖。

## 构建产物

`dist/` 才是微信开发者工具真正打开的东西。改完代码必须重新构建，或在开发时用 watch：

```bash
npm run dev:weapp     # = taro build --type weapp --watch
```

## 已知差异

- director 的 3D 分镜视口只留同尺寸占位（小程序无 WebGL 管线），完整效果需网页版。
- 生成中的粒子 canvas 换成同版式进度条。
- Radix 下拉菜单换成底部浮层。

## 排障

**改了没生效 / 诡异报错 `n[e] is not a function`**：几乎都是开发者工具在跑旧 chunk，
不是代码错。`rm -rf dist` 后全量重建，再在开发者工具里重新导入或重编译：

```bash
rm -rf dist && npm run build:weapp
```

**真机第一条请求报 `url not in domain list`**：没打开调试模式，见上文「真机必做」。

## 附：构建配置要点

- Node 版本不兼容时可用 `npx -y node@20 ./node_modules/.bin/taro build --type weapp` 临时降级构建，
  功能不需要任何降级。
- Taro 的 `pxtransform` 被**关闭**：Tailwind 的 rem 已在 postcss 阶段转成 px（见
  `postcss.config.js`），再让 pxtransform 转 rpx 会让 1px 描边变 2rpx、字号随屏宽漂移，
  破坏与网页版手机端「固定 CSS px」的逐像素对齐。`designWidth: 375` 只影响未走 Tailwind 的样式。
- 类名转义依赖 `weapp-tailwindcss`：`postcss.config.js` 生成/转换 CSS，
  `config/index.ts` 的 `UnifiedWebpackPluginV5` 同步 JSX 里的 class 字串，两边必须成对存在。
