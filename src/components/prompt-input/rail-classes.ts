/**
 * 三行控制 rail 类常量（Task 9 自 PromptInput 抽出）：GenerateControls /
 * EditPanel / UpscalePanel 的每一行控件共用同一套标签栏／滑动栏／行骨架。
 */
/**
* 三行控制共用同一条左侧标签栏，让画质／风格／示例读起来是同一层级。
* 每行控件统一 36px 高，标签因此可以直接垂直居中对齐。
*/
export const LABEL_CLASS = "w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]";

/**
* 始终单行横向滑动，绝不换行：换行会把标签挤到两行中间形成错位，
* 并留下「4+1」「5+2」这样的孤儿行。宽屏放得下就是一整行，
* 放不下就横滑，两种情况标签都对齐。
*/
export const RAIL_CLASS =
"flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
* 每一行都是「固定宽度标签 + 可收缩控件区」。min-w-0 不是保险而是必需：
* 控件区里的胶囊都是 flex-shrink:0 + nowrap，少了它，行的 min-content 会等于
* 所有胶囊的总宽，向上顶宽卡片、顶宽 grid 列，最终把整个页面推得横向溢出。
* 装不下时应该是控件区内部横滑，而不是把版面撑破。
*/
export const ROW_CLASS = "flex min-w-0 items-center gap-2";
