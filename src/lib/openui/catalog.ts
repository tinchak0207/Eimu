/**
 * OpenUI 组件白名单——唯一真源（2026-10-18）。
 *
 * 四处消费同一份清单，保证「网关提示词里允许的组件 = 前端能渲染的组件」：
 *   1. `eimu-library.ts`：按本清单注册渲染组件；
 *   2. `tools/gen-openui-prompt.mts`：生成网关 system prompt（签名 + 白名单行），
 *      并断言 prompt 里出现的组件集合与本清单逐一相等；
 *   3. `repair.ts`：模型写错名字时的别名/模糊映射目标集合；
 *   4. `agent-markdown.ts`：裸 DSL（未套围栏）识别的轻量判据。
 *
 * 本档必须保持零依赖（不 import react / @openuidev/*），因为 agent-markdown
 * 在主聊天 bundle 里，不能把 OpenUI 运行时拖进主包。
 */

/**
 * 注册顺序即提示词里的签名顺序。
 *
 * 2026-10-18 改造（产品哲学纠偏）：OpenUI 是「AI 拿到成品后自动生成的展示层」，
 * 不是参数收集面板。表单/控制台类组件（Form、FormControl、Input、TextArea、Select、
 * Slider、RadioGroup、CheckBoxGroup、OptionCards、Steps、Table、Tag 等）全部移出白名单；
 * 成品组件只收 taskId（会话产物 task_id，或任务表里该产物的原 URL），由前端从会话产物
 * 里查真实条目渲染，查不到显示「产物未找到」——模型无法凭空编造媒体。
 */
export const OPENUI_COMPONENTS = [
  // 布局 / 文本
  "Card",
  "CardHeader",
  "TextContent",
  "Callout",
  "Separator",
  // 成品展示（绑定会话真实产物）
  "ImageResult",
  "ImageGallery",
  "VideoPlayer",
  "AudioPlayer",
  "AlbumPlayer",
  "CompareView",
  "DeliverableCard",
  // 一键快选（≤4，自动模式不出）
  "Button",
  "Buttons",
] as const;

/**
 * 已移出白名单的组件（含上游 chat 库里常被模型写出的控制台/表单类）。repair.ts 遇到它们
 * 直接删掉该语句并清理引用——不再降级成「未识别组件」提示框，避免把表单残骸展示给用户。
 */
export const OPENUI_REMOVED_COMPONENTS = [
  "Form",
  "FormControl",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "Slider",
  "RadioGroup",
  "RadioItem",
  "CheckBoxGroup",
  "CheckBoxItem",
  "OptionCards",
  "OptionCard",
  "Steps",
  "StepsItem",
  "Table",
  "Col",
  "Tag",
  "TagBlock",
  "Icon",
  "IconText",
  "DatePicker",
  "Chips",
  "Switch",
  "Toggle",
  "EditableTable",
  "MetricIndicator",
  "MetricIndicatorInline",
  "LineChart",
  "AreaChart",
  "BarChart",
  "PieChart",
  "Tabs",
  "Accordion",
  "ListBlock",
  "FollowUpBlock",
] as const;

export const OPENUI_REMOVED_SET: ReadonlySet<string> = new Set(
  OPENUI_REMOVED_COMPONENTS.map((n) => n.toLowerCase()),
);

export type OpenUIComponentName = (typeof OPENUI_COMPONENTS)[number];

export const OPENUI_COMPONENT_SET: ReadonlySet<string> = new Set(OPENUI_COMPONENTS);

/** 内置动作（@Name）白名单。 */
export const OPENUI_ACTIONS = ["ToAssistant", "OpenUrl"] as const;

/**
 * 常见误名 → 白名单组件（key 一律小写、去掉 `_`/`-`）。
 * 值为白名单名时直接改名；值以 `text:` 开头表示「把参数里的文字收成
 * TextContent」，`image:` 表示「转成 ImageResult(src)」，`removed:` 表示「已移除的
 * 表单/控制台类组件，整条删除」。
 */
