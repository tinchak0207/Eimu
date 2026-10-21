# 编排层（agent/）

六个文件，零依赖（仅 Node 内建 + `fetch`），可独立落位到任意目录后直接运行。

| 文件 | 职责 |
|---|---|
| `music_prompt_director.ts` | 确定性规则层。把用户意图翻成上游要的 `style` / `lyrics`，并把编曲意图压成结构化约束；不含随机性，同一输入恒等输出。 |
| `music_tools.ts` | 工具面：任务生命周期、多 take 采样与选优、通道路由、拿不到结果时的降级。 |
| `music_lyria.ts` | Lyria 通道客户端（Vertex / Generative Language）。 |
| `music_flowmusic.ts` | FlowMusic2API 通道客户端。 |
| `music_yue2.ts` | YuE2 通道客户端（自托管服务，HMAC 签名）。 |
| `music_tools_adapter.ts` | 把上面这套接到宿主运行时的适配层。 |

## 契约

三条通道客户端对外暴露同一形状：

```ts
generateTrack(input: { style: string; lyrics: string; seed?: number })
  => { ok: true; audioPath: string; receipt: Receipt }
   | { ok: false; error: string; retryable: boolean }
```

编排层只依赖这个形状，因此**换通道不改编排逻辑**——这也是我们能做「同一道题面、四条通道」
对照实验的前提。

## 环境变量

```
GEMINI_API_KEY / GEMINI_STUDIO_API_KEY   # Lyria
FLOWMUSIC2API_KEY / FLOWMUSIC_ADMIN_USER / FLOWMUSIC_ADMIN_PASSWORD
YUE2_MODAL_ENDPOINT / YUE2_HMAC_SECRET   # 自托管 YuE2（本机只跑这一路，8 GB 显存够）
GATEWAY_URL / HARNESS_API_KEY            # 宿主网关
```

## 注意

- 文件里保留了若干默认端点，指向我们自己的部署环境。自建部署请用环境变量覆盖。
- 本地自托管 YuE2 生成峰值显存约 7.1–7.4 GB，8 GB 的卡（如 RTX 4060）够用；
  但同一张卡上跑生成时**不要再跑评测**，评测器另有约 5.1 GB 峰值。
