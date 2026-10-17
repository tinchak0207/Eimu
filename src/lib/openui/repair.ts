/**
 * OpenUI DSL 容错修复（2026-10-18）。
 *
 * 模型不一定严格守签名。这里在交给 @openuidev 解析器之前做一次**确定性**修复，
 * 目标是「能对上就对上，对不上就显式降级，绝不静默丢组件」：
 *   - 组件名：精确 → 大小写/分隔符归一 → 别名表 → 编辑距离模糊匹配；
 *   - 已移除的文字类组件（Text / BoldText / Markdown…）→ TextContent(文字)；
 *     Image(alt, src) → ImageBlock(src, alt)；
 *   - 命名参数 `title: "x"` / `title="x"` → 按签名顺序改回位置参数；
 *   - 常见错位：Button(label, "primary", @Action) → Button(label, @Action, "primary")；
 *     Slider 的 defaultValue 写成数字 → [数字]；
 *   - 动作名：@toAssistant / @Send → @ToAssistant，@Link → @OpenUrl；
 *   - 根：缺 root 时补；root 不是 Card 时外包一层 Card；
 *   - 仍然映射不了的组件 → Callout("warning", "未识别组件：X", 参数里的文字)，
 *     让用户看得见原内容。
 *
 * 只处理能完整解析的语句；流式中半截的最后一条语句原样保留（交给渲染器的
 * 流式容错），因此修复不会在流式过程中来回跳变。
 *
 * 零依赖（不 import @openuidev/*）：签名顺序由调用方传入（来自同一个 eimuLibrary）。
 */
import {
  OPENUI_ACTION_ALIASES,
  OPENUI_ACTIONS,
  OPENUI_COMPONENT_ALIASES,
  OPENUI_COMPONENTS,
  OPENUI_COMPONENT_SET,
} from "./catalog";

// ── AST ─────────────────────────────────────────────────────────────────
type Node =
  | { t: "str"; value: string }
  | { t: "lit"; raw: string }
  | { t: "ref"; name: string }
  | { t: "call"; name: string; action: boolean; args: Arg[] }
  | { t: "arr"; items: Node[] }
  | { t: "obj"; entries: Array<{ key: string; value: Node }> };
type Arg = { key?: string; value: Node };

class ParseFail extends Error {}

class Lexer {
  i = 0;
  constructor(readonly s: string) {}
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1;
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  eat(ch: string) {
    this.ws();
    if (this.s[this.i] !== ch) throw new ParseFail(`expected ${ch} at ${this.i}`);
    this.i += 1;
  }
  tryEat(ch: string) {
    this.ws();
    if (this.s[this.i] === ch) {
      this.i += 1;
      return true;
    }
    return false;
  }
  ident(): string | null {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  string(): string {
    this.ws();
    const q = this.s[this.i];
    if (q !== '"' && q !== "'" && q !== "“") throw new ParseFail("expected string");
    const close = q === "“" ? "”" : q;
    this.i += 1;
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") {
        const n = this.s[this.i + 1];
        if (n === undefined) throw new ParseFail("dangling escape");
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\" };
        out += map[n] ?? n;
        this.i += 2;
        continue;
      }
      if (c === close) {
        this.i += 1;
        return out;
      }
      out += c;
      this.i += 1;
    }
    throw new ParseFail("unterminated string");
  }
}

function parseExpr(lx: Lexer): Node {
  const c = lx.peek();
  if (c === undefined) throw new ParseFail("eof");
  if (c === '"' || c === "'" || c === "“") return { t: "str", value: lx.string() };
  if (c === "[") {
    lx.eat("[");
    const items: Node[] = [];
    while (!lx.tryEat("]")) {
      items.push(parseExpr(lx));
      if (!lx.tryEat(",")) {
        lx.eat("]");
        break;
      }
    }
    return { t: "arr", items };
  }
  if (c === "{") {
    lx.eat("{");
    const entries: Array<{ key: string; value: Node }> = [];
    while (!lx.tryEat("}")) {
      const p = lx.peek();
      const key = p === '"' || p === "'" ? lx.string() : lx.ident();
      if (key === null) throw new ParseFail("bad object key");
      lx.eat(":");
      entries.push({ key, value: parseExpr(lx) });
      if (!lx.tryEat(",")) {
        lx.eat("}");
        break;
      }
    }
    return { t: "obj", entries };
  }
  if (c === "@") {
    lx.eat("@");
    const name = lx.ident();
    if (!name) throw new ParseFail("bad action");
    const args = lx.peek() === "(" ? parseArgs(lx) : [];
    return { t: "call", name, action: true, args };
  }
  const num = /^-?\d+(?:\.\d+)?/.exec(lx.s.slice(lx.i));
  if (num) {
    lx.i += num[0].length;
    return { t: "lit", raw: num[0] };
  }
  const name = lx.ident();
  if (!name) throw new ParseFail(`unexpected ${c} at ${lx.i}`);
  if (name === "true" || name === "false" || name === "null") return { t: "lit", raw: name };
  if (lx.peek() === "(") return { t: "call", name, action: false, args: parseArgs(lx) };
  return { t: "ref", name };
}

