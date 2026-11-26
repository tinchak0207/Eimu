// 助理消息的 Markdown 解析层（纯函数，无平台依赖）。
//
// 真源：src/lib/agent-markdown.ts（网页版 454 行）。小程序端不引 marked
// （依赖表里没有，也不许改 package.json），这里用一支手写解析器产出**同一套
// token 树**（MdInline 9 种 / MdBlock 6 种），交给 AgentMarkdown.tsx 渲染。
// 语义与 marked 的 `{ gfm: true, breaks: true }` 对齐：
//   - 软换行 → br（breaks: true）；
//   - 表格 / 删除线 / 自动连结走 GFM；
//   - 原始 HTML token 一律丢弃（XSS 面为零，与网页版同一裁定）。
//
// 平台媒体补判（网页版 :42-66）逐字搬来：主机 + 精确路径前缀白名单，
// 宁可留裸连结，也不画无法证实的媒体卡。

/** 行内 span。link 指向图片时由渲染层转缩略图（网页版罪状 9）。 */
export type MdInline =
  | { k: 'text'; text: string }
  | { k: 'strong'; children: MdInline[] }
  | { k: 'em'; children: MdInline[] }
  | { k: 'del'; children: MdInline[] }
  | { k: 'code'; text: string }
  | { k: 'link'; href: string; children: MdInline[] }
  | { k: 'img'; src: string; alt: string }
  | { k: 'video'; src: string }
  | { k: 'audio'; src: string }
  | { k: 'br' }

export type MdBlock =
  | { type: 'p'; children: MdInline[] }
  | { type: 'h'; level: number; children: MdInline[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'table'; head: MdInline[][]; rows: MdInline[][][] }

// ─────────────────────────── 平台媒体 URL 判定（网页版 :54-91 逐字）

// 补判只收「目录语义钉死单一媒体」的形状，且规则一律精确主机＋精确路径前缀。
// 以下是生产中多种媒体混居的形状，**故意不补判**，维持裸连结——宁可留连结，
// 也不画无法证实的媒体卡（画错卡比裸连结更伤）：
//   - image-data/files/generation/jobs/：同目录落图与影片，无法由路径判型。
//   - image-data/files/uploads/media-*：同时接受 image/*、video/*、audio/*。
//   - image-data/files/agent-batch3/：同目录有 .png 与 .wav，且无稳定命名契约。
//   - image.tinchak0207.xyz/v1/images/<id>/result：预设回 JSON、且须 bearer 金钥。
// 参考图目录：三个写入点落盘前全过 validateImageBuffer，只存图片。
// 从 .env 注入（TARO_APP_AGENT_ORIGIN），默认生产域名；域名字串先转义再拼进 regex。
const AGENT_ORIGIN_ESC = (process.env.TARO_APP_AGENT_ORIGIN || 'https://store.tinchak0207.xyz').replace(
  /[.*+?^${}()|[\]\\]/g,
  '\\$&',
)
const AGENT_HOST_ESC = AGENT_ORIGIN_ESC.replace(/^https?:\/\//, '')
const PLATFORM_IMAGE_URL = new RegExp(
  '^https?:\\/\\/' + AGENT_HOST_ESC + '\\/image-data\\/files\\/generation\\/references\\/[A-Za-z0-9._-]+$',
  'i',
)
// 音乐生成器交付目录：music-tools.ts 上传，mime→ext 全为 audio/*。
const PLATFORM_AUDIO_MUSIC_URL = new RegExp(
  '^https?:\\/\\/' + AGENT_HOST_ESC + '\\/image-data\\/files\\/uploads\\/music-gen-[A-Za-z0-9._-]+$',
  'i',
)
// 网关 TTS 公网面：constants-gateway.ts:193 TTS_PUBLIC_BASE，路径即音频。
const PLATFORM_AUDIO_TTS_URL = new RegExp(
  '^https?:\\/\\/' + AGENT_HOST_ESC + '\\/agent\\/v1\\/audio\\/[A-Za-z0-9._-]+$',
  'i',
)

/** 判断一个 URL 是否指向图片（扩展名 + 平台「只存图片」目录补判）。 */
export function isImageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const trimmed = url.trim()
  return /\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(trimmed) || PLATFORM_IMAGE_URL.test(trimmed)
}

/** 影片直链（mp4/mov/webm/m4v）：命中即画播放器，不留裸 URL。 */
export function isVideoUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  return /\.(mp4|mov|webm|m4v)(\?\S*)?$/i.test(url.trim())
}

