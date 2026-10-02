# 🔍 Aggregate Search (聚合搜索)

> 🚀 一站式跨平台智能聚合搜索引擎。支持 B 站、GitHub、开放网页、Reddit、Tavily AI、小红书、Telegram 等多源聚合，免登录优先、广度优先。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)

---

## ✨ 特性

- ⚡ **开箱即用**：B站（自动 WBI 逆向签名）、GitHub、Reddit 历史存档（arctic-shift）、Bing 开放网页无需任何 Key 或登录，直接可用。
- 🌐 **多源聚合**：一键并行搜索视频、代码仓、网页、Reddit 社区、私域频道与 AI 知识库。
- 🎬 **视频转文字（yt-dlp 开源方案）**：`--transcribe` 自动提取B站官方 AI 字幕/弹幕，接入 LLM 生成要点摘要（Groq 免费推理），链接直接变结构化文字。
- 📊 **Reddit 深度挖掘**：内置独立挖掘器（意图分类 / 态度极性 / 时间趋势 / 评论高频短语），适合产品调研与用户声音分析。
- 🛡️ **模块化与安全性**：所有敏感凭据与 Session 均通过环境变量或本地配置文件解耦，安全无残留。
- 📦 **轻量高效**：核心搜索基于 Python 标准库，极简并发，支持输出 Markdown 与 JSON。

---

## 平台支持概览

| 平台别名 | 平台名称 | 默认通道/协议 | 鉴权/依赖要求 |
| :--- | :--- | :--- | :--- |
| `bilibili` | **Bilibili (B站)** | 官方 API + WBI 签名 | **免登录**，支持视频、作者、发布日期 |
| `reddit` | **Reddit** | arctic-shift 历史存档 API | **免登录免 Key**，真实帖子/分数/链接 |
| `github` | **GitHub** | 官方 Search API | **免登录**（按 Star 排序） |
| `web` | **开放网页** | Bing RSS 引擎 | **免登录**，真实直接外链 |
| `tavily` | **Tavily AI 搜索** | 官方 REST API | 可选，需配置 `TAVILY_API_KEY` |
| `telegram`| **Telegram 全域** | Telethon SearchGlobal | 可选，需配置 API ID/HASH 与 Session |
| `xhs` | **小红书** | xhs-cli / Cookie | 可选，需配置本地会话 |

---

## 🚀 快速上手

### 1. 克隆与安装依赖

```bash
git clone https://github.com/tinchak0207/aggregate-search.git
cd aggregate-search

# 安装可选扩展依赖（Telegram / X 搜索支持）
pip install -r requirements.txt
```

### 2. 命令行使用

```bash
# 1. 默认聚合搜索全部平台
python3 scripts/search.py "开源大模型"

# 2. 指定搜索平台（例如：只搜 B站、Reddit 与 GitHub）
python3 scripts/search.py "Agent 框架" --platform bilibili,reddit,github

# 3. 排除特定平台
python3 scripts/search.py "深度学习" --platform all,-xhs

# 4. 机器可读 JSON 输出
python3 scripts/search.py "FastAPI 教程" --platform github,web --json

# 5. 查看支持平台列表
python3 scripts/search.py --list
```

---

## 📊 Reddit 深度挖掘（独立模式）

除聚合检索外，`scripts/reddit_miner.py` 提供完整挖掘器，基于 arctic-shift 公开历史存档（免 Key、绕开官方 API 风控）：

```bash
# 挖掘指定板块近 90 天的高分真实问题
python3 scripts/reddit_miner.py --subreddits StableDiffusion --days 90

# 痛点挖掘：谁在吐槽？附态度极性交叉表
python3 scripts/reddit_miner.py --subreddits OpenAI --days 180 --filter problem --top 50

# 作品/案例展示调研（竞品铺货、案例研究）
python3 scripts/reddit_miner.py --subreddits Midjourney --days 365 --filter showcase --top 100

# 评论区高频短语提取（用户原话 → FAQ/小标题素材）
python3 scripts/reddit_miner.py --subreddits StableDiffusion --days 180 \
    --with-comments --extract-patterns 30 --format md --out report.md
```

挖掘产出：意图分布（价格/替代/推荐/排障…）、态度分布（赞赏/吐槽/警示/求助）、意图×态度交叉表、时间趋势分桶、评论高频 n-gram 短语。

---

## 🎬 B站视频转文字 + AI 摘要（yt-dlp 开源方案）

搜索时加 `--transcribe`，B站前 3 条结果自动附视频字幕全文与 LLM 要点摘要：

```bash
python3 scripts/search.py "猫粮测评" --platform bilibili --transcribe
```

底层链路（全部开源方案，零手写解析）：
1. **yt-dlp** 提取B站官方 AI 字幕（`ai-zh`，需登录态）→ 无字幕自动降级抓弹幕（观众真实评论）→ 兜底视频简介。
2. **LLM 摘要**（`scripts/llm_summarize.py`，OpenAI 兼容协议）：
   - Groq 免费推理（默认 `openai/gpt-oss-120b`）：`export GROQ_API_KEY=gsk_...`，或自建代理 `export GROQ_PROXY_URL=http://.../openai/v1`
   - 任意 OpenAI 兼容服务：`export OPENAI_BASE_URL=... OPENAI_API_KEY=...`
   - 未配置时跳过摘要，字幕照常输出。

单视频独立使用：
```bash
python3 scripts/bilibili_transcribe.py "https://www.bilibili.com/video/BVxxxx" --summary
```

> B站字幕需登录态：本项目优先读 `state/bilibili_cookies.txt`（Netscape 格式，可用浏览器 Cookie-Editor 导出），否则自动尝试 `--cookies-from-browser chrome`。

---

## ⚙️ 高级配置 (可选平台)

如需启用 Telegram 全域搜索或 Tavily 智能搜索，可按需配置：

### 1. Tavily AI 搜索
```bash
export TAVILY_API_KEY="tvly-your-api-key"
```

### 2. Telegram 全域搜索
1. 在 [my.telegram.org](https://my.telegram.org) 获取 `api_id` 和 `api_hash`。
2. 配置环境变量或复制配置模板：
   ```bash
   cp state/telegram_creds.example.json state/telegram_creds.json
   # 编辑填入你的 api_id 和 api_hash
   ```
3. 首次运行交互式登录：
   ```bash
   python3 scripts/telegram_search.py --login
   ```

### 3. 查看环境与登录引导
```bash
python3 scripts/auth.py
```

---


## 社区支持

学 AI，上 L 站：[LinuxDO](https://linux.do/)

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
