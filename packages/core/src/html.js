import { __name } from "./runtime.js";

var ART = /^art_[A-Za-z0-9_-]{1,64}$/;
var DROP_WITH_CONTENT = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "portal", "math", "svg", "xmp", "plaintext", "noembed", "noframes"];
var DROP_TAG_ONLY = ["base", "meta", "link", "form", "input", "button", "select", "textarea", "option", "dialog", "slot"];
var URL_ATTRS = /* @__PURE__ */ new Set(["href", "src", "poster", "action", "formaction", "background", "cite", "longdesc", "srcset", "data", "xlink:href", "ping", "manifest", "lowsrc", "dynsrc", "codebase", "archive", "usemap", "icon", "profile"]);
function htmlRefs(src) {
  const out2 = /* @__PURE__ */ new Set();
  for (const m of src.matchAll(/\b(?:src|poster|href)\s*=\s*["']?(art_[A-Za-z0-9_-]{1,64})/gi)) out2.add(m[1]);
  return [...out2].slice(0, 100);
}
var esc3 = /* @__PURE__ */ __name((s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "esc");
function decodeForCheck(v) {
  return v.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 1114111))).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 1114111))).replace(/&(tab|newline|colon);?/gi, (_, n) => ({ tab: "	", newline: "\n", colon: ":" })[n.toLowerCase()]).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "").toLowerCase();
}
function safeUrl(tag, attr, raw, media) {
  const v = raw.trim();
  if (ART.test(v)) {
    const r = media(v);
    if (!r) return null;
    if (attr === "href" && tag === "a") return r.url;
    if (attr === "src" && ["img", "video", "audio", "source"].includes(tag) || attr === "poster" && tag === "video") return r.url;
    return null;
  }
  const d = decodeForCheck(v);
  if (tag === "a" && attr === "href") {
    if (d.startsWith("#")) return v;
    if (/^(https?:|mailto:)/.test(d)) return v;
    return null;
  }
  return null;
}
function safeCss(css) {
  let s = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  if (/\\/.test(s)) s = s.split(/(?<=[;{}])/).filter((part) => !/\\/.test(part)).join("");
  s = s.replace(/@import[^;]*;?/gi, "").replace(/@font-face\s*\{[^}]*\}/gi, "").replace(/@namespace[^;]*;?/gi, "");
  s = s.replace(/url\s*\([^)]*\)/gi, "none").replace(/image-set\s*\([^)]*\)/gi, "none").replace(/(?:-webkit-)?cross-fade\s*\([^)]*\)/gi, "none");
  s = s.replace(/expression\s*\(/gi, "x(").replace(/behavior\s*:/gi, "x:").replace(/-moz-binding\s*:/gi, "x:");
  return s.replace(/<\/?\s*style/gi, "");
}
function cleanAttrs(tag, attrStr, media) {
  const out2 = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  const seen = /* @__PURE__ */ new Set();
  while (m = re.exec(attrStr)) {
    const name = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "is" || name.includes(":") && name !== "xml:lang") continue;
    if (name === "style") {
      const c = safeCss(val);
      if (c.trim()) out2.push(`style="${esc3(c)}"`);
      continue;
    }
    if (name === "target") continue;
    if (URL_ATTRS.has(name)) {
      if (name === "srcset" || !["href", "src", "poster"].includes(name)) continue;
      const u = safeUrl(tag, name, val, media);
      if (u === null) continue;
      out2.push(`${name}="${esc3(u)}"`);
      if (tag === "a" && name === "href" && /^(https?:|mailto:)/i.test(val.trim())) out2.push(`target="_blank" rel="noopener noreferrer nofollow"`);
      else if (tag === "a" && name === "href" && ART.test(val.trim())) out2.push(`target="_blank" rel="noopener"`);
      continue;
    }
    if (!/^[a-z][a-z0-9_.-]*$/.test(name)) continue;
    out2.push(m[2] === void 0 && m[3] === void 0 && m[4] === void 0 ? name : `${name}="${esc3(val)}"`);
  }
  if ((tag === "video" || tag === "audio") && !seen.has("controls")) out2.push("controls");
  if (tag === "video" && !seen.has("playsinline")) out2.push("playsinline");
  if (tag === "img" && !seen.has("loading")) out2.push(`loading="lazy"`);
  return out2.length ? " " + out2.join(" ") : "";
}
function sanitizeHtml(src, media) {
  let s = src.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "").replace(/<!doctype[^>]*>/gi, "").replace(/<\?[\s\S]*?(?:\?>|>|$)/g, "");
  const css = [];
  s = s.replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi, (_, c) => {
    css.push(safeCss(c));
    return "";
  });
  for (const t of [...DROP_WITH_CONTENT, "title"]) s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?(?:<\\/${t}\\s*>|$)`, "gi"), "");
  const out2 = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  let last = 0, m;
  const text = (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  while (m = tagRe.exec(s)) {
    out2.push(text(s.slice(last, m.index)));
    last = tagRe.lastIndex;
    const close = m[1] === "/", tag = m[2].toLowerCase();
    if (DROP_TAG_ONLY.includes(tag) || DROP_WITH_CONTENT.includes(tag) || tag === "html" || tag === "head" || tag === "body" || tag === "title" || tag === "style") continue;
    if (close) {
      out2.push(`</${tag}>`);
      continue;
    }
    out2.push(`<${tag}${cleanAttrs(tag, m[3] || "", media)}${m[4] ? " /" : ""}>`);
  }
  out2.push(text(s.slice(last)));
  return { html: out2.join(""), css: css.join("\n") };
}
var RENDER_CSP = "default-src 'none'; script-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox";
var FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";
function renderHtmlDocument(src, media, title) {
  const { html, css } = sanitizeHtml(src, media);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc3(title)}</title><style>html{color-scheme:light dark;background:Canvas;color:CanvasText}body{margin:0;padding:16px;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-wrap:anywhere}img,video{max-width:100%;height:auto}video{display:block}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:.3em .5em}pre{overflow:auto}</style>` + (css ? `<style>${css}</style>` : "") + `</head><body>${html}</body></html>`;
}

export { FRAME_SANDBOX, RENDER_CSP, htmlRefs, renderHtmlDocument };
