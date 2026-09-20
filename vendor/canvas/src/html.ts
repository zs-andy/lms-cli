/**
 * Lightweight HTML → plain text conversion for Canvas rich-content fields
 * (syllabus bodies, assignment descriptions, announcements, pages).
 */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&rdquo;": '"',
  "&ldquo;": '"',
};

/**
 * Trim quoted reply chains from Canvas conversation messages. Canvas relays
 * replies sent by email, so each message often carries the entire prior thread
 * below an Outlook-style separator line.
 */
export function trimQuotedReply(body: string | null | undefined, maxLen = 2000): string {
  if (!body) return "";
  let text = body;

  const separators = [
    /\n_{10,}\s*\n/, // Outlook: a run of underscores
    /\n-{5,}\s*Original Message\s*-{5,}/i,
    /\nOn .{10,80} wrote:\s*\n/, // Gmail-style attribution
  ];
  for (const sep of separators) {
    const m = text.match(sep);
    if (m && m.index !== undefined && m.index > 40) {
      text = text.slice(0, m.index) + "\n[quoted thread trimmed]";
      break;
    }
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxLen ? text.slice(0, maxLen) + "\n… [truncated]" : text;
}

export function htmlToText(html: string | null | undefined, maxLen = 6000): string {
  if (!html) return "";

  let text = html
    // Drop script/style blocks entirely.
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // Keep link targets: <a href="url">text</a> → text (url)
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      if (!label) return href;
      return href.startsWith("http") && label !== href ? `${label} (${href})` : label;
    })
    // Structural tags → line breaks / bullets.
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, "  ")
    // Strip all remaining tags.
    .replace(/<[^>]+>/g, "");

  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  // Numeric entities.
  text = text.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));

  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "\n… [truncated]";
  }
  return text;
}