/** 音频直链（m4a/mp3/wav/aac/ogg/flac/opus）+ 平台「只存音频」前缀补判。 */
export function isAudioUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const trimmed = url.trim()
  return (
    /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?\S*)?$/i.test(trimmed) ||
    PLATFORM_AUDIO_MUSIC_URL.test(trimmed) ||
    PLATFORM_AUDIO_TTS_URL.test(trimmed)
  )
}

// ─────────────────────────── 行内解析

const ESCAPABLE = '\\`*_{}[]()#+-.!|>~'

function pushText(out: MdInline[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last !== undefined && last.k === 'text') last.text += text
  else out.push({ k: 'text', text })
}

function countRun(src: string, start: number, ch: string): number {
  let i = start
  while (i < src.length && src[i] === ch) i += 1
  return i - start
}

interface LinkMatch {
  text: string
  href: string
  end: number
}

/**
 * 解析 `[text](href "title")`。括号深度计入，URL 里的 `(…)` 不会被截断；
 * 反斜线转义不算语法。不是合法连结时回 null（交给外层按字面文字处理）。
 */
function matchLink(src: string, start: number): LinkMatch | null {
  if (src[start] !== '[') return null
  let depth = 0
  let close = -1
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1 || src[close + 1] !== '(') return null

  let j = close + 2
  while (j < src.length && /\s/.test(src[j])) j += 1
  let href = ''
  if (src[j] === '<') {
    const end = src.indexOf('>', j + 1)
    if (end === -1) return null
    href = src.slice(j + 1, end)
    j = end + 1
  } else {
    const begin = j
    let parens = 0
    for (; j < src.length; j += 1) {
      const ch = src[j]
      if (ch === '\\') {
        j += 1
        continue
      }
      if (ch === '(') parens += 1
      else if (ch === ')') {
        if (parens === 0) break
        parens -= 1
      } else if (/\s/.test(ch)) break
    }
    href = src.slice(begin, j)
  }
  while (j < src.length && /\s/.test(src[j])) j += 1
  // 可选 title（"…" / '…' / (…)），只跳过不保留。
  if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
    const quote = src[j] === '(' ? ')' : src[j]
    const end = src.indexOf(quote, j + 1)
    if (end !== -1) j = end + 1
  }
  while (j < src.length && /\s/.test(src[j])) j += 1
  if (src[j] !== ')') return null
  return { text: src.slice(start + 1, close), href: href.trim(), end: j + 1 }
}

function mediaInline(href: string, label: string): MdInline | null {
  if (isImageUrl(href)) return { k: 'img', src: href, alt: label }
  if (isVideoUrl(href)) return { k: 'video', src: href }
  if (isAudioUrl(href)) return { k: 'audio', src: href }
  return null
}

