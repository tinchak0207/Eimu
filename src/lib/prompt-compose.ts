export function insertPromptSnippet(basePrompt: string, snippet: string): string {
  const current = basePrompt.trim();
  const addition = snippet.trim();

  if (!addition) return current;
  if (!current) return addition;
  if (current.includes(addition)) return current;

  return `${current}\n\n${addition}`;
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
