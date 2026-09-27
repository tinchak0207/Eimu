"use client";

// CanvasNodeCreateMenu —— 新建節點小型 popover（雙擊空白 / 拉線到空白處彈出）。
//
// 只管「開在哪、怎麼關、入口有幾個」：文本節點、空白圖片節點、提示詞節點、
// 上傳圖片、上傳參考圖、導入 3D 模型（各自內藏 hidden file input，選檔後回調
// 並自動關閉）；建立語義由呼叫端接手。標題列可換文案（如「连接到新节点」）。
//
// 2026-09-27 追加「连接 Blender」：這是一條**非建立型**入口（不建節點，而是把
// 桌面 Blender 接到畫布），所以它不呼叫任何 props，只在同一個 popover 內切到
// 「连接 Blender」視圖：呼叫鑄碼端點 `/api/canvas/scene-3d/link` → 顯示一次性
// 連接碼（可複製）與到期時間。切視圖而不是另開對話框的原因：畫布容器帶 CSS
// transform，`position: fixed` 的浮層會被 transform 祖先「就地困住」；
// 留在既有 popover 的座標系裡最穩，也不必讓呼叫端多接一組 props。
//
// 定位：position = 相對畫布容器左上的座標；useLayoutEffect 量測實際尺寸
// 後，超出容器右 / 下緣就翻轉到另一側 —— paint 前完成，首幀即最終位置。
// 關閉：Escape / 點選單外（window pointerdown capture，先於畫布手勢）。
// 根節點帶 data-canvas-interactive，InfiniteCanvas 手勢層放行選單內事件。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Box, Boxes, ImageIcon, Sparkles, Type, Upload } from "lucide-react";
import { MAX_SCENE_3D_BYTES, SCENE_3D_ACCEPT, SCENE_3D_SIZE_HINT } from "@/lib/canvas/scene-3d-import";
import { authHeaders } from "@/lib/canvas/client";

export type CanvasCreateMenuKind = "text" | "image" | "prompt";

export interface CanvasNodeCreateMenuProps {
  open: boolean;
  /** 相對畫布容器的座標 */
  position: { x: number; y: number };
  onClose: () => void;
  /** type: "text" | "image"（空節點）| "prompt"（提示詞備忘節點） */
  onCreate: (type: CanvasCreateMenuKind) => void;
  /** 用戶選了本地圖片檔；kind="reference" 表示建成帶角色的參考圖節點 */
  onUploadFiles: (files: File[], kind?: "image" | "reference") => void;
  /** 用戶選了本地 3D 模型檔（.glb/.gltf）→ 建 3D 場景卡節點（導入通道由呼叫端接）。 */
  onImportScene3d?: (file: File) => void;
  /** 標題列說明（如「新建节点」/「连接到新节点」），預設「新建节点」 */
  title?: string;
}

/** 選單項目統一皮膚（≥36px 熱區 + hover 態）。 */
const ITEM_CLASS =
  "flex min-h-[36px] w-full items-center gap-2 rounded-lg px-3 text-left text-ios-footnote text-foreground transition-colors hover:bg-black/5";

/** 碼區塊內的小按鈕（複製 / 重試 / 返回）：h-7 與畫布其它小按鈕同高。 */
const SMALL_BUTTON_CLASS =
  "flex h-7 shrink-0 items-center gap-1 rounded-md bg-black/5 px-2 text-ios-caption1 font-medium text-foreground transition-colors hover:bg-black/10";

/** 鑄碼端點回應（只取用得到的欄位；其餘不信任）。 */
interface Scene3dLinkResponse {
  code?: unknown;
  expires_in_ms?: unknown;
  error?: unknown;
}

/** 連接碼視圖的狀態機（loading → ready / error）。 */
interface Scene3dLinkState {
  status: "loading" | "ready" | "error";
  code?: string;
  expiresAt?: number;
  message?: string;
}