function parseArgs(lx: Lexer): Arg[] {
  lx.eat("(");
  const args: Arg[] = [];
  while (!lx.tryEat(")")) {
    // 命名参数：`key: value` 或 `key = value`（向前看，不吃掉普通引用）。
    const save = lx.i;
    let key: string | undefined;
    const id = lx.ident();
    if (id !== null) {
      lx.ws();
      const nx = lx.s[lx.i];
      if ((nx === ":" || (nx === "=" && lx.s[lx.i + 1] !== "=")) && id !== "true" && id !== "false" && id !== "null") {
        lx.i += 1;
        key = id;
      } else {
        lx.i = save;
      }
    }
    args.push({ key, value: parseExpr(lx) });
    if (!lx.tryEat(",")) {
      lx.eat(")");
      break;
    }
  }
  return args;
}

// ── 序列化 ──────────────────────────────────────────────────────────────
function q(s: string): string {
  return JSON.stringify(s);
}
function ser(n: Node): string {
  switch (n.t) {
    case "str":
      return q(n.value);
    case "lit":
      return n.raw;
    case "ref":
      return n.name;
    case "arr":
      return `[${n.items.map(ser).join(", ")}]`;
    case "obj":
      return `{${n.entries.map((e) => `${/^[A-Za-z_$][\w$]*$/.test(e.key) ? e.key : q(e.key)}: ${ser(e.value)}`).join(", ")}}`;
    case "call":
      return `${n.action ? "@" : ""}${n.name}(${n.args.map((a) => ser(a.value)).join(", ")})`;
  }
}

// ── 名称解析 ────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
const NORMALIZED = new Map(OPENUI_COMPONENTS.map((n) => [norm(n), n as string]));

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type ResolvedName =
  | { kind: "component"; name: string; via: "exact" | "case" | "alias" | "fuzzy" }
  | { kind: "text"; via: "alias" }
  | { kind: "image"; via: "alias" }
  | null;

export function resolveComponentName(name: string): ResolvedName {
  if (OPENUI_COMPONENT_SET.has(name)) return { kind: "component", name, via: "exact" };
  const k = norm(name);
  const cased = NORMALIZED.get(k);
  if (cased) return { kind: "component", name: cased, via: "case" };
  const alias = OPENUI_COMPONENT_ALIASES[k];
  if (alias === "text:") return { kind: "text", via: "alias" };
  if (alias === "image:") return { kind: "image", via: "alias" };
  if (alias) return { kind: "component", name: alias, via: "alias" };
  // 复数/单数误差：Buttons↔Button 已在白名单；其余去尾 s 再查一次别名。
  if (k.endsWith("s") && OPENUI_COMPONENT_ALIASES[k.slice(0, -1)]) {
    const a2 = OPENUI_COMPONENT_ALIASES[k.slice(0, -1)];
    if (a2 !== "text:" && a2 !== "image:") return { kind: "component", name: a2, via: "alias" };
  }
  if (k.length >= 4) {
    const limit = k.length >= 7 ? 2 : 1;
    let best: string | null = null;
    let bestD = 99;
    let tie = false;
    for (const [nk, real] of NORMALIZED) {
      const d = levenshtein(k, nk);
      if (d < bestD) {
        bestD = d;
        best = real;
        tie = false;
      } else if (d === bestD) {
        tie = true;
      }
    }
    if (best && bestD <= limit && !tie) return { kind: "component", name: best, via: "fuzzy" };
  }
  return null;
}

export function resolveActionName(name: string): string | null {
  if ((OPENUI_ACTIONS as readonly string[]).includes(name)) return name;
  return OPENUI_ACTION_ALIASES[norm(name)] ?? null;
}

// ── 修复 ────────────────────────────────────────────────────────────────
/** 组件名 → 位置参数的属性名顺序（来自 eimuLibrary 的 zod schema）。 */
export type ArgOrderMap = Record<string, readonly string[]>;

export type RepairNote = { kind: string; detail: string };

