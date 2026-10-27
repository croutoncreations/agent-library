// Escape-first minimal Markdown renderer. All text is HTML-escaped before any markup is
// introduced; raw HTML is never passed through; links are restricted to http(s)/mailto.
// Images: only references to PNG artifacts of the SAME project (resolved by the caller through
// `image`) render as <img>, served by the authenticated same-origin content route. Anything else
// (external URLs, data:, other projects, missing) renders as text: no external fetches.
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Resolves an image reference (an artifact ID) to a same-origin content URL, or null. */
export type ImageResolver = (ref: string) => string | null;
/** Artifact IDs referenced as images: ![alt](art_…). Used by the caller to batch-resolve. */
export function imageRefs(src: string): string[] {
  return [...new Set([...src.matchAll(/!\[[^\]]*\]\((art_[A-Za-z0-9_-]{1,64})\)/g)].map((m) => m[1]))].slice(0, 50);
}

function inline(raw: string, image?: ImageResolver): string {
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, ref) => {
    const url = image && /^art_[A-Za-z0-9_-]{1,64}$/.test(ref) ? image(ref) : null;
    if (!url) return `[image: ${alt}]`;
    // alt is already escaped; url is built server-side from validated IDs (no user text).
    return `<img src="${esc(url)}" alt="${alt}" loading="lazy" data-artifact="${ref}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = url.replace(/&amp;/g, "&");
    if (!/^(https?:|mailto:)/i.test(u)) return text;
    return `<a href="${esc(u)}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(src: string, image?: ImageResolver): string {
  const inline_ = (s: string) => inline(s, image);
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline_(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush(); closeList();
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush(); closeList();
      out.push(`<h${m[1].length}>${inline_(m[2])}</h${m[1].length}>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line)) || (m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      flush();
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline_(m[1])}</li>`);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flush(); closeList();
      out.push(`<blockquote>${inline_(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      flush(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush(); closeList();
  return out.join("\n");
}