/** 行内文本 → span 序列。 */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf) {
      pushText(out, buf)
      buf = ''
    }
  }

  while (i < src.length) {
    const ch = src[i]

    // 反斜线转义
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }

    // 行内代码
    if (ch === '`') {
      const run = countRun(src, i, '`')
      const fence = '`'.repeat(run)
      const close = src.indexOf(fence, i + run)
      if (close !== -1) {
        flush()
        let code = src.slice(i + run, close)
        // CommonMark：两侧各一个空格则各剥一个（内容全空白时不动）。
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
          code = code.slice(1, -1)
        }
        out.push({ k: 'code', text: code })
        i = close + run
        continue
      }
      buf += ch
      i += 1
      continue
    }

    // 图片 ![alt](src)
    if (ch === '!' && src[i + 1] === '[') {
      const m = matchLink(src, i + 1)
      if (m) {
        flush()
        out.push({ k: 'img', src: m.href, alt: m.text })
        i = m.end
        continue
      }
    }

    // 连结 [text](href)：指向媒体时整条转媒体（罪状 9）
    if (ch === '[') {
      const m = matchLink(src, i)
      if (m) {
        flush()
        const media = mediaInline(m.href, m.text)
        if (media) out.push(media)
        else out.push({ k: 'link', href: m.href, children: parseInline(m.text) })
        i = m.end
        continue
      }
    }

    // GFM 裸连结自动识别。网页版的 marked 带 gfm 会自动把 `https://…` 转 Link
    // token，手写解析器必须自己认——否则平台媒体直链（media-*.m4a 这类）会退化
    // 成一段纯文字，音频/影片卡根本画不出来（2026-10-22 实测的缺口）。
    if (ch === 'h' && (src.startsWith('http://', i) || src.startsWith('https://', i))) {
      const prev = i > 0 ? src[i - 1] : ''
      // 词边界：紧贴字母/数字/路径字符的 `…https://` 属于更长的裸字串，不拆。
      if (!/[A-Za-z0-9_\-/.@]/.test(prev)) {
        const auto = /^https?:\/\/[^\s<>"'`]+/i.exec(src.slice(i))
        if (auto) {
          // GFM 语义：句末标点不并入连结。
          const href = auto[0].replace(/[.,;:!?，。；：！？、）)】」』]+$/, '')
          if (href.length > 8) {
            flush()
            const media = mediaInline(href, href)
            if (media) out.push(media)
            else out.push({ k: 'link', href, children: [{ k: 'text', text: href }] })
            i += href.length
            continue
          }
        }
      }
    }

    // 自动连结 <https://…> 与 HTML 丢弃
    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^<>\s]+)>/i.exec(src.slice(i))
      if (auto) {
        flush()
        const href = auto[1]
        const label = href.replace(/^mailto:/i, '')
        const media = mediaInline(href, label)
        if (media) out.push(media)
        else out.push({ k: 'link', href, children: [{ k: 'text', text: label }] })
        i += auto[0].length
        continue
      }
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4)
        if (end !== -1) {
          flush()
          i = end + 3
          continue
        }
      }
      const tag = /^<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/.exec(src.slice(i))
      if (tag) {
        flush()
        i += tag[0].length
        continue
      }
    }

    // 强 / 斜体（`*`、`_`；`__` / `**` 为强）
    if (ch === '*' || ch === '_') {
      const run = countRun(src, i, ch)
      const double = run >= 2
      const delim = ch.repeat(double ? 2 : 1)
      const prev = i > 0 ? src[i - 1] : ''
      const next = src[i + delim.length] ?? ''
      // 单词内下划线不当强调（`foo_bar_baz` 原样）。
      const intraword = ch === '_' && /[A-Za-z0-9]/.test(prev)
      if (next !== '' && next !== ' ' && !intraword) {
        const close = src.indexOf(delim, i + delim.length)
        if (close !== -1 && close > i + delim.length) {
          const inner = src.slice(i + delim.length, close)
          if (inner.trim()) {
            flush()
            out.push(double ? { k: 'strong', children: parseInline(inner) } : { k: 'em', children: parseInline(inner) })
            i = close + delim.length
            continue
          }
        }
      }
      buf += ch.repeat(run)
      i += run
      continue
    }

    // 删除线 ~~…~~
    if (ch === '~' && src[i + 1] === '~') {
      const close = src.indexOf('~~', i + 2)
      if (close !== -1 && close > i + 2) {
        flush()
        out.push({ k: 'del', children: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    // 软换行 = br（marked breaks:true）
    if (ch === '\n') {
      flush()
      out.push({ k: 'br' })
      i += 1
      continue
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

// ─────────────────────────── 块级解析

// CommonMark 围栏：≤3 空格缩进，``` / ~~~ 至少三个。
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const LIST_MARKER = /^(\s*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const QUOTE_LINE = /^ {0,3}>/

interface ListMarker {
  indent: number
  ordered: boolean
  content: string
}

function matchListMarker(line: string): ListMarker | null {
  const m = LIST_MARKER.exec(line)
  if (!m) return null
  const indent = m[1].length
  if (indent > 3) return null
  return { indent, ordered: /\d/.test(m[2]), content: m[3] }
}

function isTableDelimiter(line: string): boolean {
  if (!line || !line.includes('-')) return false
  if (!line.includes('|') && !/^ {0,3}:?-{3,}:? {0,3}$/.test(line)) return false
  return TABLE_DELIM.test(line)
}

/** 表格行切分：尊重反引号与 `\|` 转义，去掉最外层空单元格。 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let buf = ''
  let inCode = false
  let i = 0
  while (i < trimmed.length) {
    const ch = trimmed[i]
    if (ch === '\\' && trimmed[i + 1] === '|') {
      buf += '|'
      i += 2
      continue
    }
    if (ch === '`') {
      inCode = !inCode
      buf += ch
      i += 1
      continue
    }
    if (ch === '|' && !inCode) {
      cells.push(buf)
      buf = ''
      i += 1
      continue
    }
    buf += ch
    i += 1
  }
  cells.push(buf)
  if (cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

function startsBlock(line: string, next: string | undefined): boolean {
  if (!line.trim()) return true
  if (FENCE_OPEN.test(line)) return true
  if (ATX_HEADING.test(line)) return true
  if (HR.test(line)) return true
  if (QUOTE_LINE.test(line)) return true
  if (matchListMarker(line)) return true
  if (next !== undefined && line.includes('|') && isTableDelimiter(next)) return true
  return false
}

/** Markdown 文本 → 块序列。 */
export function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    // 围栏代码块
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const ch = fence[2][0]
      const len = fence[2].length
      const info = fence[3].trim()
      i += 1
      const body: string[] = []
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i])
        if (close && close[1][0] === ch && close[1].length >= len) {
          i += 1
          break
        }
        body.push(lines[i])
        i += 1
      }
      const text = body.join('\n')
      const first = normalizeCodeLang(info).split(/\s+/)[0]
      // 未标语言（或泛用语言名）但内容是 openui 程序 → 按裸 DSL 渲染（与网页版 :184-187 同）。
      if (!isOpenUILang(info) && GENERIC_CODE_LANGS.has(first) && looksLikeOpenUIProgram(text)) {
        out.push({ type: 'code', lang: 'openui bare', text })
        continue
      }
      out.push({ type: 'code', ...(info === '' ? {} : { lang: info }), text })
      continue
    }

    // 分隔线：不产生可见块
    if (HR.test(line)) {
      i += 1
      continue
    }

    // ATX 标题
    const heading = ATX_HEADING.exec(line)
    if (heading) {
      out.push({ type: 'h', level: heading[1].length, children: parseInline((heading[2] ?? '').trim()) })
      i += 1
      continue
    }

    // Setext 标题（下一行 === / ---）
    if (i + 1 < lines.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1])) {
      const marker = lines[i + 1].trim()
      if (marker.startsWith('=') || !HR.test(lines[i + 1])) {
        out.push({
          type: 'h',
          level: marker.startsWith('=') ? 1 : 2,
          children: parseInline(line.trim()),
        })
        i += 2
        continue
      }
    }

    // 引用
    if (QUOTE_LINE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && lines[i].trim() && (QUOTE_LINE.test(lines[i]) || inner.length > 0)) {
        const quoted = QUOTE_LINE.test(lines[i])
        if (!quoted && startsBlock(lines[i], lines[i + 1])) break
        inner.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''))
        i += 1
      }
      out.push({ type: 'quote', blocks: parseBlocks(inner.join('\n')) })
      continue
    }

    // 表格（表头 + 分隔行）
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const head = splitTableRow(line)
      if (head.length > 0) {
        i += 2
        const rows: MdInline[][][] = []
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitTableRow(lines[i])
          while (cells.length < head.length) cells.push('')
          rows.push(cells.slice(0, head.length).map((cell) => parseInline(cell)))
          i += 1
        }
        out.push({ type: 'table', head: head.map((cell) => parseInline(cell)), rows })
        continue
      }
    }

    // 列表（嵌套子列表的项并入同级——聊天气泡里层级缩进价值低，与网页版一致）
    const marker = matchListMarker(line)
    if (marker) {
      const ordered = marker.ordered
      const items: MdInline[][] = []
      while (i < lines.length) {
        const m = matchListMarker(lines[i])
        if (!m) break
        const itemLines: string[] = [m.content]
        i += 1
        // 续行：缩进的非块级行
        while (i < lines.length && lines[i].trim() && !matchListMarker(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
          itemLines.push(lines[i].replace(/^ {1,4}/, ''))
          i += 1
        }
        const spans: MdInline[] = []
        itemLines.forEach((textLine, index) => {
          if (index > 0) spans.push({ k: 'br' })
          spans.push(...parseInline(textLine))
        })
        if (spans.length > 0) items.push(spans)
        // 空行：下一行仍是列表项才算同一列表
        if (i < lines.length && !lines[i].trim()) {
          let k = i
          while (k < lines.length && !lines[k].trim()) k += 1
          const nextMarker = k < lines.length ? matchListMarker(lines[k]) : null
          // 空行后只有「同类型列表项」才算同一列表（有序/无序不混并）。
          if (nextMarker !== null && nextMarker.ordered === ordered) i = k
          else break
        }
      }
      out.push({ type: 'list', ordered, items })
      continue
    }

    // 段落
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i])
      i += 1
    }
    if (para.length === 0) {
      i += 1
      continue
    }
    out.push({ type: 'p', children: parseInline(para.join('\n')) })
  }

  return out
}

