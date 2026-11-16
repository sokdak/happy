/**
 * The legacy reducer wraps public thought summaries in a single outer `*...*`
 * pair (`*${thinking}*`). Unwrap that single outer wrapper without corrupting
 * already-unwrapped strings that begin and end with separate single-line
 * `*italic*` spans (such as `*Step 1* and *Step 2*`).
 */
export function thinkingSummary(text: string): string {
    if (text.length < 2 || !text.startsWith('*') || !text.endsWith('*')) {
        return text;
    }
    if (!text.startsWith('**')) {
        const leadingSpan = text.match(/^\*[^\s*\r\n](?:[^*\r\n]*[^\s*\r\n])?\*(?!\*)/);
        if (leadingSpan && leadingSpan[0].length < text.length) {
            return text;
        }
    }
    return text.slice(1, -1);
}
