/**
 * Neither surface renders markdown: the Telegram menu agent sends WITHOUT a
 * parse_mode, and the app's chat bubbles are plain text (`ChatReplySplitter`
 * on iOS). Any "**bold**", "__underline__" or "`code`" the model sneaks in would
 * show up as literal symbols. BASE_PERSONA forbids it; this is the safety net
 * both agents run their replies through.
 */
export function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}
