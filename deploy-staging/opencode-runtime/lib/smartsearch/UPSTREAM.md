# smart_search vendored upstream（fork + 最小 patch）

本目录是上游 [`konbakuyomu/smartsearch`](https://github.com/konbakuyomu/smartsearch) 的**逐档复制**，
加上一组「免 Key 通路」最小补丁。除下表白名单栏位外，所有档案与上游逐行等价；**禁止参考重写**，
上游更新时以本档为唯一入口重新套补丁。

## 上游

| 项目 | 值 |
|---|---|
| repo | https://github.com/konbakuyomu/smartsearch |
| 版本 | `0.1.25` |
| commit | `916743469d8abf8d6eae300170d2bfd61fae4949` |
| license | MIT（Copyright (c) 2025 GuDaStudio，见同目录 `LICENSE`） |
| 来源 | `/tmp/smartsearch/src/smart_search/**`（v0.1.25，shallow clone） |

## 目录布局

```
lib/smartsearch/
├── LICENSE                      # 上游 MIT
├── UPSTREAM.md                  # 本档
├── keyless.patch                # 最小补丁（可重放，见下）
├── requirements-vendored.txt    # vendored 第三方清单（版本＋sha256，可重现）
├── tenacity/                    # vendored：上游依赖
├── httpx/                       # vendored：执行期 HTTP client
├── httpcore/                    # vendored：httpx 底层
├── h11/                         # vendored：httpcore 依赖
├── anyio/                       # vendored：httpx 非同步抽象
├── sniffio/                     # vendored：anyio 依赖
├── certifi/                     # vendored：CA bundle（含 cacert.pem 资料档）
├── idna/                        # vendored：httpx URL 解析依赖
├── typing_extensions.py         # vendored：>=4.14（系统 4.10 缺 sentinel）
└── smart_search/                # 上游 package 本体（providers/ 子包保留）
```

`PYTHONPATH=<...>/lib/smartsearch` → `python3 -m smart_search.cli` 解析得到 package，
且 httpx/typing_extensions 等一律从本目录解析（**不依赖系统 dist-packages**）。

## 第三方依赖（已全部自带，无外部前置）

**结论：`lib/smartsearch/` 自带它需要的所有第三方 Python 套件；VPS 重建／换机不需任何手工 pip 安装。**

原本 `httpx` 曾被误判为「VPS 已内建」（那是拿 `ubuntu` 身分验的）；实际服务帐号 `agentsvc`
的 `python3` 只有系统 dist-packages 可见（工具把子进程 `HOME` 指到临时目录，
`~/.local` user-site 一律不可见），故 `httpx` 对服务帐号 `ModuleNotFoundError`。
同理 Debian 自带的 `typing_extensions 4.10` 缺 `sentinel`，CLI 会 `ImportError` 退出。
**修法不是 `sudo pip install`（那只在活环境、重建即失效），而是把依赖逐档 vendor 到本目录。**

依赖链（皆为纯 Python wheel，`py3-none-any`，无 .so）：

| 套件 | 版本 | 谁需要 | wheel |
|---|---|---|---|
| `httpx` | 0.28.1 | `service.py`/`sources.py`/`config.py`/全体 `providers/` | `httpx-0.28.1-py3-none-any.whl` |
| `httpcore` | 1.0.9 | httpx | `httpcore-1.0.9-py3-none-any.whl` |
| `h11` | 0.16.0 | httpcore | `h11-0.16.0-py3-none-any.whl` |
| `anyio` | 4.15.1 | httpx | `anyio-4.15.1-py3-none-any.whl` |
| `sniffio` | 1.3.1 | anyio | `sniffio-1.3.1-py3-none-any.whl` |
| `certifi` | 2026.7.22 | httpx SSL（带 `cacert.pem` 资料档，照收） | `certifi-2026.7.22-py3-none-any.whl` |
| `idna` | 3.20 | httpx URL 解析 | `idna-3.20-py3-none-any.whl` |
| `typing_extensions` | 4.16.0 | 上下游共用（系统 4.10 缺 `sentinel`） | `typing_extensions-4.16.0-py3-none-any.whl` |
| `tenacity` | 9.1.2 | `providers/context7.py`／`service.py` | `tenacity-9.1.2-py3-none-any.whl` |

逐档 sha256 与重现指令见同目录 `requirements-vendored.txt`。vendor 目录**不进任何安装脚本**，
只靠 `PYTHONPATH` 生效（工具已这样做，见 `lib/smart_search_impl.ts` → `SMART_SEARCH_PACKAGE_DIR`）。
因 PYTHONPATH 在 `sys.path` 中**先于** `/usr/lib/python3/dist-packages`，vendored 版本会 shadow 系统版本。

验证「自带真的成立」（禁只看档案存在；断言解析路径落在本目录）：

```bash
# 1) 以 PYTHONPATH 直查解析路径（两者都必须是 lib/smartsearch/ 底下）
PYTHONPATH=/opt/agent-harness/workspace/.opencode/lib/smartsearch python3 -c \
  "import httpx,typing_extensions,sys;print(httpx.__file__);print(typing_extensions.__file__);print(typing_extensions.__version__)"
#   期望：.../lib/smartsearch/httpx/__init__.py、.../lib/smartsearch/typing_extensions.py、4.16.0
# 2) 只在 PYTHONPATH（禁用系统 site-packages）能跑整条 CLI import 链
PYTHONPATH=lib/smartsearch python3 -S -c "import smart_search.cli"
# 3) 真行为（免 Key 通路真出内容，非只看 exit 0）
PYTHONPATH=lib/smartsearch python3 -m smart_search.cli fetch https://example.com --format json
```

- **不需要 vendor**（仅 UI/CLI 选用路径，非本工具走的路径）：`rich`、`pyfiglet`、`InquirerPy`。

## 保留 / 排除

- **保留**：`smart_search/**` 全部（含 `providers/**` 子包、`assets/` 内 `i18n/messages.json` 等）。
- **保留（例外）**：`desktop_*.py`。任务书原本允许排除 desktop 模组，但 `cli.main()` 启动时会呼叫
  `skill_maintenance.maintain()` → `state_directory()` → `from .desktop_cli import tools_directory`，
  排除后 `python3 -m smart_search.cli` 直接 `ModuleNotFoundError: No module named 'smart_search.desktop_cli'`。
  **以能跑起来为准**：8 个 `desktop_*.py` 全部保留（只依赖 httpx + stdlib，不引入新依赖）。
- **排除**：`.venv`、`__pycache__`、`tests/`、`desktop/`（repo 顶层的 Node/前端目录，与 Python package 无关）。

## 最小补丁白名单（相对上游 `smart_search/service.py`）

免 Key（`JINA_API_KEY`/`FIRECRAWL_API_KEY`/`CONTEXT7_API_KEY`/`ANYSEARCH_API_KEY` 皆未设）时可跑。
所有行号指**上游原始档**；改后行号见 `keyless.patch`。

### P1 — `_provider_configured()`：免 Key 时不视为未配置

| 上游行 | 改前 | 改后 | 为什么 |
|---|---|---|---|
| 1204 | `return bool(config.context7_api_key)` | `return True` | Context7 匿名 `/api/v2/*` 可用；函式顶端已 `if not config.provider_enabled(provider): return False`，故「provider 启用即算配置」。否则 `docs_search` 能力 fail closed。 |
| 1214 | `return bool(config.jina_api_key)` | `return True` | Jina Reader 匿名可用，否则 `web_fetch` 能力 fail closed。 |
| 1218 | `return bool(config.firecrawl_api_key)` | `return True` | Firecrawl 匿名搜寻/抓取可用，被 `web_fetch` 与 `web_search` 两条链引用。 |
| 1222 | `return bool(config.anysearch_api_key)` | `return True` | AnySearch MCP 匿名可用，否则 `vertical_search` 无 provider。 |

### P2 — Firecrawl 呼叫端：无 key 时不早退、不送空 `Authorization`

上游行 2722-2726（`call_firecrawl_search`）：

```python
# 改前
api_key = config.firecrawl_api_key
if not api_key:
    return None
endpoint = f"{config.firecrawl_api_url.rstrip('/')}/search"
headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

# 改后
api_key = config.firecrawl_api_key or ""
endpoint = f"{config.firecrawl_api_url.rstrip('/')}/search"
headers = {"Content-Type": "application/json"}
if api_key:
    headers["Authorization"] = f"Bearer {api_key}"
```

上游行 2761-2765（`call_firecrawl_scrape`）：同上，端点 `/scrape`。

为什么：上游 Firecrawl **任何** `Authorization`（含空 `Bearer`）一律 401；匿名则 200。
早退的 `if not api_key: return None` 会让免 Key 通路直接失效。

### P3 — Context7 呼叫端：无 key 时不早退

上游行 4432-4439（`context7_library`）与 4454-4461（`context7_docs`），同构：

```python
# 改前
api_key = config.context7_api_key
if not api_key:
    return {"ok": False, "error_type": "config_error", "error": source_message('CONTEXT7_API_KEY 未配置。…')}
provider = Context7Provider(config.context7_base_url, api_key, config.context7_timeout)

# 改后
api_key = config.context7_api_key or ""
provider = Context7Provider(config.context7_base_url, api_key, config.context7_timeout)
```

为什么：`Context7Provider._headers()` 本身已 `if self.api_key:` 才加标头，传空字串即匿名。

## 未改动（经查上游已正确，无需补丁）

- `providers/context7.py` 的 `_headers()`：`if self.api_key:` 才加 `Authorization`（已安全）。
- `providers/jina.py` 的 `fetch()`：`if self.api_key:` 才加 `Authorization`（已安全）。
- `providers/anysearch.py` 的 `list_available_domains()` / `call_tool()`：`if self.api_key:` 才加标头（已安全）。
- 逾时、重试、路由策略、请求/回应语意：**一行未动**。

## 重新套补丁（上游更新时）

```bash
cd <本次 vendor 的 parent，即 deploy-staging/opencode-runtime/lib/smartsearch>
patch -p1 < keyless.patch      # 白名单路径 a/smart_search/... → smart_search/...
```

`keyless.patch` 由上游 pristine 树与本目录 `smart_search/` 以 `diff -ruN` 产出，可 `patch -p1` 重放。