const BUTTON_VARIANTS = new Set(["primary", "secondary", "tertiary"]);
const MAX_FALLBACK_TEXT = 300;

function collectText(n: Node, out: string[]) {
  switch (n.t) {
    case "str":
      if (n.value.trim()) out.push(n.value.trim());
      return;
    case "arr":
      n.items.forEach((x) => collectText(x, out));
      return;
    case "obj":
      n.entries.forEach((e) => collectText(e.value, out));
      return;
    case "call":
      n.args.forEach((a) => collectText(a.value, out));
      return;
    default:
      return;
  }
}

function textOf(args: Arg[]): string {
  const out: string[] = [];
  args.forEach((a) => collectText(a.value, out));
  const joined = out.join("\n");
  return joined.length > MAX_FALLBACK_TEXT ? `${joined.slice(0, MAX_FALLBACK_TEXT)}…` : joined;
}

const looksUrl = (s: string) => /^(https?:)?\/\//i.test(s.trim());

class Repairer {
  notes: RepairNote[] = [];
  constructor(readonly argOrder: ArgOrderMap) {}

  node(n: Node): Node {
    switch (n.t) {
      case "arr":
        return { t: "arr", items: n.items.map((x) => this.node(x)) };
      case "obj":
        return { t: "obj", entries: n.entries.map((e) => ({ key: e.key, value: this.node(e.value) })) };
      case "call":
        return n.action ? this.action(n) : this.call(n);
      default:
        return n;
    }
  }

  action(n: Extract<Node, { t: "call" }>): Node {
    const args = n.args.map((a) => ({ key: a.key, value: this.node(a.value) }));
    const resolved = resolveActionName(n.name);
    if (resolved && resolved !== n.name) this.notes.push({ kind: "action-alias", detail: `@${n.name} → @${resolved}` });
    return { ...n, name: resolved ?? n.name, args };
  }

  call(n: Extract<Node, { t: "call" }>): Node {
    const args = n.args.map((a) => ({ key: a.key, value: this.node(a.value) }));
    const r = resolveComponentName(n.name);
    if (r === null) {
      this.notes.push({ kind: "unknown-component", detail: n.name });
      return this.fallback(n.name, args);
    }
    if (r.kind === "text") {
      this.notes.push({ kind: "text-alias", detail: `${n.name} → TextContent` });
      return { t: "call", name: "TextContent", action: false, args: [{ value: { t: "str", value: textOf(args) } }] };
    }
    if (r.kind === "image") {
      const strs: string[] = [];
      args.forEach((a) => (a.value.t === "str" ? strs.push(a.value.value) : undefined));
      const src = strs.find(looksUrl);
      const alt = strs.find((s) => s !== src) ?? "";
      this.notes.push({ kind: "image-alias", detail: `${n.name} → ImageBlock` });
      if (!src) return { t: "call", name: "TextContent", action: false, args: [{ value: { t: "str", value: alt || "（图片缺少地址）" } }] };
      return { t: "call", name: "ImageBlock", action: false, args: [{ value: { t: "str", value: src } }, { value: { t: "str", value: alt } }] };
    }
    if (r.via !== "exact") this.notes.push({ kind: `name-${r.via}`, detail: `${n.name} → ${r.name}` });
    return this.fixArgs(r.name, args);
  }

  fallback(name: string, args: Arg[]): Node {
    const text = textOf(args) || "（无可显示内容）";
    return {
      t: "call",
      name: "Callout",
      action: false,
      args: [
        { value: { t: "str", value: "warning" } },
        { value: { t: "str", value: `未识别组件：${name}` } },
        { value: { t: "str", value: text } },
      ],
    };
  }