function CanvasNodeCreateMenu({
  open,
  position,
  onClose,
  onCreate,
  onUploadFiles,
  onImportScene3d,
  title = "新建节点",
}: CanvasNodeCreateMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const scene3dInputRef = useRef<HTMLInputElement | null>(null);
  const [adjusted, setAdjusted] = useState(position);
  const [view, setView] = useState<"list" | "blender">("list");
  const [link, setLink] = useState<Scene3dLinkState | null>(null);
  const [copied, setCopied] = useState(false);

  // 每次重新打開都回列表視圖：連接碼是「一次性」的，不該在下次開選單時還在畫面上。
  useEffect(() => {
    if (!open) return;
    setView("list");
    setLink(null);
    setCopied(false);
  }, [open]);

  // 翻轉定位：量測實際尺寸，超出畫布容器右 / 下緣就翻到游標另一側。
  // view 進 deps：連接碼視圖比列表寬，切過去要重量一次才不會被右緣切掉。
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const pw = parent ? parent.clientWidth : window.innerWidth;
    const ph = parent ? parent.clientHeight : window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (x + el.offsetWidth > pw) x = Math.max(0, x - el.offsetWidth);
    if (y + el.offsetHeight > ph) y = Math.max(0, y - el.offsetHeight);
    setAdjusted((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
  }, [open, position.x, position.y, view]);

  // Escape / 點選單外關閉。capture 讓關閉先於畫布手勢收到事件。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleCreate = (type: CanvasCreateMenuKind) => {
    onCreate(type);
    onClose();
  };

  // 選檔後回調並關閉；清空 value 讓下次選同一批檔案仍會觸發 change。
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>, kind: "image" | "reference") => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    onUploadFiles(files, kind);
    onClose();
  };

  // 3D 模型單檔（副檔名/體積驗證在呼叫端：那裡有錯誤提示通道）。
  const handleScene3dChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !onImportScene3d) return;
    onImportScene3d(file);
    onClose();
  };

  // 鑄碼：認證頭與站內其它端點同一套（authHeaders＝Bearer + x-user-id 成對）。
  // 失敗一律顯示端點回的人話；網路層失敗才退成自己的文案（不編造原因）。
  const startBlenderLink = async () => {
    setView("blender");
    setCopied(false);
    const headers = authHeaders();
    if (!headers) {
      setLink({ status: "error", message: "请先登录再生成连接码。" });
      return;
    }
    setLink({ status: "loading" });
    let res: Response;
    try {
      res = await fetch("/api/canvas/scene-3d/link", { method: "POST", headers, cache: "no-store" });
    } catch {
      setLink({ status: "error", message: "网络连接失败，请稍后重试。" });
      return;
    }
    let data: Scene3dLinkResponse | null = null;
    try {
      data = (await res.json()) as Scene3dLinkResponse;
    } catch {
      // 非 JSON 錯誤體：保留狀態碼訊息，不讓 parse 異常蓋掉真正原因（照抄導入通道的寫法）。
    }
    if (!res.ok) {
      const message =
        typeof data?.error === "string" && data.error ? data.error : `生成连接码失败（HTTP ${res.status}）`;
      setLink({ status: "error", message });
      return;
    }
    if (typeof data?.code !== "string" || !data.code) {
      setLink({ status: "error", message: "服务器未返回连接码，请稍后重试。" });
      return;
    }
    const ttl =
      typeof data.expires_in_ms === "number" && data.expires_in_ms > 0 ? data.expires_in_ms : 15 * 60 * 1000;
    setLink({ status: "ready", code: data.code, expiresAt: Date.now() + ttl });
  };

  const copyLinkCode = async () => {
    if (link?.status !== "ready" || !link.code) return;
    try {
      await navigator.clipboard.writeText(link.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const expiryLabel =
    link?.status === "ready" && link.expiresAt
      ? new Date(link.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : null;

  return (
    <div
      ref={menuRef}
      data-canvas-interactive
      role="menu"
      aria-label={view === "blender" ? "连接 Blender" : title}
      className={`absolute z-50 select-none rounded-xl lg-sheet p-1 ${view === "blender" ? "w-[248px]" : "w-[200px]"}`}
      style={{ left: adjusted.x, top: adjusted.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 標題列 */}
      <p className="px-3 pb-1 pt-1.5 text-ios-caption2 font-medium text-foreground/45">
        {view === "blender" ? "连接 Blender" : title}
      </p>

      {view === "list" ? (
        <>
          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => handleCreate("text")}>
            <Type className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">文本节点</span>
          </button>

          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => handleCreate("image")}>
            <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">空白图片节点</span>
          </button>

          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => handleCreate("prompt")}>
            <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">提示词节点</span>
          </button>

          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">上传图片…</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className={ITEM_CLASS}
            onClick={() => referenceInputRef.current?.click()}
          >
            <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">上传参考图…</span>
          </button>

          {/* 本機 3D 模型導入（.glb/.gltf）→ 3D 場景卡節點。選檔後由呼叫端驗證＋上傳。 */}
          {onImportScene3d && (
            <button
              type="button"
              role="menuitem"
              title={SCENE_3D_SIZE_HINT}
              className={ITEM_CLASS}
              onClick={() => scene3dInputRef.current?.click()}
            >
              <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
              {/* 上限取自真源常數，不寫死——平台體頂收窄時文案自動跟上。 */}
              <span className="flex-1 truncate">
                导入 3D 模型…（≤ {Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB）
              </span>
            </button>
          )}

          {/* 桌面 Blender 接上畫布：鑄一串一次性連接碼，粘進 addon 的「Eimu 导出」面板。 */}
          <button type="button" role="menuitem" className={ITEM_CLASS} onClick={startBlenderLink}>
            <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">连接 Blender…</span>
          </button>
        </>
      ) : (
        <>
          <p className="px-3 pb-1 text-ios-caption2 leading-relaxed text-foreground/60">
            把连接码粘贴到 Blender 侧边栏「MCP for Blender → Eimu 导出」。
          </p>

          {link?.status === "loading" && (
            <p className="px-3 py-2 text-ios-footnote text-foreground/60">正在生成连接码…</p>
          )}

          {link?.status === "error" && (
            <p className="px-3 py-2 text-ios-footnote text-ios-red">{link.message}</p>
          )}

          {link?.status === "ready" && link.code && (
            <div className="mx-1 mb-1 rounded-lg bg-black/5 p-2">
              {/* select-all：剪貼板不可用時用戶仍能手動全選複製。 */}
              <p className="select-all break-all font-mono text-ios-caption1 leading-relaxed text-foreground">
                {link.code}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" className={SMALL_BUTTON_CLASS} onClick={copyLinkCode}>
                  {copied ? "已复制" : "复制连接码"}
                </button>
                {expiryLabel && (
                  <span className="text-ios-caption2 text-foreground/45">{expiryLabel} 前有效</span>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1 px-1">
            {link?.status === "error" && (
              <button type="button" className={SMALL_BUTTON_CLASS} onClick={startBlenderLink}>
                重试
              </button>
            )}
            <button type="button" className={SMALL_BUTTON_CLASS} onClick={() => setView("list")}>
              返回
            </button>
          </div>
        </>
      )}

      {/* 隱藏檔案選擇器：點「上传图片…」/「上传参考图…」/「导入 3D 模型…」代為觸發 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => handleFileChange(e, "image")}
      />
      <input
        ref={referenceInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => handleFileChange(e, "reference")}
      />
      <input
        ref={scene3dInputRef}
        type="file"
        accept={SCENE_3D_ACCEPT}
        hidden
        onChange={handleScene3dChange}
      />
    </div>
  );
}

export { CanvasNodeCreateMenu };
export default CanvasNodeCreateMenu;
