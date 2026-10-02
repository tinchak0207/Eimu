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
├── LICENSE                 # 上游 MIT
├── UPSTREAM.md             # 本檔
├── keyless.patch           # 最小補丁（可重放，見下）
├── tenacity/               # 上游依賴（見「第三方依賴」）
└── smart_search/           # 上游 package 本體（providers/ 子包保留）
```

`PYTHONPATH=<...>/lib/smartsearch` → `python3 -m smart_search.cli` 解析得到 package。

## 第三方依賴（重要，與上游 `service.py` 的依賴盤點不同）

- **httpx**：`service.py` / `sources.py` / `config.py` / 全體 `providers/`。VPS `python3` 3.12.3 已內建
  `httpx 0.28.1`，靠系統套件即可，不需 vendor。
- **tenacity**：`providers/context7.py` 頂部 import，且 `service.py` 頂部 import 它 ⇒ **CLI 整個 import 鏈
  都需要它**，但 VPS 系統 python **沒有**（實測 `ModuleNotFoundError: No module named 'tenacity'`）。
  故把純 Python 的 `tenacity==9.1.2`（PyPI wheel `tenacity-9.1.2-py3-none-any.whl`，無額外依賴）
  解壓到本目錄 `tenacity/`，讓 PYTHONPATH 一併解析。**這是相對上游唯一新增的第三方依賴**。
- **不需要**（僅 UI/CLI 選用路徑，非本工具走的路徑）：`rich`、`pyfiglet`、`InquirerPy`。

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
