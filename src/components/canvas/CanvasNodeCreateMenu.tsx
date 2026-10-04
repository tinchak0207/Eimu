"use client";

// CanvasNodeCreateMenu —— 新建节点小型 popover（双击空白 / 拉线到空白处弹出）。
//
// 只管「开在哪、怎么关、入口有几个」：文本节点、空白图片节点、提示词节点、
// 上传图片、上传参考图、导入 3D 模型（各自内藏 hidden file input，选档后回调
// 并自动关闭）；建立语义由呼叫端接手。标题列可换文案（如「连接到新节点」）。
//
// 2026-09-27 追加「连接 Blender」：这是一条**非建立型**入口（不建节点，而是把
// 桌面 Blender 接到画布），所以它不呼叫任何 props，只在同一个 popover 内切到
// 「连接 Blender」视图：呼叫铸码端点 `/api/canvas/scene-3d/link` → 显示一次性
// 连接码（可复制）与到期时间。切视图而不是另开对话框的原因：画布容器带 CSS
// transform，`position: fixed` 的浮层会被 transform 祖先「就地困住」；
// 留在既有 popover 的座标系里最稳，也不必让呼叫端多接一组 props。
//
// 定位：position = 相对画布容器左上的座标；useLayoutEffect 量测实际尺寸
// 后，超出容器右 / 下缘就翻转到另一侧 —— paint 前完成，首帧即最终位置。
// 关闭：Escape / 点选单外（window pointerdown capture，先于画布手势）。
// 根节点带 data-canvas-interactive，InfiniteCanvas 手势层放行选单内事件。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Box, Boxes, ImageIcon, Sparkles, Type, Upload } from "lucide-react";
import { MAX_SCENE_3D_BYTES, SCENE_3D_ACCEPT, SCENE_3D_SIZE_HINT } from "@/lib/canvas/scene-3d-import";
import { authHeaders } from "@/lib/canvas/client";

export type CanvasCreateMenuKind = "text" | "image" | "prompt";

export interface CanvasNodeCreateMenuProps {
  open: boolean;
  /** 相对画布容器的座标 */
  position: { x: number; y: number };
  onClose: () => void;
  /** type: "text" | "image"（空节点）| "prompt"（提示词备忘节点） */
  onCreate: (type: CanvasCreateMenuKind) => void;
  /** 用户选了本地图片档；kind="reference" 表示建成带角色的参考图节点 */
  onUploadFiles: (files: File[], kind?: "image" | "reference") => void;
  /** 用户选了本地 3D 模型档（.glb/.gltf）→ 建 3D 场景卡节点（导入通道由呼叫端接）。 */
  onImportScene3d?: (file: File) => void;
  /** 标题列说明（如「新建节点」/「连接到新节点」），预设「新建节点」 */
  title?: string;
}

/** 选单项目统一皮肤（≥36px 热区 + hover 态）。 */
const ITEM_CLASS =
  "flex min-h-[36px] w-full items-center gap-2 rounded-lg px-3 text-left text-ios-footnote text-foreground transition-colors hover:bg-black/5";

/** 码区块内的小按钮（复制 / 重试 / 返回）：h-7 与画布其它小按钮同高。 */
const SMALL_BUTTON_CLASS =
  "flex h-7 shrink-0 items-center gap-1 rounded-md bg-black/5 px-2 text-ios-caption1 font-medium text-foreground transition-colors hover:bg-black/10";

/** 铸码端点回应（只取用得到的栏位；其余不信任）。 */
interface Scene3dLinkResponse {
  code?: unknown;
  expires_in_ms?: unknown;
  error?: unknown;
}

/** 连接码视图的状态机（loading → ready / error）。 */
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

  // 每次重新打开都回列表视图：连接码是「一次性」的，不该在下次开选单时还在画面上。
  useEffect(() => {
    if (!open) return;
    setView("list");
    setLink(null);
    setCopied(false);
  }, [open]);

  // 翻转定位：量测实际尺寸，超出画布容器右 / 下缘就翻到游标另一侧。
  // view 进 deps：连接码视图比列表宽，切过去要重量一次才不会被右缘切掉。
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

  // Escape / 点选单外关闭。capture 让关闭先于画布手势收到事件。
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

  // 选档后回调并关闭；清空 value 让下次选同一批档案仍会触发 change。
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>, kind: "image" | "reference") => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    onUploadFiles(files, kind);
    onClose();
  };

  // 3D 模型单档（副档名/体积验证在呼叫端：那里有错误提示通道）。
  const handleScene3dChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !onImportScene3d) return;
    onImportScene3d(file);
    onClose();
  };

  // 铸码：认证头与站内其它端点同一套（authHeaders＝Bearer + x-user-id 成对）。
  // 失败一律显示端点回的人话；网路层失败才退成自己的文案（不编造原因）。
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
      // 非 JSON 错误体：保留状态码讯息，不让 parse 异常盖掉真正原因（照抄导入通道的写法）。
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
      {/* 标题列 */}
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

          {/* 本机 3D 模型导入（.glb/.gltf）→ 3D 场景卡节点。选档后由呼叫端验证＋上传。 */}
          {onImportScene3d && (
            <button
              type="button"
              role="menuitem"
              title={SCENE_3D_SIZE_HINT}
              className={ITEM_CLASS}
              onClick={() => scene3dInputRef.current?.click()}
            >
              <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
              {/* 上限取自真源常数，不写死——平台体顶收窄时文案自动跟上。 */}
              <span className="flex-1 truncate">
                导入 3D 模型…（≤ {Math.round(MAX_SCENE_3D_BYTES / 1024 / 1024)} MB）
              </span>
            </button>
          )}

          {/* 桌面 Blender 接上画布：铸一串一次性连接码，粘进 addon 的「Eimu 导出」面板。 */}
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
          <p className="px-3 pb-1 text-ios-caption2 leading-relaxed text-foreground/60">
            还没装插件？
            <a
              href="/downloads/eimu-blender-addon.py"
              download
              className="font-semibold text-[#007AFF] hover:underline"
            >
              下载 Blender 插件
            </a>
            ，在 Blender「编辑 → 偏好设置 → 插件 → 从磁盘安装」选中它并勾选启用。
          </p>

          {link?.status === "loading" && (
            <p className="px-3 py-2 text-ios-footnote text-foreground/60">正在生成连接码…</p>
          )}

          {link?.status === "error" && (
            <p className="px-3 py-2 text-ios-footnote text-ios-red">{link.message}</p>
          )}

          {link?.status === "ready" && link.code && (
            <div className="mx-1 mb-1 rounded-lg bg-black/5 p-2">
              {/* select-all：剪贴板不可用时用户仍能手动全选复制。 */}
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

      {/* 隐藏档案选择器：点「上传图片…」/「上传参考图…」/「导入 3D 模型…」代为触发 */}
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
