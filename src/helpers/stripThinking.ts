// Strip <think>...</think> blocks (including unterminated ones) emitted by
// reasoning models. Innermost closed pairs are removed first so nested blocks
// cannot leave a stray </think>, then a trailing unterminated <think> is removed,
// and finally any orphan </think> tags are stripped.
// Callers pass inference output (string); the runtime guard keeps the old
// pass-through for anything else instead of rejecting.
function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export function stripThinkingTags<T>(text: T): string | T {
  if (!isString(text)) return text;
  const innermostClosed = /<think>(?:(?!<think>)[\s\S])*?<\/think>/i;
  let out: string = text;
  let next = out.replace(innermostClosed, "");

  while (next !== out) {
    out = next;
    next = out.replace(innermostClosed, "");
  }

  return next
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/<\/think>/gi, "")
    .trim();
}
