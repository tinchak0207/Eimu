export function insertPromptSnippet(basePrompt: string, snippet: string): string {
  const current = basePrompt.trim();
  const addition = snippet.trim();

  if (!addition) return current;
  if (!current) return addition;
  if (current.includes(addition)) return current;

  return `${current}\n\n${addition}`;
}

/**
 * 示例模板替换：连点多个模板只保留最新一个——先把上一次插入的模板段落
 * （以空行分段精确匹配）剔除，再插入新模板；手打的普通文字不受影响。
 * 例：「普通文字 + 模板1 + 模板2」→「普通文字 + 模板2」。
 */
export function replacePromptSnippet(
  basePrompt: string,
  previousSnippet: string | null,
  nextSnippet: string,
): string {
  const previous = previousSnippet?.trim();
  let base = basePrompt;
  if (previous && base.includes(previous)) {
    base = base
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part && part !== previous)
      .join("\n\n");
  }
  return insertPromptSnippet(base, nextSnippet);
}

export function replacePromptStyleSuffix(
  basePrompt: string,
  nextSuffix: string | undefined,
  styleSuffixes: readonly string[],
): string {
  const promptWithoutStyle = basePrompt
    .trim()
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && !styleSuffixes.includes(part))
    .join("\n\n");

  return nextSuffix ? insertPromptSnippet(promptWithoutStyle, nextSuffix) : promptWithoutStyle;
}
