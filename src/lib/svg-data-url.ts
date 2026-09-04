// SVG 字串 → data:image/svg+xml;base64 data URL。
//
// 導演台小卡（聊天 AgentDirectorCard + 畫布 Director 節點）共用：gateway 下發的
// 示意圖是 <svg …> 原文字串，禁止 dangerouslySetInnerHTML，統一轉成 <img src>。
// UTF-8 安全編碼（btoa 只吃 Latin1，先過 TextEncoder），分塊拼 binary 字串
// 避免 spread 撞引數上限；輸入不似 <svg> 開頭或編碼環境缺失時回 null。

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
