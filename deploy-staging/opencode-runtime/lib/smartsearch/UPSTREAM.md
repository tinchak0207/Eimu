# smart_search vendored upstream（fork + 最小 patch）

本目錄是上游 [`konbakuyomu/smartsearch`](https://github.com/konbakuyomu/smartsearch) 的**逐檔複製**，
加上一組「免 Key 通路」最小補丁。除下表白名單欄位外，所有檔案與上游逐行等價；**禁止參考重寫**，
上游更新時以本檔為唯一入口重新套補丁。

## 上游

| 項目 | 值 |
|---|---|
| repo | https://github.com/konbakuyomu/smartsearch |
| 版本 | `0.1.25` |
| commit | `916743469d8abf8d6eae300170d2bfd61fae4949` |
| license | MIT（Copyright (c) 2025 GuDaStudio，見同目錄 `LICENSE`） |
| 來源 | `/tmp/smartsearch/src/smart_search/**`（v0.1.25，shallow clone） |

## 目錄佈局

```
lib/smartsearch/
├── LICENSE                      # 上游 MIT
├── UPSTREAM.md                  # 本檔
├── keyless.patch                # 最小補丁（可重放，見下）
├── requirements-vendored.txt    # vendored 第三方清單（版本＋sha256，可重現）
├── tenacity/                    # vendored：上游依賴
├── httpx/                       # vendored：執行期 HTTP client
├── httpcore/                    # vendored：httpx 底層
├── h11/                         # vendored：httpcore 依賴
├── anyio/                       # vendored：httpx 非同步抽象
├── sniffio/                     # vendored：anyio 依賴
├── certifi/                     # vendored：CA bundle（含 cacert.pem 資料檔）
├── idna/                        # vendored：httpx URL 解析依賴
├── typing_extensions.py         # vendored：>=4.14（系統 4.10 缺 sentinel）
└── smart_search/                # 上游 package 本體（providers/ 子包保留）
```

`PYTHONPATH=<...>/lib/smartsearch` → `python3 -m smart_search.cli` 解析得到 package，
且 httpx/typing_extensions 等一律從本目錄解析（**不依賴系統 dist-packages**）。

## 第三方依賴（已全部自帶，無外部前置）

**結論：`lib/smartsearch/` 自帶它需要的所有第三方 Python 套件；VPS 重建／換機不需任何手工 pip 安裝。**

原本 `httpx` 曾被誤判為「VPS 已內建」（那是拿 `ubuntu` 身分驗的）；實際服務帳號 `agentsvc`
的 `python3` 只有系統 dist-packages 可見（工具把子進程 `HOME` 指到臨時目錄，
`~/.local` user-site 一律不可見），故 `httpx` 對服務帳號 `ModuleNotFoundError`。
同理 Debian 自帶的 `typing_extensions 4.10` 缺 `sentinel`，CLI 會 `ImportError` 退出。
**修法不是 `sudo pip install`（那只在活環境、重建即失效），而是把依賴逐檔 vendor 到本目錄。**

依賴鏈（皆為純 Python wheel，`py3-none-any`，無 .so）：

| 套件 | 版本 | 誰需要 | wheel |
|---|---|---|---|
| `httpx` | 0.28.1 | `service.py`/`sources.py`/`config.py`/全體 `providers/` | `httpx-0.28.1-py3-none-any.whl` |
| `httpcore` | 1.0.9 | httpx | `httpcore-1.0.9-py3-none-any.whl` |
| `h11` | 0.16.0 | httpcore | `h11-0.16.0-py3-none-any.whl` |
| `anyio` | 4.15.1 | httpx | `anyio-4.15.1-py3-none-any.whl` |
| `sniffio` | 1.3.1 | anyio | `sniffio-1.3.1-py3-none-any.whl` |
| `certifi` | 2026.7.22 | httpx SSL（帶 `cacert.pem` 資料檔，照收） | `certifi-2026.7.22-py3-none-any.whl` |
| `idna` | 3.20 | httpx URL 解析 | `idna-3.20-py3-none-any.whl` |
| `typing_extensions` | 4.16.0 | 上下游共用（系統 4.10 缺 `sentinel`） | `typing_extensions-4.16.0-py3-none-any.whl` |
| `tenacity` | 9.1.2 | `providers/context7.py`／`service.py` | `tenacity-9.1.2-py3-none-any.whl` |

逐檔 sha256 與重現指令見同目錄 `requirements-vendored.txt`。vendor 目錄**不進任何安裝腳本**，
只靠 `PYTHONPATH` 生效（工具已這樣做，見 `lib/smart_search_impl.ts` → `SMART_SEARCH_PACKAGE_DIR`）。
因 PYTHONPATH 在 `sys.path` 中**先於** `/usr/lib/python3/dist-packages`，vendored 版本會 shadow 系統版本。

驗證「自帶真的成立」（禁只看檔案存在；斷言解析路徑落在本目錄）：

```bash
# 1) 以 PYTHONPATH 直查解析路徑（兩者都必須是 lib/smartsearch/ 底下）
PYTHONPATH=/opt/agent-harness/workspace/.opencode/lib/smartsearch python3 -c \
  "import httpx,typing_extensions,sys;print(httpx.__file__);print(typing_extensions.__file__);print(typing_extensions.__version__)"
#   期望：.../lib/smartsearch/httpx/__init__.py、.../lib/smartsearch/typing_extensions.py、4.16.0
# 2) 只在 PYTHONPATH（禁用系統 site-packages）能跑整條 CLI import 鏈
PYTHONPATH=lib/smartsearch python3 -S -c "import smart_search.cli"
# 3) 真行為（免 Key 通路真出內容，非只看 exit 0）
PYTHONPATH=lib/smartsearch python3 -m smart_search.cli fetch https://example.com --format json
```

- **不需要 vendor**（僅 UI/CLI 選用路徑，非本工具走的路徑）：`rich`、`pyfiglet`、`InquirerPy`。

## 保留 / 排除

- **保留**：`smart_search/**` 全部（含 `providers/**` 子包、`assets/` 內 `i18n/messages.json` 等）。
- **保留（例外）**：`desktop_*.py`。任務書原本允許排除 desktop 模組，但 `cli.main()` 啟動時會呼叫
  `skill_maintenance.maintain()` → `state_directory()` → `from .desktop_cli import tools_directory`，
  排除後 `python3 -m smart_search.cli` 直接 `ModuleNotFoundError: No module named 'smart_search.desktop_cli'`。
  **以能跑起來為準**：8 個 `desktop_*.py` 全部保留（只依賴 httpx + stdlib，不引入新依賴）。
- **排除**：`.venv`、`__pycache__`、`tests/`、`desktop/`（repo 頂層的 Node/前端目錄，與 Python package 無關）。

## 最小補丁白名單（相對上游 `smart_search/service.py`）

免 Key（`JINA_API_KEY`/`FIRECRAWL_API_KEY`/`CONTEXT7_API_KEY`/`ANYSEARCH_API_KEY` 皆未設）時可跑。
所有行號指**上游原始檔**；改後行號見 `keyless.patch`。

### P1 — `_provider_configured()`：免 Key 時不視為未配置

| 上游行 | 改前 | 改後 | 為什麼 |
|---|---|---|---|
| 1204 | `return bool(config.context7_api_key)` | `return True` | Context7 匿名 `/api/v2/*` 可用；函式頂端已 `if not config.provider_enabled(provider): return False`，故「provider 啟用即算配置」。否則 `docs_search` 能力 fail closed。 |
| 1214 | `return bool(config.jina_api_key)` | `return True` | Jina Reader 匿名可用，否則 `web_fetch` 能力 fail closed。 |
| 1218 | `return bool(config.firecrawl_api_key)` | `return True` | Firecrawl 匿名搜尋/抓取可用，被 `web_fetch` 與 `web_search` 兩條鏈引用。 |
| 1222 | `return bool(config.anysearch_api_key)` | `return True` | AnySearch MCP 匿名可用，否則 `vertical_search` 無 provider。 |

### P2 — Firecrawl 呼叫端：無 key 時不早退、不送空 `Authorization`

上游行 2722-2726（`call_firecrawl_search`）：

```python
# 改前
api_key = config.firecrawl_api_key
if not api_key:
    return None
endpoint = f"{config.firecrawl_api_url.rstrip('/')}/search"
headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

# 改後
api_key = config.firecrawl_api_key or ""
endpoint = f"{config.firecrawl_api_url.rstrip('/')}/search"
headers = {"Content-Type": "application/json"}
if api_key:
    headers["Authorization"] = f"Bearer {api_key}"
```

上游行 2761-2765（`call_firecrawl_scrape`）：同上，端點 `/scrape`。

為什麼：上游 Firecrawl **任何** `Authorization`（含空 `Bearer`）一律 401；匿名則 200。
早退的 `if not api_key: return None` 會讓免 Key 通路直接失效。

### P3 — Context7 呼叫端：無 key 時不早退

上游行 4432-4439（`context7_library`）與 4454-4461（`context7_docs`），同構：

```python
# 改前
api_key = config.context7_api_key
if not api_key:
    return {"ok": False, "error_type": "config_error", "error": source_message('CONTEXT7_API_KEY 未配置。…')}
provider = Context7Provider(config.context7_base_url, api_key, config.context7_timeout)

# 改後
api_key = config.context7_api_key or ""
provider = Context7Provider(config.context7_base_url, api_key, config.context7_timeout)
```

為什麼：`Context7Provider._headers()` 本身已 `if self.api_key:` 才加標頭，傳空字串即匿名。

## 未改動（經查上游已正確，無需補丁）

- `providers/context7.py` 的 `_headers()`：`if self.api_key:` 才加 `Authorization`（已安全）。
- `providers/jina.py` 的 `fetch()`：`if self.api_key:` 才加 `Authorization`（已安全）。
- `providers/anysearch.py` 的 `list_available_domains()` / `call_tool()`：`if self.api_key:` 才加標頭（已安全）。
- 逾時、重試、路由策略、請求/回應語意：**一行未動**。

## 重新套補丁（上游更新時）

```bash
cd <本次 vendor 的 parent，即 deploy-staging/opencode-runtime/lib/smartsearch>
patch -p1 < keyless.patch      # 白名單路徑 a/smart_search/... → smart_search/...
```

`keyless.patch` 由上游 pristine 樹與本目錄 `smart_search/` 以 `diff -ruN` 產出，可 `patch -p1` 重放。