  fixArgs(name: string, rawArgs: Arg[]): Node {
    let args: Node[];
    const order = this.argOrder[name];
    if (rawArgs.some((a) => a.key) && order) {
      const slots: Array<Node | undefined> = [];
      let pos = 0;
      for (const a of rawArgs) {
        if (!a.key) {
          while (slots[pos] !== undefined) pos += 1;
          slots[pos] = a.value;
          pos += 1;
          continue;
        }
        const idx = order.findIndex((p) => p.toLowerCase() === a.key!.toLowerCase());
        if (idx < 0) {
          this.notes.push({ kind: "unknown-arg", detail: `${name}.${a.key}` });
          continue;
        }
        slots[idx] = a.value;
      }
      while (slots.length && slots[slots.length - 1] === undefined) slots.pop();
      args = Array.from(slots, (s) => s ?? ({ t: "lit", raw: "null" } as Node));
      this.notes.push({ kind: "named-args", detail: name });
    } else {
      args = rawArgs.map((a) => a.value);
    }

    // Button(label, "primary", @Action) → Button(label, @Action, "primary")
    if (name === "Button" && args.length >= 2) {
      const a1 = args[1];
      const a2 = args[2];
      if (a1.t === "str" && BUTTON_VARIANTS.has(a1.value) && (a2 === undefined || (a2.t === "call" && a2.action))) {
        args = [args[0], a2 ?? ({ t: "lit", raw: "null" } as Node), a1, ...args.slice(3)];
        if (a2 === undefined) args = [args[0], { t: "lit", raw: "null" }, a1];
        this.notes.push({ kind: "button-order", detail: "variant/action swapped" });
      }
      // 字符串当动作：Button("好", "生成") → @ToAssistant("生成")
      const act = args[1];
      if (act && act.t === "str" && !BUTTON_VARIANTS.has(act.value)) {
        args[1] = { t: "call", name: "ToAssistant", action: true, args: [{ value: act }] };
        this.notes.push({ kind: "button-string-action", detail: act.value });
      }
    }
    // Slider defaultValue（第 6 个位置）写成数字 → [数字]
    if (name === "Slider" && args[5]?.t === "lit" && /^-?\d/.test((args[5] as { raw: string }).raw)) {
      args[5] = { t: "arr", items: [args[5]] };
      this.notes.push({ kind: "slider-default", detail: "wrapped in array" });
    }
    return { t: "call", name, action: false, args: args.map((value) => ({ value })) };
  }
}

/** 把源码切成「语句块」：一条语句可能跨行（括号未平衡时续行）。 */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: string | null = null;
  let esc = false;
  for (const line of code.split("\n")) {
    buf = buf ? `${buf}\n${line}` : line;
    for (const ch of line) {
      if (quote) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === quote || (quote === "“" && ch === "”")) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "“") quote = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    }
    // 字符串跨行视为未完（模型极少这样写，交给续行）。
    if (depth === 0 && !quote) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

export type RepairResult = { code: string; notes: RepairNote[]; changed: boolean };

/**
 * 修复一段 openui 源码。不能解析的语句（含流式中的半截尾句）原样保留。
 * 对已经合规的程序是恒等变换（`changed === false` 时返回原文，逐字不变）。
 */
export function repairOpenUISource(code: string, argOrder: ArgOrderMap): RepairResult {
  const rep = new Repairer(argOrder);
  const chunks = splitStatements(code);
  type Stmt = { name: string; node: Node } | { raw: string };
  const stmts: Stmt[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      stmts.push({ raw: chunk });
      continue;
    }
    const lx = new Lexer(chunk);
    try {
      const name = lx.ident();
      if (!name) throw new ParseFail("no name");
      lx.eat("=");
      const node = parseExpr(lx);
      lx.ws();
      if (lx.i < chunk.length) {
        // 尾部多余内容（例如行尾注释、分号）：只容忍 ; 与 // 注释
        const rest = chunk.slice(lx.i).trim();
        if (rest && rest !== ";" && !rest.startsWith("//")) throw new ParseFail("trailing");
      }
      stmts.push({ name, node: rep.node(node) });
    } catch {
      stmts.push({ raw: chunk });
    }
  }

  // 根修复：仅在全部语句都已完整解析时做（流式半截时不动，避免跳变）。
  const parsed = stmts.filter((s): s is { name: string; node: Node } => "name" in s);
  const allParsed = stmts.every((s) => "name" in s || !s.raw.trim());
  const rootStmt = parsed.find((s) => s.name === "root");
  let prefix: string[] = [];
  if (allParsed && parsed.length > 0) {
    if (!rootStmt) {
      const first = parsed[0];
      const isCard = first.node.t === "call" && first.node.name === "Card";
      prefix = [isCard ? `root = ${first.name}` : `root = Card([${first.name}])`];
      rep.notes.push({ kind: "root-added", detail: first.name });
    } else if (rootStmt.node.t === "call" && rootStmt.node.name !== "Card" && !rootStmt.node.action) {
      const inner: Node = rootStmt.node;
      rootStmt.node = { t: "call", name: "Card", action: false, args: [{ value: { t: "arr", items: [inner] } }] };
      rep.notes.push({ kind: "root-wrapped", detail: (inner as { name: string }).name });
    }
  }

  const changed = rep.notes.length > 0;
  if (!changed) return { code, notes: [], changed: false };
  const body = stmts.map((s) => ("name" in s ? `${s.name} = ${ser(s.node)}` : s.raw)).join("\n");
  return { code: [...prefix, body].join("\n"), notes: rep.notes, changed: true };
}
