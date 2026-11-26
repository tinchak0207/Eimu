// SVG 字串 → data:image/svg+xml;base64 data URL。
//
// 导演台小卡（聊天 AgentDirectorCard + 画布 Director 节点）共用：gateway 下发的
// 示意图是 <svg …> 原文字串，禁止 dangerouslySetInnerHTML，统一转成 <img src>。
// UTF-8 安全编码（btoa 只吃 Latin1，先过 TextEncoder），分块拼 binary 字串
// 避免 spread 撞引数上限；输入不似 <svg> 开头或编码环境缺失时回 null。

export function svgToDataUrl(svg: string | undefined | null): string | null {
  if (typeof svg !== "string") return null;
  const trimmed = svg.trim();
  if (!trimmed.startsWith("<svg")) return null;
  if (typeof btoa !== "function" || typeof TextEncoder === "undefined") return null;
  const bytes = new TextEncoder().encode(trimmed);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  try {
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
