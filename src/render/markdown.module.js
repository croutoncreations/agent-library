// src/markdown.ts
var esc2 = /* @__PURE__ */ __name((s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"), "esc");
function imageRefs(src) {
  return [...new Set([...src.matchAll(/!\[[^\]]*\]\((art_[A-Za-z0-9_-]{1,64})\)/g)].map((m) => m[1]))].slice(0, 50);
}
__name(imageRefs, "imageRefs");
function inline(raw, image) {
  const codes = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc2(c)}</code>`);
    return `\0${codes.length - 1}\0`;
  });
  s = esc2(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, ref) => {
    const m = image && /^art_[A-Za-z0-9_-]{1,64}$/.test(ref) ? image(ref) : null;
    if (!m) return `[image: ${alt}]`;
    if (m.mime.startsWith("video/"))
      return `<video src="${esc2(m.url)}" controls playsinline preload="metadata" title="${alt}" data-artifact="${ref}"></video>`;
    return `<img src="${esc2(m.url)}" alt="${alt}" loading="lazy" data-artifact="${ref}">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = url.replace(/&amp;/g, "&");
    if (!/^(https?:|mailto:)/i.test(u)) return text;
    return `<a href="${esc2(u)}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}
__name(inline, "inline");
// GFM pipe tables. A table is a header row, a delimiter row (---, :--, --:, :-:) with the same number of
// cells, then body rows until a blank or non-pipe line. Cells split on unescaped "|" outside inline code;
// "\|" renders a literal pipe. Every cell goes through the same escape-first inline renderer as paragraphs,
// so no raw HTML is ever produced. Alignment is emitted as a class (no inline style; the app CSP forbids it).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "", code = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      code = code === 0 ? n : (code === n ? 0 : code);
      cur += s.slice(i, i + n); i += n - 1; continue;
    }
    if (c === "|" && code === 0) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
__name(splitRow, "splitRow");
// Line breaks inside a pipe-table cell. GFM has no multi-line cell syntax; the standard convention is an inline
// <br>. Only these exact tokens are recognized, case-insensitively: <br>, <br/>, <br /> (whitespace before the
// slash/close only, no attributes). They are honored only OUTSIDE inline code and not after a backslash; everything
// else, including any other tag or a <br> with attributes, stays escaped text. Each segment is rendered by the normal
// escape-first inline renderer and segments are joined with a server-generated <br>, so no source markup is passed on.
var CELL_BR = /^<br[ \t]*\/?>/i, CELL_MAX_BREAKS = 32;
// Inline-code spans in a cell, matched like inline(): a backtick run opens, the next run of the same length closes;
// a run that never closes is plain text. Returns [start, end) ranges (linear: each run is examined once).
function codeRanges(cell) {
  const runs = [];
  for (let i = 0; i < cell.length; i++) if (cell[i] === "`") { let n = 1; while (cell[i + n] === "`") n++; runs.push([i, n]); i += n - 1; }
  const out = [], nextOfLen = new Map();
  for (let k = runs.length - 1; k >= 0; k--) { runs[k][2] = nextOfLen.get(runs[k][1]); nextOfLen.set(runs[k][1], k); }
  for (let k = 0; k < runs.length; k++) { const close = runs[k][2]; if (close !== void 0) { out.push([runs[k][0], runs[close][0] + runs[close][1]]); k = close; } }
  return out;
}
__name(codeRanges, "codeRanges");
function cellSegments(cell) {
  if (cell.indexOf("<") < 0) return [cell];
  const code = codeRanges(cell), segs = [];
  let start = 0, r = 0;
  for (let i = 0; i < cell.length && segs.length < CELL_MAX_BREAKS; i++) {
    while (r < code.length && code[r][1] <= i) r++;
    if (r < code.length && code[r][0] <= i) { i = code[r][1] - 1; continue; }
    if (cell[i] === "<" && cell[i - 1] !== "\\" && (cell[i + 1] === "b" || cell[i + 1] === "B")) {
      const m = CELL_BR.exec(cell.slice(i, i + 16));
      if (m) { segs.push(cell.slice(start, i)); i += m[0].length - 1; start = i + 1; }
    }
  }
  segs.push(cell.slice(start));
  return segs;
}
__name(cellSegments, "cellSegments");
// Joined with " <br>": the space is collapsed before the break when rendered, but keeps the words apart in
// textContent (screen-reader table labels and the cards' column labels read "Owner Team", not "OwnerTeam").
function renderCell(cell, inline_) {
  return cellSegments(cell).map((s) => inline_(s.trim())).join(" <br>");
}
__name(renderCell, "renderCell");
// Bounds keep rendering linear and the output proportional to the input (no padding blow-up, no deep recursion).
// TABLE_MAX_CELLS is a budget for the WHOLE document (all tables together), so repeated tables cannot multiply output.
var TABLE_MAX_LINE = 4096, TABLE_MAX_COLS = 64, TABLE_MAX_CELLS = 20000;
// Delimiter row, checked without backtracking: drop spaces/tabs, then a fixed pattern with no \s or nested optionals.
var TABLE_DELIM = /^\|?:?-+:?(?:\|:?-+:?)*\|?$/;
function isTableStart(lines, i, budget) {
  const head = lines[i], delim = lines[i + 1];
  if (delim === void 0 || head.length > TABLE_MAX_LINE || delim.length > TABLE_MAX_LINE || head.indexOf("|") < 0 || delim.indexOf("|") < 0) return false;
  if (!TABLE_DELIM.test(delim.replace(/[ \t]/g, ""))) return false;
  const n = splitRow(head).length;
  return n <= TABLE_MAX_COLS && n <= budget.cells && n === splitRow(delim).length;
}
__name(isTableStart, "isTableStart");
function renderTable(lines, i, inline_, budget) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((d) => d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : "");
  const rows = [];
  let j = i + 2;
  // GFM: short rows are padded, extra cells are dropped (they cannot be addressed by a header).
  // A body row is any following non-blank line with a pipe; the table also ends when the cell budget is used up
  // (the rest of the document continues as normal paragraphs).
  for (; j < lines.length && lines[j].trim() !== "" && lines[j].indexOf("|") >= 0 && lines[j].length <= TABLE_MAX_LINE && (rows.length + 2) * head.length <= budget.cells; j++) rows.push(splitRow(lines[j]));
  budget.cells -= (rows.length + 1) * head.length;
  // Width hint per column from the longest cell's visible text (markup characters excluded), so prose columns
  // keep a readable minimum width on phones instead of collapsing to a word per line. Classes only (CSP: no inline styles).
  // Width hint uses the longest visible line of a cell (a <br> starts a new line).
  const plain = (c) => Math.max(0, ...cellSegments(c ?? "").map((x) => x.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").length));
  const width = head.map((h, k) => { let w = plain(h); for (const r of rows) w = Math.max(w, plain(r[k])); return w; });
  const cls = (k) => {
    const c = [align[k] && `al-${align[k]}`, width[k] > 40 ? "w-long" : width[k] > 16 ? "w-mid" : ""].filter(Boolean).join(" ");
    return c ? ` class="${c}"` : "";
  };
  const out = [`<table><thead><tr>${head.map((c, k) => `<th scope="col"${cls(k)}>${renderCell(c, inline_)}</th>`).join("")}</tr></thead>`];
  if (rows.length) out.push(`<tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td${cls(k)}>${renderCell(r[k] ?? "", inline_)}</td>`).join("")}</tr>`).join("")}</tbody>`);
  out.push("</table>");
  return { html: out.join(""), next: j };
}
__name(renderTable, "renderTable");
function renderMarkdown(src, image) {
  const inline_ = /* @__PURE__ */ __name((s) => inline(s, image), "inline_");
  const tableBudget = { cells: TABLE_MAX_CELLS };
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out2 = [];
  let list2 = null;
  let para = [];
  const flush = /* @__PURE__ */ __name(() => {
    if (para.length) out2.push(`<p>${inline_(para.join(" "))}</p>`);
    para = [];
  }, "flush");
  const closeList = /* @__PURE__ */ __name(() => {
    if (list2) out2.push(`</${list2}>`);
    list2 = null;
  }, "closeList");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      closeList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out2.push(`<pre><code>${esc2(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (isTableStart(lines, i, tableBudget)) {
      flush();
      closeList();
      const t = renderTable(lines, i, inline_, tableBudget);
      out2.push(t.html);
      i = t.next - 1;
      continue;
    }
    let m;
    if (m = /^(#{1,6})\s+(.*)$/.exec(line)) {
      flush();
      closeList();
      out2.push(`<h${m[1].length}>${inline_(m[2])}</h${m[1].length}>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line)) || (m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      flush();
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list2 !== kind) {
        closeList();
        out2.push(`<${kind}>`);
        list2 = kind;
      }
      out2.push(`<li>${inline_(m[1])}</li>`);
    } else if (m = /^>\s?(.*)$/.exec(line)) {
      flush();
      closeList();
      out2.push(`<blockquote>${inline_(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      flush();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush();
  closeList();
  return out2.join("\n");
}
__name(renderMarkdown, "renderMarkdown");
