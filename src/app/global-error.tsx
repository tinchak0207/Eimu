"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 24,
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0, fontSize: 16 }}>页面出错了</p>
          <p style={{ margin: 0, fontSize: 14, color: "#666" }}>{error.message || "请重试"}</p>
          <button type="button" onClick={reset} style={{ padding: "8px 16px", borderRadius: 999, border: 0 }}>
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
