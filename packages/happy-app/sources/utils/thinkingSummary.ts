/** The legacy reducer wraps public thought summaries in Markdown emphasis. */
export function thinkingSummary(text: string): string {
    return text.startsWith('*') && text.endsWith('*') ? text.slice(1, -1) : text;
}
