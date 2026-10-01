// 工程透析面板的 JSON 語法高亮（純函式，零依賴）：
// 把 JSON.stringify(…, null, 2) 的文字切成帶類別的片段，渲染端按類別著色
// （鍵＝青、字串＝琥珀、數字/布林/null＝紫、其餘標點空白＝plain）。
// 片段依序拼回＝原文（無損），測試鎖死。

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function tokenizeJson(text: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "plain", text: text.slice(last, index) });
    if (match[1] !== undefined) {
      if (match[2] !== undefined) {
        out.push({ kind: "key", text: match[1] });
        out.push({ kind: "plain", text: match[2] });
      } else {
        out.push({ kind: "string", text: match[1] });
      }
    } else if (/^(true|false|null)$/.test(match[0])) {
      out.push({ kind: "literal", text: match[0] });
    } else {
      out.push({ kind: "number", text: match[0] });
    }
    last = index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "plain", text: text.slice(last) });
  return out;
}