// ─────────────────────────── OpenUI 识别（网页版 :213-247 / :249-358 逐字）

/** 语言名归一：fence info string 的大小写与前后空白都不该影响分派。 */
export function normalizeCodeLang(lang?: string): string {
  return (lang ?? '').trim().toLowerCase()
}

/** 判定一行像不像 openui 语句的轻量正则（openui/catalog.ts:270-272）。 */
const OPENUI_ROOT_LINE_RE = /^\s*root\s*=\s*[A-Za-z_][\w]*\s*\(/
const OPENUI_STATEMENT_LINE_RE =
  /^\s*[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_][\w]*\s*\(|@[A-Za-z]|\[|\{|"|\$|-?\d|true\b|false\b|null\b)/

/** 模型常见的 openui 围栏语言名写法（含 openui-lang 等变体）。 */
const OPENUI_LANGS = new Set(['openui', 'openui-lang', 'openuilang', 'open-ui', 'oui'])
/** 无语言名或泛用语言名的代码块：内容像 openui 程序时也按 openui 处理。 */
const GENERIC_CODE_LANGS = new Set(['', 'text', 'plaintext', 'plain', 'txt', 'dsl', 'ui', 'ini'])

/** 是否 OpenUI 栅栏（`OpenUI`、` openui `、`openui title=demo`、`openui-lang` 一律算）。 */
export function isOpenUILang(lang?: string): boolean {
  return OPENUI_LANGS.has(normalizeCodeLang(lang).split(/\s+/)[0])
}

/** 该 openui 块是否由「裸 DSL 识别」包出来的（info string 带 `bare`）。 */
export function isBareOpenUIInfo(lang?: string): boolean {
  const words = normalizeCodeLang(lang).split(/\s+/)
  return OPENUI_LANGS.has(words[0]) && words.includes('bare')
}

/** 一段文本整体是否像 openui 程序（首个非空行是 `root = X(`，或 ≥2 条语句且含 Card(）。 */
export function looksLikeOpenUIProgram(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return false
  if (OPENUI_ROOT_LINE_RE.test(lines[0])) return true
  const stmts = lines.filter((l) => OPENUI_STATEMENT_LINE_RE.test(l))
  return stmts.length >= 2 && stmts.length >= lines.length * 0.8 && /\bCard\s*\(/i.test(text)
}

/** 一行内括号深度变化（忽略字符串里的括号）。 */
function bracketDelta(line: string): number {
  let d = 0
  let quote: string | null = null
  let esc = false
  for (const ch of line) {
    if (quote) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') d += 1
    else if (ch === ')' || ch === ']' || ch === '}') d -= 1
  }
  return d
}

const BARE_ROOT_TAIL_RE = /^\s*root\s*=\s*[A-Za-z_]*\s*$/
const OPENUI_LABEL_LINE_RE = /^\s*(?:openui|openui-lang)\s*:?\s*$/i

/**
 * 裸 DSL 识别：模型不守约、没套 ```openui 围栏时，把正文里的 openui 程序段落
 * 包成 ```openui bare 围栏（与网页版同一支、同一判据）。
 */
export function fenceBareOpenUI(text: string): string {
  if (!/\broot\s*=/.test(text)) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { ch: string; len: number } | null = null
  let changed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (fence) {
      const m = FENCE_CLOSE.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
      out.push(line)
      i += 1
      continue
    }
    const fo = FENCE_OPEN.exec(line)
    if (fo) {
      fence = { ch: fo[2][0], len: fo[2].length }
      out.push(line)
      i += 1
      continue
    }
    const isLast = i === lines.length - 1
    if (!OPENUI_ROOT_LINE_RE.test(line) && !(isLast && BARE_ROOT_TAIL_RE.test(line))) {
      out.push(line)
      i += 1
      continue
    }
    const pre: string[] = []
    while (out.length && OPENUI_STATEMENT_LINE_RE.test(out[out.length - 1]) && /\(/.test(out[out.length - 1])) {
      pre.unshift(out.pop()!)
    }
    if (out.length && OPENUI_LABEL_LINE_RE.test(out[out.length - 1])) out.pop()
    const block: string[] = []
    let depth = 0
    let stmts = 0
    let j = i
    while (j < lines.length) {
      const l = lines[j]
      if (depth > 0) {
        block.push(l)
        depth += bracketDelta(l)
        j += 1
        continue
      }
      if (j === i || OPENUI_STATEMENT_LINE_RE.test(l)) {
        block.push(l)
        stmts += 1
        depth = Math.max(0, bracketDelta(l))
        j += 1
        continue
      }
      if (!l.trim()) {
        let k = j
        while (k < lines.length && !lines[k].trim()) k += 1
        if (k < lines.length && OPENUI_STATEMENT_LINE_RE.test(lines[k])) {
          while (j < k) block.push(lines[j++])
          continue
        }
      }
      break
    }
    const reachedEnd = j >= lines.length
    const valid = stmts + pre.length >= 2 || reachedEnd || /\bCard\s*\(/.test(line)
    if (!valid) {
      out.push(...pre, line)
      i += 1
      continue
    }
    while (block.length && !block[block.length - 1].trim()) block.pop()
    out.push('```openui bare', ...pre, ...block, '```')
    changed = true
    i = j
  }
  return changed ? out.join('\n') : text
}

/** 流式收尾保障：未闭合的 openui 围栏补上闭合围栏（网页版 :375-398）。 */
function closeUnterminatedOpenUIFence(text: string): string {
  let open: { ch: string; len: number; lang: string } | null = null
  for (const line of text.split('\n')) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line)
      if (!m) continue
      const fence = m[2]
      const info = m[3].trim()
      if (fence[0] === '`' && info.includes('`')) continue
      open = { ch: fence[0], len: fence.length, lang: info.split(/\s+/)[0] ?? '' }
    } else {
      const m = FENCE_CLOSE.exec(line)
      if (!m) continue
      const fence = m[1]
      if (fence[0] === open.ch && fence.length >= open.len) open = null
    }
  }
  if (!open || !isOpenUILang(open.lang)) return text
  const gap = text.endsWith('\n') ? '' : '\n'
  return `${text}${gap}${open.ch.repeat(open.len)}`
}

/** 兜底：openui 围栏里出现「```正文」粘连行时拆成「```」+「正文」（网页版 :407-440）。 */
function splitGluedOpenUIFenceClose(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let open: { ch: string; len: number; openui: boolean } | null = null
  let changed = false
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line)
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        open = { ch: m[2][0], len: m[2].length, openui: isOpenUILang(m[3].trim().split(/\s+/)[0] ?? '') }
      }
      out.push(line)
      continue
    }
    const close = FENCE_CLOSE.exec(line)
    if (close) {
      if (close[1][0] === open.ch && close[1].length >= open.len) open = null
      out.push(line)
      continue
    }
    if (open.openui) {
      const glued = /^( {0,3})(`{3,}|~{3,})[ \t]*(\S.*)$/.exec(line)
      if (glued && glued[2][0] === open.ch && glued[2].length >= open.len) {
        out.push(`${glued[1]}${glued[2]}`, glued[3])
        open = null
        changed = true
        continue
      }
    }
    out.push(line)
  }
  return changed ? out.join('\n') : text
}

/** markdown 文本 → 结构化块序列。解析失败退回单段纯文本，不吞内容。 */
export function parseAgentMarkdown(text: string): MdBlock[] {
  try {
    return parseBlocks(closeUnterminatedOpenUIFence(fenceBareOpenUI(splitGluedOpenUIFenceClose(text))))
  } catch {
    return [{ type: 'p', children: [{ k: 'text', text }] }]
  }
}

/** 收集一段 markdown 里所有图片 URL（缩略图点开时整条消息共用一份预览序列）。 */
export function collectImageUrls(blocks: MdBlock[]): string[] {
  const urls: string[] = []
  const pushInline = (spans: MdInline[]): void => {
    for (const span of spans) {
      if (span.k === 'img') {
        if (!urls.includes(span.src)) urls.push(span.src)
      } else if (span.k === 'strong' || span.k === 'em' || span.k === 'del' || span.k === 'link') {
        pushInline(span.children)
      }
    }
  }
  const pushBlock = (block: MdBlock): void => {
    switch (block.type) {
      case 'p':
      case 'h':
        pushInline(block.children)
        break
      case 'quote':
        block.blocks.forEach(pushBlock)
        break
      case 'list':
        block.items.forEach(pushInline)
        break
      case 'table':
        block.head.forEach(pushInline)
        block.rows.forEach((row) => row.forEach(pushInline))
        break
      case 'code':
        break
    }
  }
  blocks.forEach(pushBlock)
  return urls
}