export const OPENUI_COMPONENT_ALIASES: Record<string, string> = {
  // 容器 / 标题
  container: "Card",
  panel: "Card",
  header: "CardHeader",
  title: "CardHeader",
  heading: "CardHeader",
  cardtitle: "CardHeader",
  // 文本类（已从库中移除或模型臆造）→ TextContent
  text: "text:",
  boldtext: "text:",
  paragraph: "text:",
  markdown: "text:",
  markdownrenderer: "text:",
  inlineheader: "text:",
  label: "text:",
  codeblock: "text:",
  subtitle: "text:",
  description: "text:",
  note: "text:",
  // 提示
  alert: "Callout",
  notice: "Callout",
  banner: "Callout",
  divider: "Separator",
  hr: "Separator",
  // 成品（旧 Image/ImageBlock 写法 → ImageResult(src)，src 仍须是会话真实产物）
  image: "image:",
  img: "image:",
  picture: "image:",
  imageblock: "image:",
  gallery: "ImageGallery",
  imagegrid: "ImageGallery",
  carousel: "ImageGallery",
  video: "VideoPlayer",
  videoblock: "VideoPlayer",
  player: "VideoPlayer",
  audio: "AudioPlayer",
  audioblock: "AudioPlayer",
  musicplayer: "AudioPlayer",
  album: "AlbumPlayer",
  playlist: "AlbumPlayer",
  compare: "CompareView",
  comparison: "CompareView",
  blindpick: "CompareView",
  deliverable: "DeliverableCard",
  delivery: "DeliverableCard",
  // 表单/控制台类 → 删除（见 OPENUI_REMOVED_COMPONENTS）
  textfield: "removed:",
  textinput: "removed:",
  textbox: "removed:",
  multilineinput: "removed:",
  dropdown: "removed:",
  picker: "removed:",
  combobox: "removed:",
  option: "removed:",
  selectoption: "removed:",
  dropdownitem: "removed:",
  range: "removed:",
  rangeslider: "removed:",
  radio: "removed:",
  radiobutton: "removed:",
  radiooption: "removed:",
  radiogroups: "removed:",
  radios: "removed:",
  checkbox: "removed:",
  checkboxes: "removed:",
  checkboxlist: "removed:",
  choice: "removed:",
  choicecard: "removed:",
  optioncarditem: "removed:",
  choices: "removed:",
  choicecards: "removed:",
  optiongrid: "removed:",
  field: "removed:",
  formfield: "removed:",
  formitem: "removed:",
  step: "removed:",
  stepitem: "removed:",
  column: "removed:",
  badge: "removed:",
  chip: "removed:",
  // 按钮
  btn: "Button",
  actionbutton: "Button",
  buttongroup: "Buttons",
  buttonrow: "Buttons",
  actions: "Buttons",
  btngroup: "Buttons",
};

/** 动作误名 → 白名单动作（key 小写）。 */
export const OPENUI_ACTION_ALIASES: Record<string, string> = {
  toassistant: "ToAssistant",
  send: "ToAssistant",
  sendmessage: "ToAssistant",
  reply: "ToAssistant",
  submit: "ToAssistant",
  tochat: "ToAssistant",
  openurl: "OpenUrl",
  open: "OpenUrl",
  link: "OpenUrl",
  navigate: "OpenUrl",
};

/** 判定一行像不像 openui 语句的轻量正则（裸 DSL 识别用）。 */
export const OPENUI_ROOT_LINE_RE = /^\s*root\s*=\s*[A-Za-z_][\w]*\s*\(/;
export const OPENUI_STATEMENT_LINE_RE =
  /^\s*[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_][\w]*\s*\(|@[A-Za-z]|\[|\{|"|\$|-?\d|true\b|false\b|null\b)/;
