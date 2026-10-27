// OWNED BY UI WORKER. Vanilla-JS single-page app served at /, /app.js and /app.css.
// CSP: script-src 'self'; style-src 'self' -> no inline scripts, handlers or style attributes.
// All dynamic text is set via textContent/value; only the server-sanitized Markdown preview uses innerHTML.

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Agent Library</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top"><a class="brand" href="#/" aria-label="Agent Library home"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h6"/></svg></span><span class="name">Agent Library</span></a><nav id="crumbs" class="crumbs"></nav><span id="who" class="who"></span></header>
<main id="app"><p class="muted">Loading…</p></main>
</body>
</html>
`;

export const APP_CSS = `
/* Design: quiet, dense, Nibit-like. Near-black dark theme, soft light theme, pill buttons, hairline borders,
   icon buttons for secondary actions. Follows the device colour scheme. */
:root{--bg:#f6f6f8;--fg:#14141a;--muted:#6b6b76;--faint:#9a9aa5;--line:#e3e3e8;--line2:#d4d4dc;--card:#fff;--field:#fff;--sunk:#f0f0f3;--hover:rgba(20,20,30,.06);
 --accent:#2f6bff;--accent-soft:rgba(47,107,255,.10);--on-accent:#fff;--ok:#16794a;--warn:#946200;--bad:#c4321f;
 --banner-bg:#fff7e3;--banner-line:#f0d58c;--err-bg:#fdeceb;--err-line:#f3c0ba;--ok-bg:#e8f6ee;--ok-line:#aedcbf;--conf-bg:#fff5f4;--shadow:0 1px 2px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.04);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0d;--fg:#f2f2f5;--muted:#9a9aa6;--faint:#6c6c78;--line:#1f1f26;--line2:#2c2c35;--card:#121217;--field:#0f0f13;--sunk:#17171d;--hover:rgba(255,255,255,.06);
 --accent:#6f9bff;--accent-soft:rgba(111,155,255,.14);--on-accent:#06091a;--ok:#4fd18b;--warn:#e8b54d;--bad:#ff7466;
 --banner-bg:#211c10;--banner-line:#4a3d17;--err-bg:#241311;--err-line:#57231d;--ok-bg:#0f2117;--ok-line:#1f4a31;--conf-bg:#1e1114;--shadow:none;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:.75rem;padding:.55rem 1rem;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;color:var(--fg);white-space:nowrap}.brand:hover{text-decoration:none}
.brand .mark{width:26px;height:26px;border-radius:7px;background:var(--accent-soft);color:var(--accent);display:inline-flex;align-items:center;justify-content:center}
.crumbs{display:flex;align-items:center;gap:.35rem;flex:1;min-width:0;font-size:.92rem;color:var(--muted)}
.crumbs a,.crumbs span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:18rem}
.crumbs a{color:var(--muted)}.crumbs a:hover{color:var(--fg);text-decoration:none}
.crumbs .sep{color:var(--faint)}
.who{position:relative;display:flex;gap:.25rem;align-items:center}
main{max-width:920px;margin:0 auto;padding:1.25rem 1rem 3rem}
h1{font-size:1.5rem;font-weight:700;letter-spacing:-.01em;margin:.1rem 0 .6rem;word-break:break-word}
h2{font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:1.6rem 0 .5rem}
.muted{color:var(--muted)}.small{font-size:.85rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;margin:.75rem 0;box-shadow:var(--shadow)}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.row>input[type=text],.row>input[type=search],.row>input:not([type]),.row>input[type=password]{flex:1 1 12rem;min-width:0}
.spacer{flex:1}
input,textarea,select,button{font:inherit;font-size:16px}
input,textarea,select{padding:.5rem .75rem;border:1px solid var(--line2);border-radius:10px;background:var(--field);color:var(--fg);max-width:100%;outline:none}
input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[type=checkbox]{width:1.05rem;height:1.05rem;accent-color:var(--accent)}
label{display:inline-flex;gap:.45rem;align-items:center}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-height:38px;padding:.35rem 1rem;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer;font-size:.92rem;font-weight:600;white-space:nowrap}
button:hover,.btn:hover{text-decoration:none;filter:brightness(1.06)}
button.secondary,.btn.secondary{background:transparent;color:var(--fg);border-color:var(--line2);font-weight:500}
button.secondary:hover,.btn.secondary:hover{background:var(--hover);filter:none}
button.danger{background:transparent;color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent);font-weight:500}
button.danger:hover{background:color-mix(in srgb,var(--bad) 10%,transparent);filter:none}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,.btn:focus-visible,a:focus-visible,.icon:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* icon buttons */
.icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-height:32px;padding:0;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-weight:400}
.icon:hover{background:var(--hover);color:var(--fg);filter:none;text-decoration:none}
.icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.icon.done{color:var(--ok)}
.icons{display:inline-flex;align-items:center;gap:.1rem}
.titlebar{display:flex;align-items:flex-start;gap:.5rem}.titlebar h1{flex:1;min-width:0}
.titlebar .icons{margin-top:.15rem}
/* menu */
.menu{position:absolute;right:0;top:calc(100% + 6px);min-width:15rem;background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:.35rem;box-shadow:0 10px 30px rgba(0,0,0,.18);z-index:20}
.menu a,.menu button{display:flex;width:100%;justify-content:flex-start;gap:.6rem;align-items:center;padding:.5rem .65rem;border-radius:8px;border:0;background:transparent;color:var(--fg);font-weight:500;min-height:36px;font-size:.92rem}
.menu a:hover,.menu button:hover{background:var(--hover);text-decoration:none;filter:none}
.menu .who-label{padding:.4rem .65rem .5rem;color:var(--muted);font-size:.82rem;border-bottom:1px solid var(--line);margin-bottom:.3rem}
.menu svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;color:var(--muted)}
/* lists */
.list{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
.list li{padding:.7rem 1rem;display:flex;flex-wrap:wrap;gap:.25rem .8rem;align-items:center;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}
.list li.link{cursor:pointer}.list li.link:hover{background:var(--hover)}
.list li .grow{flex:1 1 14rem;min-width:0;word-break:break-word}
.list li .grow a,.list li > a.grow{color:var(--fg);font-weight:500}
.list li.link:hover .grow a,.list li.link:hover > a.grow{color:var(--accent);text-decoration:none}
.list li.empty{color:var(--muted);justify-content:center}
.list small{display:block}
.badge{display:inline-block;font-size:.72rem;font-weight:600;padding:.1rem .5rem;border-radius:99px;color:var(--muted);background:var(--sunk);border:1px solid var(--line)}
.scope{display:grid;gap:.35rem;margin:.25rem 0 .75rem}.scope .row{margin:0}
small.warn{color:var(--danger,#c0392b)}
.badge.active{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent);border-color:transparent}
.tabs{display:flex;gap:.25rem;overflow-x:auto;margin:.5rem 0 .75rem;padding:.2rem;background:var(--sunk);border-radius:999px;width:fit-content;max-width:100%}
.tabs button{background:transparent;color:var(--muted);border:0;border-radius:999px;min-height:32px;padding:.2rem .9rem;font-weight:500}
.tabs button:hover{color:var(--fg);filter:none}
.tabs button[aria-selected=true]{background:var(--card);color:var(--fg);box-shadow:var(--shadow);font-weight:600}
.status{display:inline-flex;align-items:center;gap:.35rem;font-size:.82rem;color:var(--muted)}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}
.status[data-state=saved]::before{background:var(--ok)}
.status[data-state=saving]::before,.status[data-state=dirty]::before{background:var(--warn)}
.status[data-state=error],.status[data-state=conflict]{color:var(--bad);font-weight:600}
.status[data-state=error]::before,.status[data-state=conflict]::before{background:var(--bad)}
textarea.editor{width:100%;min-height:58vh;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14.5px;line-height:1.6;resize:vertical;border-radius:14px;padding:1rem}
textarea.editor[readonly]{background:var(--sunk)}
textarea.half{width:100%;min-height:12rem;font-family:ui-monospace,Menlo,monospace;font-size:14px}
.conflict{border:1px solid var(--bad);background:var(--conf-bg)}
.conflict .cols{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}
.banner{padding:.55rem .85rem;border-radius:10px;background:var(--banner-bg);border:1px solid var(--banner-line);margin:.5rem 0;font-size:.92rem}
.msg:empty{display:none}
.msg{padding:.55rem .85rem;border-radius:10px;background:var(--err-bg);border:1px solid var(--err-line);color:var(--bad);word-break:break-word;font-size:.92rem;margin:.5rem 0}
.msg.ok{background:var(--ok-bg);border-color:var(--ok-line);color:var(--ok)}
.preview{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.6rem 1.2rem;overflow-x:auto;word-break:break-word}
.preview img{max-width:100%;cursor:zoom-in;border-radius:8px;background:#fff}
.preview pre{overflow-x:auto;background:var(--sunk);padding:.7rem;border-radius:8px}
pre.raw{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem;max-height:50vh;overflow:auto}
.media img,.media video{max-width:100%;height:auto;display:block;border-radius:12px;background:#000}
.media img{background:#fff;border:1px solid var(--line);cursor:zoom-in}
.filecard{display:flex;align-items:center;gap:.9rem;padding:1rem;background:var(--card);border:1px solid var(--line);border-radius:14px}
.filecard .ficon{width:44px;height:44px;border-radius:10px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none}
.filecard .ficon svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.token{font-family:ui-monospace,Menlo,monospace;width:100%}
details{border-top:1px solid var(--line);margin-top:1rem;padding-top:.4rem}
details summary{cursor:pointer;font-weight:500;color:var(--muted);min-height:34px;display:flex;align-items:center;gap:.4rem;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"›";display:inline-block;transition:transform .15s;font-size:1.1rem}
details[open] summary::before{transform:rotate(90deg)}
details summary:hover{color:var(--fg)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:.6rem;margin:.5rem 0}
.grid2 label{flex-direction:column;align-items:stretch;gap:.25rem;font-size:.82rem;color:var(--muted)}
.footbar{display:flex;align-items:center;gap:.6rem;margin-top:.6rem}
.note{font-size:.82rem;color:var(--faint)}
.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.25rem 0 .75rem}
.toolbar input[type=search]{flex:1 1 14rem}
.lightbox{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3.5rem 1rem 1rem}
.lightbox img{width:100%;height:100%;object-fit:contain;image-rendering:auto}
.lightbox img.small{image-rendering:pixelated}
.lightbox .bar{position:absolute;top:0;right:0;left:0;padding:.5rem .6rem;background:#000;display:flex;gap:.25rem;justify-content:flex-end;align-items:center}
.lightbox .bar .cap{flex:1;color:#ddd;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-left:.4rem}
.lightbox .bar .icon{color:#ddd}.lightbox .bar .icon:hover{background:rgba(255,255,255,.12);color:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.toast{position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:.45rem .9rem;border-radius:999px;font-size:.88rem;font-weight:500;z-index:60;box-shadow:0 6px 24px rgba(0,0,0,.25)}
[hidden]{display:none!important}
@media (max-width:640px){
 main{padding:.9rem .75rem 2.5rem}
 .conflict .cols{grid-template-columns:1fr}
 textarea.editor{min-height:50vh}
 .crumbs a,.crumbs span{max-width:10rem}
 .brand .name{display:none}
 h1{font-size:1.3rem}
}
`;

export const APP_JS = String.raw`(function () {
"use strict";
var S = { me: null, csrf: null, cleanups: [] };
var app = document.getElementById("app");
var crumbsEl = document.getElementById("crumbs");
var whoEl = document.getElementById("who");

// ---------- DOM helpers (text only, never innerHTML) ----------
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") { for (var d in v) el.dataset[d] = v[d]; }
    else if (k in el && k !== "list" && k !== "form") { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
  el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
}
function enc(s) { return encodeURIComponent(s); }
// ---------- icons (Lucide-style paths, drawn with DOM APIs; no innerHTML) ----------
var ICONS = {
  copy: ["M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z", "M16 8V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3"],
  link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
  type: ["M4 7V5h16v2", "M9 20h6", "M12 5v15"],
  check: ["M20 6 9 17l-5-5"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  expand: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  key: ["M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M12 11v10", "M12 15h3", "M12 18h2"],
};
function icon(name) {
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  (ICONS[name] || []).forEach(function (d) { var p = document.createElementNS(NS, "path"); p.setAttribute("d", d); svg.appendChild(p); });
  return svg;
}
function iconButton(name, label, onclick, extra) {
  return h("button", Object.assign({ type: "button", class: "icon", title: label, "aria-label": label, onclick: onclick }, extra || {}), icon(name));
}
function iconLink(name, label, href, extra) {
  return h("a", Object.assign({ class: "icon", href: href, title: label, "aria-label": label }, extra || {}), icon(name));
}
var toastTimer = null;
function toast(text) {
  var t = document.querySelector(".toast") || document.body.appendChild(h("div", { class: "toast", role: "status", "aria-live": "polite" }));
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
}
// Copy with a brief checkmark on the button and a toast.
function copyIcon(name, label, get) {
  var b = iconButton(name, label, function () {
    var v = get();
    var ok = function () { b.classList.add("done"); b.replaceChildren(icon("check")); toast(label.replace(/^Copy /, "") + " copied");
      setTimeout(function () { b.classList.remove("done"); b.replaceChildren(icon(name)); }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(ok, function () { toast("Copy failed"); });
    else toast("Clipboard unavailable");
  });
  return b;
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  var b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
}
function hex(buf) { return Array.from(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, "0"); }).join(""); }
function fmtDate(s) { if (!s) return ""; var d = new Date(typeof s === "number" ? s : s); return isNaN(d) ? String(s) : d.toLocaleString(); }
function fmtBytes(n) { if (n == null) return ""; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KiB"; return (n / 1048576).toFixed(1) + " MiB"; }
function showMsg(el, text, ok) { el.className = ok ? "msg ok" : "msg"; el.textContent = text || ""; }
function showErr(el, e) {
  var t = e && e.message ? e.message : String(e);
  if (e && e.status) t = t + " (" + e.status + (e.code ? " " + e.code : "") + ")";
  showMsg(el, t, false);
}
function copyText(text, msgEl) {
  var done = function () { if (msgEl) showMsg(msgEl, "Copied to clipboard.", true); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { if (msgEl) showMsg(msgEl, "Copy failed; select the text and copy manually."); });
  else if (msgEl) showMsg(msgEl, "Clipboard unavailable; select the text and copy manually.");
}

// ---------- API ----------
function ApiError(status, data) {
  var err = (data && data.error) || {};
  this.status = status; this.data = data; this.code = err.code || null;
  this.message = err.message || ("HTTP " + status);
}
ApiError.prototype = Object.create(Error.prototype);

async function api(method, path, body, opt) {
  opt = opt || {};
  var headers = Object.assign({}, opt.headers || {});
  if (body !== undefined && !opt.raw) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && S.csrf) headers["x-csrf-token"] = S.csrf;
  if (opt.key) headers["idempotency-key"] = opt.key;
  var res;
  try {
    res = await fetch(path, { method: method, headers: headers, credentials: "same-origin", cache: "no-store",
      body: body === undefined ? undefined : (opt.raw ? body : JSON.stringify(body)) });
  } catch (e) { throw new ApiError(0, { error: { code: "network", message: "Network error: " + (e && e.message) } }); }
  var data = null, t = await res.text();
  if (t) { try { data = JSON.parse(t); } catch (e) { data = { raw: t }; } }
  if (res.status === 401 && !opt.noAuthRedirect) onUnauthenticated();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- drafts (scoped by principal/project/artifact; cleared on logout/401) ----------
function draftKey(pid, aid) { return "al:draft:" + (S.me ? S.me.id : "anon") + ":" + pid + ":" + aid; }
function readDraft(pid, aid) { try { return JSON.parse(localStorage.getItem(draftKey(pid, aid)) || "null"); } catch (e) { return null; } }
function writeDraft(pid, aid, base, body) { try { localStorage.setItem(draftKey(pid, aid), JSON.stringify({ base: base, body: body, at: Date.now() })); } catch (e) {} }
function clearDraft(pid, aid) { try { localStorage.removeItem(draftKey(pid, aid)); } catch (e) {} }
function clearAllDrafts() {
  try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf("al:draft:") === 0) localStorage.removeItem(k); } } catch (e) {}
}

// Drop drafts that belong to any principal other than the one now signed in (identity isolation).
function purgeForeignDrafts(principalId) {
  var mine = "al:draft:" + principalId + ":";
  try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && k.indexOf("al:draft:") === 0 && k.indexOf(mine) !== 0) localStorage.removeItem(k); } } catch (e) {}
}
// Session ended (expiry/401): unsaved text is NOT destroyed. Drafts are keyed by principal, are already
// persisted on every keystroke, and are only re-offered to the same principal after sign-in. Explicit
// logout still clears all drafts; a different principal signing in purges them.
function onUnauthenticated() {
  var wasIn = !!S.me;
  S.me = null; S.csrf = null;
  runCleanups(true);
  viewLogin(wasIn ? "Your session ended. Any unsaved text was kept in this browser and will be offered again after you sign in as the same user. Log out to clear it." : "");
}

// ---------- shell / routing ----------
function runCleanups(discard) { var c = S.cleanups; S.cleanups = []; c.forEach(function (f) { try { f(discard); } catch (e) {} }); }
function setCrumbs(items) {
  crumbsEl.replaceChildren();
  items.forEach(function (it, i) {
    if (i) crumbsEl.append(h("span", { class: "sep", text: "/" }));
    crumbsEl.append(it.href ? h("a", { href: it.href, text: it.t }) : h("span", { text: it.t }));
  });
}
function setWho() {
  whoEl.replaceChildren();
  if (!S.me) return;
  var menu = h("div", { class: "menu", role: "menu", hidden: true },
    h("div", { class: "who-label", text: "Signed in as " + (S.me.label || S.me.id) }),
    h("a", { href: "#/settings/apps", role: "menuitem", onclick: closeMenu }, icon("plug"), "Connected apps"),
    h("a", { href: "#/settings/api-keys", role: "menuitem", onclick: closeMenu }, icon("key"), "API keys"),
    h("a", { href: "#/settings/tokens", role: "menuitem", onclick: closeMenu }, icon("key"), "Agent tokens"),
    h("button", { type: "button", role: "menuitem", onclick: function () { closeMenu(); logout(); } }, icon("logout"), "Sign out"));
  var gear = iconButton("settings", "Settings", function (e) { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); }, { "aria-haspopup": "menu", "aria-expanded": "false" });
  function onDoc(e) { if (!menu.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === "Escape") { closeMenu(); gear.focus(); } }
  function openMenu() { menu.hidden = false; gear.setAttribute("aria-expanded", "true"); document.addEventListener("click", onDoc); document.addEventListener("keydown", onKey); var f = menu.querySelector("a,button"); if (f) f.focus(); }
  function closeMenu() { menu.hidden = true; gear.setAttribute("aria-expanded", "false"); document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); }
  whoEl.append(gear, menu);
}
function shell(crumbs) {
  setCrumbs(crumbs || []); setWho();
  app.replaceChildren();
  for (var i = 1; i < arguments.length; i++) add(app, arguments[i]);
}
var projectTitles = {};
function projCrumbs(pid, extra) {
  // The "Agent Library" brand link is the way back to the project list, so no separate "Projects" crumb.
  return [{ t: projectTitles[pid] || pid, href: "#/p/" + enc(pid) }].concat(extra || []);
}

function route() {
  runCleanups(false);
  var t = document.querySelector(".toast"); if (t) t.hidden = true;
  var p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (!S.me) { var n = S.note || ""; S.note = ""; return viewLogin(n); }
  if (p[0] === "apps" || (p[0] === "settings" && p[1] === "apps")) return viewApps();
  if (p[0] === "settings" && p[1] === "tokens") return viewTokens();
  if (p[0] === "settings" && p[1] === "api-keys") return viewApiKeys();
  if (p[0] === "p" && p[1]) {
    if (p[2] === "a" && p[3]) return viewArtifact(p[1], p[3], p[4] === "preview" ? "preview" : null);
    if (p[2] === "trash") return viewList(p[1], true);
    if (p[2] === "grants") { location.replace("#/settings/tokens"); return; }
    return viewList(p[1], false);
  }
  return viewProjects();
}

async function logout() {
  try { await api("POST", "/api/logout", {}, { noAuthRedirect: true }); } catch (e) {}
  clearAllDrafts();
  S.me = null; S.csrf = null;
  runCleanups(true);
  S.note = "Signed out. Local drafts were cleared.";
  if (location.hash && location.hash !== "#/") location.hash = "#/"; else route();
}

// ---------- login ----------
function viewLogin(note) {
  var msg = h("p", { class: "msg" });
  var pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "Local dev passphrase", required: true, name: "passphrase" });
  var btn = h("button", { type: "submit" }, "Sign in");
  var form = h("form", { class: "card", onsubmit: async function (e) {
    e.preventDefault(); btn.disabled = true; showMsg(msg, "");
    try {
      var r = await api("POST", "/auth/dev-login", { passphrase: pass.value }, { noAuthRedirect: true });
      pass.value = "";
      S.csrf = r.csrf;
      var me = await api("GET", "/api/me", undefined, { noAuthRedirect: true });
      S.me = me.principal; S.csrf = me.csrf || S.csrf;
      purgeForeignDrafts(S.me.id);
      route();
    } catch (err) { showErr(msg, err); btn.disabled = false; }
  } }, h("h1", { text: "Sign in" }),
    h("p", { class: "muted small", text: "Local development login (loopback only)." }),
    h("div", { class: "row" }, pass, btn), msg);
  shell([{ t: "Sign in" }], note ? h("p", { class: "banner", text: note }) : null, form);
  pass.focus();
}

// ---------- projects ----------
async function viewProjects() {
  var msg = h("p", { class: "msg" });
  var list = h("ul", { class: "list" });
  var title = h("input", { type: "text", placeholder: "Project name", required: true, maxLength: 200, "aria-label": "New project name" });
  var form = h("form", { class: "row", hidden: true, onsubmit: async function (e) {
    e.preventDefault();
    try { var r = await api("POST", "/api/projects", { title: title.value.trim() }); projectTitles[r.id] = r.title; location.hash = "#/p/" + enc(r.id); }
    catch (err) { showErr(msg, err); }
  } }, title, h("button", { type: "submit" }, "Create"), h("button", { type: "button", class: "secondary", onclick: function () { form.hidden = true; newBtn.hidden = false; } }, "Cancel"));
  var newBtn = h("button", { type: "button", onclick: function () { form.hidden = false; newBtn.hidden = true; title.focus(); } }, "New project");
  shell([], h("div", { class: "titlebar" }, h("h1", { text: "Projects" }), newBtn), form, msg, list);
  try {
    var r = await api("GET", "/api/projects");
    if (!r.projects.length) list.append(h("li", { class: "empty", text: "No projects yet. Create one, or let a connected app create one." }));
    r.projects.forEach(function (p) {
      projectTitles[p.id] = p.title;
      var href = "#/p/" + enc(p.id);
      list.append(h("li", { class: "link", onclick: function (e) { if (e.target.tagName !== "A") location.hash = href; } },
        h("a", { class: "grow", href: href, text: p.title })));
    });
  } catch (err) { showErr(msg, err); }
}

async function ensureProjectTitle(pid) {
  if (projectTitles[pid]) return;
  try { var r = await api("GET", "/api/projects"); r.projects.forEach(function (p) { projectTitles[p.id] = p.title; }); setCrumbsTitle(pid); } catch (e) {}
}
function setCrumbsTitle(pid) {
  var a = crumbsEl.querySelector("a[href='#/p/" + enc(pid) + "']");
  if (a && projectTitles[pid]) a.textContent = projectTitles[pid];
  var h1 = app.querySelector("h1[data-project-title]");
  if (h1 && h1.dataset.projectTitle === pid && projectTitles[pid] && h1.textContent !== "Trash") h1.textContent = projectTitles[pid];
}

function projectTabs(pid, active) {
  var tabs = [["list", "Documents", "#/p/" + enc(pid)], ["trash", "Trash", "#/p/" + enc(pid) + "/trash"]];
  return h("nav", { class: "tabs" }, tabs.map(function (t) {
    return h("button", { type: "button", "aria-selected": t[0] === active ? "true" : "false", onclick: function () { location.hash = t[2]; } }, t[1]);
  }));
}

// ---------- artifact list ----------
function guessMime(file) {
  var n = (file.name || "").toLowerCase();
  if (file.type === "image/png" || /\.png$/.test(n)) return "image/png";
  if (file.type === "application/pdf" || /\.pdf$/.test(n)) return "application/pdf";
  if (file.type === "video/mp4" || /\.mp4$/.test(n)) return "video/mp4";
  return "application/octet-stream";
}

// begin -> PUT bytes -> finish. keys are reused across retries of the same file/target.
async function uploadFile(pid, file, target, keys, status) {
  status("Hashing " + file.name + "...");
  var buf = await file.arrayBuffer();
  var sha = hex(await crypto.subtle.digest("SHA-256", buf));
  var mime = guessMime(file);
  var fp = [file.name, file.size, file.lastModified, sha, target.artifact_id || "", target.expected_revision || "", target.title || ""].join("|");
  if (keys.fp !== fp) { keys.fp = fp; keys.begin = uuid(); keys.finish = uuid(); }
  var begin = target.artifact_id
    ? { artifact_id: target.artifact_id, expected_revision: target.expected_revision, mime: mime, size: buf.byteLength, sha256: sha }
    : { title: target.title || file.name, mime: mime, size: buf.byteLength, sha256: sha };
  status("Starting upload (" + fmtBytes(buf.byteLength) + ", sha256 " + sha.slice(0, 12) + "...)");
  var b = await api("POST", "/api/projects/" + enc(pid) + "/uploads", begin, { key: keys.begin });
  status("Sending bytes...");
  try {
    var put = await api("PUT", b.put_url, buf, { raw: true, headers: { "content-type": "application/octet-stream" } });
    if (!put.matches_declared) throw new Error("Server received bytes that do not match the declared size/hash");
  } catch (e) {
    // A retried begin can return an upload whose bytes already arrived; finish will verify.
    if (!(e && e.status === 409 && e.code === "upload_not_writable")) throw e;
  }
  status("Verifying and publishing...");
  var f = await api("POST", "/api/projects/" + enc(pid) + "/uploads/" + enc(b.upload_id) + "/finish", {}, { key: keys.finish });
  keys.fp = null;
  return f;
}

function uploadForm(pid, target, onDone) {
  var msg = h("p", { class: "msg" });
  var file = h("input", { type: "file", accept: ".png,.pdf,.mp4,image/png,application/pdf,video/mp4" });
  var title = target ? null : h("input", { type: "text", placeholder: "Title (defaults to file name)", maxLength: 200 });
  var btn = h("button", { type: "submit" }, target ? "Upload new version" : "Upload");
  var keys = {};
  var form = h("form", { class: "row", onsubmit: async function (e) {
    e.preventDefault();
    var f = file.files && file.files[0];
    if (!f) { showMsg(msg, "Choose a file first."); return; }
    btn.disabled = true;
    try {
      var t = target ? target() : { title: title.value.trim() || f.name };
      var r = await uploadFile(pid, f, t, keys, function (s) { showMsg(msg, s, true); });
      showMsg(msg, "Uploaded revision " + r.revision + " (" + fmtBytes(r.size) + ").", true);
      file.value = ""; if (title) title.value = "";
      if (onDone) onDone(r);
    } catch (err) { showErr(msg, err); msg.append(h("span", { text: " - press Upload again to retry." })); }
    btn.disabled = false;
  } }, file, title, btn);
  return h("div", null, form, msg);
}

function kindLabel(a) { return a.kind === "markdown" ? "Doc" : "File"; }
async function viewList(pid, trash) {
  var msg = h("p", { class: "msg" });
  var list = h("ul", { class: "list" });
  var more = h("button", { type: "button", class: "secondary", hidden: true }, "Load more");
  var q = h("input", { type: "search", placeholder: trash ? "Search trash" : "Search titles and text", "aria-label": "Search" });
  var cursor = null, seq = 0, qTimer = null;

  function row(a) {
    var info = h("small", { class: "muted", text: "Updated " + fmtDate(a.updated_at) + " · rev " + a.revision + (a.folder ? " · " + a.folder : "") + (a.tags && a.tags.length ? " · #" + a.tags.join(" #") : "") });
    var href = "#/p/" + enc(pid) + "/a/" + enc(a.id);
    var main = h("div", { class: "grow" }, trash ? h("span", { text: a.title }) : h("a", { href: href, text: a.title }), info);
    var li = h("li", trash ? null : { class: "link", onclick: function (e) { if (e.target.tagName !== "A") location.hash = href; } }, main, h("span", { class: "badge", text: kindLabel(a) }));
    if (trash) li.append(h("button", { type: "button", class: "secondary", onclick: async function (e) {
      e.target.disabled = true;
      try { await api("PATCH", "/api/projects/" + enc(pid) + "/artifacts/" + enc(a.id), { expected_meta_version: a.meta_version, trashed: false }, { key: uuid() }); li.remove(); showMsg(msg, "Restored \"" + a.title + "\".", true); }
      catch (err) { showErr(msg, err); e.target.disabled = false; if (err.status === 409) load(true); }
    } }, "Restore"));
    return li;
  }
  async function load(reset) {
    var my = ++seq;
    if (reset) cursor = null;
    var qs = "?q=" + enc(q.value.trim()) + (cursor ? "&cursor=" + enc(cursor) : "") + (trash ? "&trashed=1" : "");
    try {
      var r = await api("GET", "/api/projects/" + enc(pid) + "/artifacts" + qs);
      if (my !== seq) return;
      if (reset) list.replaceChildren();
      r.artifacts.forEach(function (a) { list.append(row(a)); });
      if (reset && !r.artifacts.length) list.append(h("li", { class: "empty", text: q.value.trim() ? "No matches." : (trash ? "Trash is empty." : "No artifacts yet.") }));
      cursor = r.next_cursor; more.hidden = !cursor;
    } catch (err) { showErr(msg, err); }
  }
  q.addEventListener("input", function () { clearTimeout(qTimer); qTimer = setTimeout(function () { load(true); }, 300); });
  more.addEventListener("click", function () { load(false); });
  S.cleanups.push(function () { clearTimeout(qTimer); });

  var actions = null, panel = null;
  if (!trash) {
    var dtitle = h("input", { type: "text", placeholder: "Document title", required: true, maxLength: 200, "aria-label": "New document title" });
    var cmsg = h("p", { class: "msg" });
    var pending = null;
    var newDoc = h("div", { class: "card", hidden: true },
      h("form", { class: "row", onsubmit: async function (e) {
        e.preventDefault();
        var t = dtitle.value.trim(); if (!t) return;
        var body = "# " + t + "\n\n";
        if (!pending || pending.t !== t) pending = { t: t, key: uuid() };
        try { var r = await api("POST", "/api/projects/" + enc(pid) + "/artifacts", { title: t, body: body }, { key: pending.key }); pending = null; location.hash = "#/p/" + enc(pid) + "/a/" + enc(r.artifact_id); }
        catch (err) { showErr(cmsg, err); }
      } }, dtitle, h("button", { type: "submit" }, "Create"), h("button", { type: "button", class: "secondary", onclick: function () { newDoc.hidden = true; } }, "Cancel")), cmsg);
    var upload = h("div", { class: "card", hidden: true }, h("p", { class: "muted small", text: "PNG, PDF or MP4, up to 5 MB." }), uploadForm(pid, null, function () { load(true); }));
    actions = h("div", { class: "row" },
      h("button", { type: "button", onclick: function () { upload.hidden = true; newDoc.hidden = !newDoc.hidden; if (!newDoc.hidden) dtitle.focus(); } }, "New document"),
      h("button", { type: "button", class: "secondary", onclick: function () { newDoc.hidden = true; upload.hidden = !upload.hidden; } }, "Upload file"));
    panel = [newDoc, upload];
  }
  shell(projCrumbs(pid, trash ? [{ t: "Trash" }] : []),
    h("div", { class: "titlebar" }, h("h1", { text: trash ? "Trash" : (projectTitles[pid] || "Documents"), dataset: { projectTitle: pid } }), actions),
    panel, h("div", { class: "toolbar" }, projectTabs(pid, trash ? "trash" : "list"), h("span", { class: "spacer" }), q), msg, list, more);
  ensureProjectTitle(pid);
  load(true);
}

// ---------- settings: connected apps (OAuth connections, all projects) ----------
function settingsTabs(active) {
  return h("nav", { class: "tabs" }, [["apps", "Connected apps"], ["api-keys", "API keys"], ["tokens", "Agent tokens"]].map(function (t) {
    return h("button", { type: "button", "aria-selected": t[0] === active ? "true" : "false", onclick: function () { location.hash = "#/settings/" + t[0]; } }, t[1]);
  }));
}
function accessText(a) { return a === "read+write" ? "read & edit" : "read"; }
function statusBadge(st) { return h("span", { class: "badge" + (st === "active" ? " active" : ""), text: st }); }
async function viewApps() {
  var msg = h("p", { class: "msg" });
  var conns = h("ul", { class: "list" });
  var showAll = h("input", { type: "checkbox" });
  var data = null;
  function draw() {
    conns.replaceChildren();
    var cs = data.connections.filter(function (c) { return showAll.checked || c.status === "active"; });
    if (!cs.length) conns.append(h("li", { class: "empty", text: showAll.checked ? "No connected apps." : "No active connected apps." }));
    cs.forEach(function (c) {
      var projs = c.projects.map(function (p) { return p.title + " (" + accessText(p.access) + ")"; }).join(", ") || "no projects";
      var li = h("li", null,
        h("div", { class: "grow" }, h("strong", { text: c.client_name }), " ", h("span", { class: "muted small", text: c.redirect_host }),
          h("small", { text: projs }),
          h("small", { class: "muted", text: (c.last_used_at ? "Last used " + fmtDate(c.last_used_at) : "Never used") + " · connected " + fmtDate(c.created_at) })),
        statusBadge(c.status));
      if (c.status === "active") li.append(h("button", { type: "button", class: "danger", onclick: async function (e) {
        if (!confirm("Disconnect " + c.client_name + "? It loses access to " + c.projects.length + " project(s) immediately.")) return;
        e.target.disabled = true;
        try { await api("POST", "/api/connections/" + enc(c.id) + "/revoke", {}); toast("Disconnected " + c.client_name); load(); }
        catch (err) { showErr(msg, err); e.target.disabled = false; }
      } }, "Disconnect"));
      conns.append(li);
    });
  }
  async function load() { try { data = await api("GET", "/api/access"); draw(); } catch (err) { showErr(msg, err); } }
  showAll.addEventListener("change", function () { if (data) draw(); });
  shell([{ t: "Settings" }], h("h1", { text: "Settings" }), settingsTabs("apps"),
    h("p", { class: "muted small", text: "Apps you connected by signing in (ChatGPT, Claude, Grok, …). Disconnecting takes effect immediately and doesn't affect other apps." }),
    msg, conns, h("p", null, h("label", { class: "muted small" }, showAll, "Show disconnected and expired")));
  load();
}

// ---------- settings: agent tokens (advanced: scripts and local agents) + backup ----------
async function viewTokens() {
  var msg = h("p", { class: "msg" });
  var list = h("ul", { class: "list" });
  var showAll = h("input", { type: "checkbox" });
  var data = null, projects = [];
  var proj = h("select", { "aria-label": "Project" });
  var label = h("input", { type: "text", placeholder: "Label, e.g. backup script", required: true, maxLength: 80, "aria-label": "Token label" });
  var canWrite = h("input", { type: "checkbox" });
  var ttl = h("input", { type: "number", min: 1, max: 720, value: 24, "aria-label": "Expires after (hours)" });
  ttl.size = 4;
  var tokenBox = h("div", { class: "card", hidden: true });
  function draw() {
    list.replaceChildren();
    var gs = data.grants.filter(function (g) { return showAll.checked || g.status === "active"; });
    if (!gs.length) list.append(h("li", { class: "empty", text: "No active agent tokens." }));
    gs.forEach(function (g) {
      var li = h("li", null,
        h("div", { class: "grow" }, h("strong", { text: g.label }), h("small", { text: g.project_title + " (" + accessText(g.access) + ")" }),
          h("small", { class: "muted", text: "Created " + fmtDate(g.created_at) + (g.status === "active" ? " · expires " + fmtDate(g.expires_at) : "") })),
        statusBadge(g.status));
      if (g.status === "active") li.append(h("button", { type: "button", class: "danger", onclick: async function (e) {
        if (!confirm("Revoke \"" + g.label + "\"? Anything using it loses access immediately.")) return;
        e.target.disabled = true;
        try { await api("PATCH", "/api/projects/" + enc(g.project_id) + "/grants/" + enc(g.id), { revoke: true }); toast("Revoked " + g.label); load(); }
        catch (err) { showErr(msg, err); e.target.disabled = false; }
      } }, "Revoke"));
      list.append(li);
    });
  }
  async function load() {
    try {
      var r = await Promise.all([api("GET", "/api/access"), api("GET", "/api/projects")]);
      data = r[0]; projects = r[1].projects;
      if (!proj.options.length) projects.forEach(function (p) { projectTitles[p.id] = p.title; proj.append(h("option", { value: p.id, text: p.title })); });
      draw();
    } catch (err) { showErr(msg, err); }
  }
  showAll.addEventListener("change", function () { if (data) draw(); });
  var form = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    try {
      var r = await api("POST", "/api/projects/" + enc(proj.value) + "/grants", { label: label.value.trim(), can_write: canWrite.checked, ttl_hours: Number(ttl.value) || 24 });
      label.value = "";
      var tok = h("input", { class: "token", type: "text", readOnly: true, value: r.token, "aria-label": "Token" });
      tokenBox.replaceChildren(h("p", null, h("strong", { text: "Token for " + r.label }), h("br"), h("span", { class: "muted small", text: "Copy it now; it won't be shown again. Send it as Authorization: Bearer … to " + location.origin + "/mcp or the API." })), tok,
        h("div", { class: "row" }, h("button", { type: "button", onclick: function () { tok.select(); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tok.value).then(function () { toast("Token copied"); }, function () { toast("Copy failed; select and copy manually"); }); else toast("Select the token and copy it manually"); } }, icon("copy"), "Copy token"),
          h("button", { type: "button", class: "secondary", onclick: function () { tokenBox.replaceChildren(); tokenBox.hidden = true; } }, "Done")));
      tokenBox.hidden = false;
      load();
    } catch (err) { showErr(msg, err); }
  } },
    h("div", { class: "grid2" }, h("label", null, "Project", proj), h("label", null, "Label", label)),
    h("div", { class: "row" }, h("label", null, canWrite, "Can edit"), h("label", null, "Expires after", ttl, "hours"), h("span", { class: "spacer" }), h("button", { type: "submit" }, "Create token")));
  var bmsg = h("p", { class: "msg" });
  var bproj = h("select", { "aria-label": "Project to back up" });
  var backupBtn = h("button", { type: "button", class: "secondary", onclick: async function () {
    backupBtn.disabled = true;
    try {
      var pid = bproj.value;
      var r = await api("GET", "/api/projects/" + enc(pid) + "/backup");
      var blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = h("a", { href: url, download: "agent-library-" + pid + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      toast("Backup downloaded (" + fmtBytes(blob.size) + ")");
    } catch (err) { showErr(bmsg, err); }
    backupBtn.disabled = false;
  } }, icon("download"), "Download backup");
  shell([{ t: "Settings" }], h("h1", { text: "Settings" }), settingsTabs("tokens"),
    h("p", { class: "muted small", text: "Advanced. Most apps connect by signing in (see Connected apps). Use a token only for your own scripts or local agents that can't sign in. Each token is limited to one project and expires." }),
    msg, list, h("p", null, h("label", { class: "muted small" }, showAll, "Show revoked and expired")),
    h("details", null, h("summary", { text: "Create a token" }), h("div", { class: "card" }, form)), tokenBox,
    h("details", null, h("summary", { text: "Backup" }), h("div", { class: "card" }, h("p", { class: "muted small", text: "Download a JSON backup of a project's documents and history." }), h("div", { class: "row" }, bproj, backupBtn), bmsg)));
  load().then(function () { projects.forEach(function (p) { bproj.append(h("option", { value: p.id, text: p.title })); }); });
}

// ---------- settings: API keys (alk_ credentials for REST clients such as Muse) ----------
var API_BASE_HINT = "See your installation configuration";
function daysLeft(iso) { return Math.ceil((Date.parse(iso) - Date.now()) / 86400000); }
function secretBox(box, title, secret, note) {
  var tok = h("input", { class: "token", type: "text", readOnly: true, value: secret, "aria-label": "API key" });
  box.replaceChildren(h("p", null, h("strong", { text: title }), h("br"), h("span", { class: "muted small", text: note })), tok,
    h("div", { class: "row" }, h("button", { type: "button", onclick: function () { tok.select(); if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tok.value).then(function () { toast("Key copied"); }, function () { toast("Copy failed; select and copy manually"); }); else toast("Select the key and copy it manually"); } }, icon("copy"), "Copy key"),
      h("button", { type: "button", class: "secondary", onclick: function () { box.replaceChildren(); box.hidden = true; } }, "Done")));
  box.hidden = false;
}
// Per-project access picker: one row per owner project, "No access" / "Read" / "Read & edit".
function scopePicker(projects, current) {
  var rows = projects.map(function (p) {
    var cur = (current || []).find(function (c) { return c.project_id === p.id; });
    var sel = h("select", { "aria-label": "Access to " + p.title, dataset: { pid: p.id } },
      h("option", { value: "", text: "No access" }), h("option", { value: "read", text: "Read" }), h("option", { value: "read_write", text: "Read & edit" }));
    sel.value = cur ? cur.access : "";
    return h("label", { class: "row" }, h("span", { class: "grow", text: p.title }), sel);
  });
  return { el: h("div", { class: "scope" }, rows), value: function () {
    return rows.map(function (r) { var s = r.querySelector("select"); return s.value ? { project_id: s.dataset.pid, access: s.value } : null; }).filter(Boolean);
  } };
}
async function viewApiKeys() {
  var msg = h("p", { class: "msg" });
  var list = h("ul", { class: "list" });
  var showAll = h("input", { type: "checkbox" });
  var box = h("div", { class: "card", hidden: true });
  var data = null, projects = [];
  var label = h("input", { type: "text", placeholder: "Label, e.g. Muse", required: true, maxLength: 80, "aria-label": "Key label" });
  function lifeSelect(dflt) {
    var s = h("select", { "aria-label": "Lifetime" }, [1, 7, 30, 90].map(function (d) { return h("option", { value: String(d), text: d === 1 ? "1 day" : d + " days" }); }));
    s.value = String(dflt || 90); return s;
  }
  var life = lifeSelect(90);
  var picker = null, pickerHost = h("div");
  function draw() {
    list.replaceChildren();
    var ks = data.keys.filter(function (k) { return showAll.checked || k.status === "active"; });
    if (!ks.length) list.append(h("li", { class: "empty", text: "No active API keys." }));
    ks.forEach(function (k) {
      var left = daysLeft(k.expires_at);
      var exp = k.status === "active" ? (left <= 1 ? "expires within a day" : "expires in " + left + " days") + " (" + fmtDate(k.expires_at) + ")" : k.status;
      var li = h("li", null,
        h("div", { class: "grow" }, h("strong", { text: k.label }),
          h("small", { text: k.projects.map(function (p) { return p.title + " (" + (p.access === "read_write" ? "read & edit" : "read") + ")"; }).join(", ") || "no projects" }),
          h("small", { class: "muted" + (k.status === "active" && left <= 14 ? " warn" : ""), text: exp + " · " + (k.last_used_at ? "last used " + fmtDate(k.last_used_at) : "never used") + (k.replaces_id ? " · replacement key" : "") })),
        statusBadge(k.status));
      if (k.status === "active") {
        var editHost = h("div", { class: "card", hidden: true });
        li.append(h("span", { class: "row" },
          h("button", { type: "button", class: "secondary", onclick: async function (e) {
            var nl = lifeSelect(90);
            editHost.hidden = false;
            editHost.replaceChildren(h("p", { class: "small", text: "Create a replacement with the same projects and access. The current key keeps working until you revoke it, so you can update the app first." }),
              h("div", { class: "row" }, h("label", null, "New key lifetime", nl), h("span", { class: "spacer" }),
                h("button", { type: "button", onclick: async function (ev) {
                  ev.target.disabled = true;
                  try {
                    var r = await api("POST", "/api/api-keys/" + enc(k.id) + "/replace", { lifetime_days: Number(nl.value) });
                    editHost.hidden = true;
                    secretBox(box, "Replacement key for " + r.label, r.secret, "Copy it now; it won't be shown again. Put it in the app, check it works, then revoke the old key (listed below).");
                    load();
                  } catch (err) { showErr(msg, err); ev.target.disabled = false; }
                } }, "Create replacement"),
                h("button", { type: "button", class: "secondary", onclick: function () { editHost.hidden = true; } }, "Cancel")));
          } }, "Replace"),
          h("button", { type: "button", class: "secondary", onclick: function () {
            var sp = scopePicker(projects, k.projects);
            editHost.hidden = false;
            editHost.replaceChildren(h("p", { class: "small", text: "Choose which projects this key can use. Adding projects gives the app new access immediately." }), sp.el,
              h("div", { class: "row" }, h("span", { class: "spacer" }),
                h("button", { type: "button", onclick: async function (ev) {
                  var next = sp.value();
                  if (!next.length) { showErr(msg, { message: "Pick at least one project, or revoke the key instead." }); return; }
                  var added = next.filter(function (n) { var c = k.projects.find(function (x) { return x.project_id === n.project_id; }); return !c || (c.access === "read" && n.access === "read_write"); });
                  if (added.length && !confirm("Give \"" + k.label + "\" new access to " + added.length + " project(s)? The app can use it immediately.")) return;
                  ev.target.disabled = true;
                  try { await api("PUT", "/api/api-keys/" + enc(k.id) + "/scope", { projects: next, confirm_new_access: added.length > 0 }); toast("Access updated"); load(); }
                  catch (err) { showErr(msg, err); ev.target.disabled = false; }
                } }, "Save access"),
                h("button", { type: "button", class: "secondary", onclick: function () { editHost.hidden = true; } }, "Cancel")));
          } }, "Projects"),
          h("button", { type: "button", class: "danger", onclick: async function (e) {
            if (!confirm("Revoke \"" + k.label + "\"? Anything using it loses access immediately.")) return;
            e.target.disabled = true;
            try { await api("POST", "/api/api-keys/" + enc(k.id) + "/revoke", {}); toast("Revoked " + k.label); load(); }
            catch (err) { showErr(msg, err); e.target.disabled = false; }
          } }, "Revoke")), editHost);
      }
      list.append(li);
    });
  }
  async function load() {
    try {
      var r = await Promise.all([api("GET", "/api/api-keys"), api("GET", "/api/projects")]);
      data = r[0]; projects = r[1].projects;
      projects.forEach(function (p) { projectTitles[p.id] = p.title; });
      if (!picker) { picker = scopePicker(projects, []); pickerHost.replaceChildren(picker.el); }
      draw();
    } catch (err) { showErr(msg, err); }
  }
  showAll.addEventListener("change", function () { if (data) draw(); });
  var form = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    var scope = picker ? picker.value() : [];
    if (!scope.length) { showErr(msg, { message: "Pick at least one project." }); return; }
    try {
      var r = await api("POST", "/api/api-keys", { label: label.value.trim(), lifetime_days: Number(life.value), projects: scope });
      label.value = "";
      secretBox(box, "API key for " + r.label, r.secret, "Copy it now; it won't be shown again. Base URL: " + API_BASE_HINT + " · expires " + fmtDate(r.expires_at) + ".");
      load();
    } catch (err) { showErr(msg, err); }
  } },
    h("div", { class: "grid2" }, h("label", null, "Label", label), h("label", null, "Lifetime", life)),
    h("p", { class: "muted small", text: "Projects and access" }), pickerHost,
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { type: "submit" }, "Create key")));
  shell([{ t: "Settings" }], h("h1", { text: "Settings" }), settingsTabs("api-keys"),
    h("p", { class: "muted small", text: "Keys for apps that use the REST API (for example Muse). Each key covers only the projects you pick, expires (90 days at most) and can be replaced or revoked at any time." }),
    msg, box, list, h("p", null, h("label", { class: "muted small" }, showAll, "Show revoked and expired")),
    h("details", null, h("summary", { text: "Create an API key" }), h("div", { class: "card" }, form)));
  load();
}

// Canonical browser link for a document (same route shape as src/links.ts: /p/:pid/a/:aid).
function docUrl(pid, aid) { return location.origin + "/p/" + enc(pid) + "/a/" + enc(aid); }
// Quick-copy icons: link, title and (for Markdown) the current editor text; extra icons appended by callers.
function copyBar(A, getContents, extra) {
  return h("span", { class: "icons" },
    copyIcon("link", "Copy link", function () { return docUrl(A.pid, A.aid) + (A.meta.kind === "markdown" && A.tab === "preview" ? "/preview" : ""); }),
    copyIcon("type", "Copy title", function () { return A.meta.title; }),
    getContents ? copyIcon("copy", "Copy contents", getContents) : null, extra || null);
}

// ---------- artifact view (Markdown editor or binary preview) ----------
async function viewArtifact(pid, aid, initialTab) {
  var base = "/api/projects/" + enc(pid) + "/artifacts/" + enc(aid);
  var msg = h("p", { class: "msg" });
  shell(projCrumbs(pid, [{ t: "..." }]), h("p", { class: "muted", text: "Loading..." }));
  ensureProjectTitle(pid);
  var data;
  try { data = await api("GET", base); }
  catch (err) { shell(projCrumbs(pid, [{ t: aid }]), msg); showErr(msg, err); return; }
  if (!S.me || location.hash.indexOf(enc(aid)) < 0) return;
  var A = { pid: pid, aid: aid, base: base, meta: data.artifact, rev: data.revision.rev, alive: true };
  S.cleanups.push(function () { A.alive = false; });
  var titleEl = h("h1", { text: A.meta.title });
  var metaMsg = h("p", { class: "msg" });

  // metadata: rename / folder / tags / trash, guarded by expected_meta_version
  var fTitle = h("input", { type: "text", maxLength: 200 }), fFolder = h("input", { type: "text", maxLength: 200 }), fTags = h("input", { type: "text", placeholder: "comma,separated" });
  function fillMeta() {
    if (document.activeElement !== fTitle) fTitle.value = A.meta.title;
    if (document.activeElement !== fFolder) fFolder.value = A.meta.folder || "";
    if (document.activeElement !== fTags) fTags.value = (A.meta.tags || []).join(", ");
    titleEl.textContent = A.meta.title;
    setCrumbs(projCrumbs(pid, [{ t: A.meta.title }]));
  }
  async function reloadMeta() { try { var r = await api("GET", base); A.meta = r.artifact; fillMeta(); } catch (e) {} }
  async function patchMeta(fields, okText) {
    try {
      var r = await api("PATCH", base, Object.assign({ expected_meta_version: A.meta.meta_version }, fields), { key: uuid() });
      A.meta.meta_version = r.meta_version; A.meta.title = r.title; A.meta.folder = r.folder; A.meta.tags = r.tags; A.meta.trashed = r.trashed;
      fillMeta(); showMsg(metaMsg, okText, true); return r;
    } catch (err) {
      if (err.status === 409) { showMsg(metaMsg, "Details were changed elsewhere (now version " + (err.data.error.current_meta_version || "?") + "). Reloaded; review and try again."); await reloadMeta(); }
      else showErr(metaMsg, err);
      return null;
    }
  }
  var details = h("details", null, h("summary", { text: "Details" }),
    h("div", { class: "grid2" }, h("label", null, "Title", fTitle), h("label", null, "Folder", fFolder), h("label", null, "Tags", fTags)),
    h("div", { class: "row" },
      h("button", { type: "button", onclick: function () {
        patchMeta({ title: fTitle.value.trim(), folder: fFolder.value.trim(), tags: fTags.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) }, "Details saved.");
      } }, "Save details"),
      h("button", { type: "button", class: "danger", onclick: async function () {
        if (!confirm("Move \"" + A.meta.title + "\" to trash? History is kept and it can be restored.")) return;
        if (A.flush) await A.flush();
        var r = await patchMeta({ trashed: true }, "Moved to trash.");
        if (r) location.hash = "#/p/" + enc(pid) + "/trash";
      } }, "Move to trash")),
    h("p", { class: "muted small", text: "ID " + aid + " - " + A.meta.kind }), metaMsg);
  fillMeta();

  // shared panels
  var panels = {}, tabBtns = {};
  var tabNav = h("nav", { class: "tabs" });
  function addTab(name, label, onShow) {
    panels[name] = h("section", { hidden: true });
    tabBtns[name] = h("button", { type: "button", "aria-selected": "false", onclick: function () { showTab(name); } }, label);
    tabBtns[name].onShow = onShow;
    tabNav.append(tabBtns[name]);
  }
  function showTab(name) {
    for (var k in panels) { panels[k].hidden = k !== name; tabBtns[k].setAttribute("aria-selected", k === name ? "true" : "false"); }
    A.tab = name;
    if (A.meta.kind === "markdown" && (name === "preview" || name === "edit")) {
      var want = "#/p/" + enc(pid) + "/a/" + enc(aid) + (name === "preview" ? "/preview" : "");
      if (location.hash !== want) history.replaceState(null, "", want);
    }
    if (tabBtns[name].onShow) tabBtns[name].onShow();
  }

  // history
  var histMsg = h("p", { class: "msg" }), histList = h("ul", { class: "list" }), histView = h("div");
  async function loadHistory() {
    try {
      var r = await api("GET", base + "/history");
      histList.replaceChildren();
      r.revisions.forEach(function (v) {
        var li = h("li", null, h("strong", { text: "rev " + v.rev }),
          h("span", { class: "grow muted small", text: fmtDate(v.created_at) + " - " + fmtBytes(v.size) + " - " + (v.author_id || "") + (v.restored_from ? " - restored from rev " + v.restored_from : "") }),
          h("button", { type: "button", class: "secondary", onclick: function () { viewRev(v); } }, "View"));
        if (v.rev !== A.rev) li.append(h("button", { type: "button", onclick: function () { restoreRev(v.rev); } }, "Restore as new revision"));
        else li.append(h("span", { class: "badge", text: "current" }));
        histList.append(li);
      });
    } catch (err) { showErr(histMsg, err); }
  }
  async function viewRev(v) {
    histView.replaceChildren();
    if (A.meta.kind === "markdown") {
      try { var r = await api("GET", base + "?rev=" + v.rev); histView.append(h("h2", { text: "Revision " + v.rev + " (raw)" }), h("pre", { class: "raw", text: r.body })); }
      catch (err) { showErr(histMsg, err); }
    } else {
      var url = base + "/content?rev=" + v.rev;
      histView.append(h("h2", { text: "Revision " + v.rev }), mediaFor(v.mime, url, A.meta.title));
    }
  }
  async function restoreRev(n) {
    if (A.isBusy && A.isBusy()) { showMsg(histMsg, "Save or discard your local edits before restoring an older revision."); return; }
    if (!confirm("Restore revision " + n + " as a new revision? Current history is kept.")) return;
    try {
      var r = await api("POST", base + "/restore", { expected_revision: A.rev, from_revision: n }, { key: uuid() });
      showMsg(histMsg, "Restored rev " + n + " as rev " + r.revision + ".", true);
      if (A.reload) await A.reload();
      loadHistory();
    } catch (err) {
      if (err.status === 409) showMsg(histMsg, "The artifact changed (server is at rev " + ((err.data.error || {}).current_revision || "?") + "). Reload and try again.");
      else showErr(histMsg, err);
    }
  }
  // comments
  var comMsg = h("p", { class: "msg" }), comList = h("ul", { class: "list" }), comText = h("textarea", { class: "half", maxLength: 4000, placeholder: "Comment on the current revision" });
  var comPending = null;
  async function loadComments() {
    try {
      var r = await api("GET", base + "/comments");
      comList.replaceChildren();
      if (!r.comments.length) comList.append(h("li", { class: "empty", text: "No comments yet." }));
      r.comments.forEach(function (c) {
        comList.append(h("li", null, h("div", { class: "grow" }, h("div", { class: "muted small", text: (c.author || "") + " - rev " + c.revision + " - " + fmtDate(c.created_at) }), h("div", { class: "raw-text", text: c.body }))));
      });
    } catch (err) { showErr(comMsg, err); }
  }
  var comForm = h("form", { onsubmit: async function (e) {
    e.preventDefault();
    var t = comText.value.trim(); if (!t) return;
    if (!comPending || comPending.t !== t || comPending.rev !== A.rev) comPending = { t: t, rev: A.rev, key: uuid() };
    try { await api("POST", base + "/comments", { revision: comPending.rev, body: t }, { key: comPending.key }); comPending = null; comText.value = ""; showMsg(comMsg, "", true); loadComments(); }
    catch (err) { showErr(comMsg, err); }
  } }, comText, h("div", { class: "row" }, h("button", { type: "submit" }, "Add comment")));

  var below = h("div", { class: "below" });
  if (A.meta.kind === "markdown") renderMarkdownEditor(A, data, { titleEl: titleEl, details: details, tabNav: tabNav, panels: panels, addTab: addTab, showTab: showTab, fillMeta: fillMeta, below: below });
  else renderBinary(A, data, { titleEl: titleEl, details: details, tabNav: tabNav, panels: panels, addTab: addTab, showTab: showTab, below: below });

  addTab("history", "History", loadHistory);
  panels.history.append(histMsg, histList, histView);
  addTab("comments", "Comments", loadComments);
  panels.comments.append(comList, comForm, comMsg);
  for (var k in panels) app.append(panels[k]);
  app.append(below);
  showTab(A.meta.kind === "markdown" && initialTab !== "preview" ? "edit" : "preview");
}

function downloadUrl(url) { return url + (url.indexOf("?") < 0 ? "?" : "&") + "download=1"; }
// Full-size image overlay: Escape / click outside / Close dismisses; focus returns to the opener.
function openLightbox(src, title) {
  var opener = document.activeElement;
  var img = h("img", { src: src, alt: title || "image" });
  // Fill the viewport (contain); crisp scaling for tiny images. Natural size is shown in the caption.
  img.addEventListener("load", function () { if (img.naturalWidth < 300) img.classList.add("small"); cap.textContent = (title || "") + " - " + img.naturalWidth + "x" + img.naturalHeight; });
  var cap = h("span", { class: "cap", text: title || "" });
  var close;
  var box = h("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": title || "Image" },
    h("div", { class: "bar" }, cap,
      iconLink("external", "Open original", src, { target: "_blank", rel: "noopener" }),
      iconLink("download", "Download", downloadUrl(src), { download: title || "image.png" }),
      close = iconButton("x", "Close", function () { done(); })),
    img);
  function onKey(e) { if (e.key === "Escape") done(); }
  function done() { document.removeEventListener("keydown", onKey); box.remove(); if (opener && opener.focus) opener.focus(); }
  box.addEventListener("click", function (e) { if (e.target === box) done(); });
  document.addEventListener("keydown", onKey);
  document.body.append(box);
  close.focus();
}

function mediaFor(mime, url, title) {
  var wrap = h("div", { class: "media" });
  var dl = h("p", { class: "row" }, h("a", { class: "btn secondary", href: downloadUrl(url), download: title || "download" }, icon("download"), "Download"));
  var fail = function () { wrap.replaceChildren(h("p", { class: "banner", text: "Preview could not be displayed in this browser. Use the download link instead." }), dl); };
  if (mime === "image/png") {
    wrap.append(h("img", { src: url, alt: title || "image", tabIndex: 0, title: "View full size", onerror: fail,
      onclick: function () { openLightbox(url, title); }, onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(url, title); } } }), dl);
    dl.prepend(h("button", { type: "button", class: "secondary", onclick: function () { openLightbox(url, title); } }, icon("expand"), "View full size"));
  }
  else if (mime === "video/mp4") wrap.append(h("video", { src: url, controls: true, playsInline: true, preload: "metadata", onerror: fail }), dl);
  else if (mime === "application/pdf") {
    // Opens the raw file in a new tab so the browser's own PDF viewer shows it (never embedded in the app).
    var openUrl = url + (url.indexOf("?") < 0 ? "?" : "&") + "open=1";
    wrap.append(h("div", { class: "filecard" }, h("span", { class: "ficon" }, icon("file")),
      h("div", { class: "grow" }, h("strong", { text: title || "PDF" }), h("div", { class: "muted small", text: "PDF document" })),
      h("a", { class: "btn", href: openUrl, target: "_blank", rel: "noopener" }, icon("external"), "Open"),
      h("a", { class: "btn secondary", href: downloadUrl(url), download: title || "document.pdf" }, icon("download"), "Download")));
  }
  else wrap.append(h("p", { class: "muted", text: "No inline preview for " + mime + "." }), dl);
  return wrap;
}

function renderBinary(A, data, ui) {
  var info = h("p", { class: "muted small" });
  var holder = h("div");
  function draw(d) {
    A.rev = d.revision.rev; A.meta = d.artifact;
    var kinds = { "application/pdf": "PDF", "image/png": "PNG image", "video/mp4": "MP4 video" };
    info.textContent = (kinds[d.revision.mime] || d.revision.mime) + " · " + fmtBytes(d.revision.size) + " · rev " + d.revision.rev + " · updated " + fmtDate(d.revision.created_at);
    info.title = "sha256 " + d.revision.sha256;
    holder.replaceChildren(mediaFor(d.revision.mime, d.content_url, d.artifact.title));
  }
  A.reload = async function () { draw(await api("GET", A.base)); };
  draw(data);
  shell(projCrumbs(A.pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, null)), info, ui.tabNav);
  ui.below.append(ui.details);
  ui.addTab("preview", "Preview", null);
  ui.panels.preview.append(holder);
  ui.below.prepend(h("details", null, h("summary", { text: "Replace with a new version" }),
    uploadForm(A.pid, function () { return { artifact_id: A.aid, expected_revision: A.rev }; }, function () { A.reload(); })));
}

function renderMarkdownEditor(A, data, ui) {
  var pid = A.pid, aid = A.aid;
  var D = { savedBody: data.body, saving: false, again: false, attempt: null, conflict: null, timer: null, retryTimer: null, errCount: 0 };
  var statusEl = h("span", { class: "status", role: "status", "aria-live": "polite" });
  var banner = h("div", { class: "banner", hidden: true });
  var ta = h("textarea", { class: "editor", spellcheck: true, "aria-label": "Markdown source" });
  ta.value = data.body;
  var saveBtn = h("button", { type: "button", class: "secondary", title: "Autosaves after you pause typing; unsaved text is kept in this browser", onclick: function () { saveNow(); } }, "Save now");
  var conflictBox = h("div", { class: "card conflict", hidden: true });
  var previewBox = h("div", { class: "preview" });
  var previewNote = h("p", { class: "muted small" });

  function isDirty() { return ta.value !== D.savedBody; }
  // Save now becomes the primary (accent) button whenever there is something to save.
  function setStatus(state, text) {
    statusEl.dataset.state = state; statusEl.textContent = text;
    saveBtn.classList.toggle("secondary", !(state === "dirty" || state === "error"));
  }
  function setSaved() { setStatus("saved", "Saved - rev " + A.rev); }
  function showBanner(t) { banner.textContent = t; banner.hidden = !t; }
  function persistDraft(body) { writeDraft(pid, aid, A.rev, body); }
  A.isBusy = function () { return isDirty() || D.saving || !!D.conflict; };

  function schedule(ms) { clearTimeout(D.timer); D.timer = setTimeout(saveNow, ms); }
  ta.addEventListener("input", function () {
    if (D.conflict) return;
    persistDraft(ta.value);
    if (!D.saving) setStatus(isDirty() ? "dirty" : "saved", isDirty() ? "Unsaved changes" : "Saved - rev " + A.rev);
    schedule(1200);
  });

  // Serialized autosave: one PUT in flight; the same Idempotency-Key is reused when retrying the same body+base.
  async function saveNow() {
    clearTimeout(D.timer); clearTimeout(D.retryTimer);
    if (D.conflict) return;
    if (D.saving) { D.again = true; return; }
    if (!isDirty()) { clearDraft(pid, aid); setSaved(); return; }
    var body = ta.value, baseRev = A.rev;
    if (!D.attempt || D.attempt.body !== body || D.attempt.base !== baseRev) D.attempt = { body: body, base: baseRev, key: uuid() };
    var att = D.attempt;
    D.saving = true; D.again = false; setStatus("saving", "Saving...");
    try {
      var r = await api("PUT", A.base, { expected_revision: att.base, body: att.body }, { key: att.key });
      A.rev = r.revision; D.savedBody = att.body; D.attempt = null; D.errCount = 0;
      showBanner("");
    } catch (err) {
      D.saving = false;
      if (err.status === 409 && err.code === "revision_conflict") { D.attempt = null; enterConflict((err.data.error || {}).current_revision); return; }
      if (err.status === 401) return; // draft already persisted per keystroke under this principal's key
      if (err.status === 422) D.attempt = null;
      D.errCount++;
      var retry = err.status === 0 || err.status >= 500 || err.status === 429;
      setStatus("error", "Save failed: " + err.message + (retry ? " - retrying" : ""));
      persistDraft(ta.value);
      if (retry && A.alive) D.retryTimer = setTimeout(saveNow, Math.min(30000, 2000 * Math.pow(2, D.errCount - 1)));
      return;
    }
    D.saving = false;
    if (isDirty()) { persistDraft(ta.value); setStatus("dirty", "Unsaved changes"); schedule(D.again ? 300 : 800); }
    else { clearDraft(pid, aid); setSaved(); }
    D.again = false;
    if (A.tab === "preview") loadPreview();
  }
  A.flush = function () { if (isDirty() && !D.conflict) return saveNow(); };

  // Conflict view: keeps local text, never auto-merges.
  async function enterConflict(currentRev, note) {
    D.conflict = { latestRev: currentRev, latest: null };
    ta.readOnly = true;
    persistDraft(ta.value);
    setStatus("conflict", "Conflict - not saved");
    var mine = h("textarea", { class: "half", "aria-label": "Your text" }); mine.value = ta.value;
    mine.addEventListener("input", function () { ta.value = mine.value; persistDraft(mine.value); });
    var theirs = h("textarea", { class: "half", readOnly: true, "aria-label": "Latest server text" });
    var latestHdr = h("strong", { text: "Latest on server" });
    var cmsg = h("p", { class: "msg" });
    async function fetchLatest() {
      try { var r = await api("GET", A.base); D.conflict.latestRev = r.revision.rev; D.conflict.latest = r.body; theirs.value = r.body; latestHdr.textContent = "Latest on server (rev " + r.revision.rev + ")"; A.meta = r.artifact; }
      catch (err) { showErr(cmsg, err); }
    }
    conflictBox.replaceChildren(
      h("h2", { text: "Save conflict" }),
      h("p", { text: note || ("Someone saved a newer revision (rev " + (currentRev || "?") + ") after you started editing rev " + A.rev + ". Your text has NOT been saved and is kept below. Nothing is merged automatically.") }),
      h("div", { class: "cols" }, h("div", null, h("strong", { text: "Your text (editable)" }), mine), h("div", null, latestHdr, theirs)),
      h("div", { class: "row" },
        h("button", { type: "button", class: "secondary", onclick: function () { mine.select(); copyText(mine.value, cmsg); } }, "Copy my text"),
        h("button", { type: "button", class: "secondary", onclick: function () {
          if (D.conflict.latest === null) return;
          if (!confirm("Discard your text and load the latest server revision?")) return;
          exitConflict(D.conflict.latest, D.conflict.latestRev);
        } }, "Load latest (discard mine)"),
        h("button", { type: "button", onclick: async function (e) {
          if (D.conflict.latest === null) { await fetchLatest(); }
          if (!confirm("Save your text as a new revision on top of rev " + D.conflict.latestRev + "?")) return;
          e.target.disabled = true;
          var body = mine.value;
          try {
            var r = await api("PUT", A.base, { expected_revision: D.conflict.latestRev, body: body }, { key: uuid() });
            exitConflict(body, r.revision);
          } catch (err) {
            if (err.status === 409) { showMsg(cmsg, "The server changed again; latest text reloaded. Review and retry."); await fetchLatest(); }
            else showErr(cmsg, err);
          }
          e.target.disabled = false;
        } }, "Save mine over latest")),
      cmsg);
    conflictBox.hidden = false;
    ui.showTab("edit");
    conflictBox.scrollIntoView({ block: "nearest" });
    await fetchLatest();
  }
  function exitConflict(body, rev) {
    D.conflict = null; conflictBox.hidden = true; conflictBox.replaceChildren();
    A.rev = rev; D.savedBody = body; ta.value = body; ta.readOnly = false;
    clearDraft(pid, aid); showBanner(""); setSaved(); ui.fillMeta();
  }

  // Clean-view refresh on focus/visibility + 10s poll; never replaces a dirty draft.
  async function refresh() {
    if (!A.alive || document.hidden || D.saving || D.conflict) return;
    var r;
    try { r = await api("GET", A.base); } catch (err) { if (err.status === 404) showBanner("This artifact is no longer available (trashed or removed)."); return; }
    if (!A.alive || D.saving || D.conflict) return;
    A.meta = r.artifact; ui.fillMeta();
    if (r.revision.rev > A.rev) {
      if (isDirty()) showBanner("A newer revision (rev " + r.revision.rev + ") exists on the server. Your edits are kept; saving will open the conflict view.");
      else { A.rev = r.revision.rev; D.savedBody = r.body; ta.value = r.body; setSaved(); showBanner(""); if (A.tab === "preview") loadPreview(); }
    }
  }
  A.reload = async function () {
    var r = await api("GET", A.base);
    A.meta = r.artifact; A.rev = r.revision.rev; D.savedBody = r.body; ta.value = r.body; clearDraft(pid, aid); setSaved(); ui.fillMeta();
  };
  var poll = setInterval(refresh, 10000);
  var onFocus = function () { refresh(); };
  var onVis = function () { if (!document.hidden) refresh(); };
  var onUnload = function (e) { if (isDirty() || D.saving) { persistDraft(ta.value); e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("beforeunload", onUnload);
  S.cleanups.push(function (discard) {
    clearInterval(poll); clearTimeout(D.timer); clearTimeout(D.retryTimer);
    window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("beforeunload", onUnload);
    if (!discard && isDirty() && !D.conflict && !D.saving) { persistDraft(ta.value); saveNow(); }
  });

  async function loadPreview() {
    previewNote.textContent = "Server-rendered preview of saved rev " + A.rev + (isDirty() ? " (unsaved edits are not included)" : "") + ".";
    try {
      var r = await api("GET", A.base + "/preview?rev=" + A.rev); previewBox.innerHTML = r.html;
      previewBox.querySelectorAll("img[data-artifact]").forEach(function (im) {
        im.tabIndex = 0; im.title = "View full size";
        var open = function () { openLightbox(im.getAttribute("src"), im.getAttribute("alt") || "image"); };
        im.addEventListener("click", open);
        im.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      });
    }
    catch (err) { previewBox.replaceChildren(h("p", { class: "msg", text: "Preview failed: " + err.message })); }
  }

  shell(projCrumbs(pid, [{ t: A.meta.title }]), h("div", { class: "titlebar" }, ui.titleEl, copyBar(A, function () { return ta.value; })), banner, conflictBox, ui.tabNav);
  // Save status/button and Details sit below the document; the status stays announced (aria-live).
  ui.below.append(h("div", { class: "footbar" }, statusEl, h("span", { class: "spacer" }), saveBtn), ui.details);
  ui.fillMeta();
  ui.addTab("edit", "Edit", null);
  ui.panels.edit.append(ta);
  ui.addTab("preview", "Preview", loadPreview);
  ui.panels.preview.append(previewNote, previewBox);
  setSaved();

  // Recover a local draft for this principal/project/artifact.
  var dr = readDraft(pid, aid);
  if (dr && typeof dr.body === "string" && dr.body !== data.body) {
    ta.value = dr.body;
    if (dr.base === A.rev) { setStatus("dirty", "Unsaved changes"); showBanner("Restored your unsaved local draft from " + fmtDate(dr.at) + "."); schedule(800); }
    else enterConflict(A.rev, "Your unsaved local draft was based on rev " + dr.base + ", but the server is now at rev " + A.rev + ". Your draft is kept below; choose how to proceed.");
  } else if (dr) clearDraft(pid, aid);
}

// ---------- boot ----------
window.addEventListener("hashchange", route);
// Canonical deep links are paths (/p/:pid[/a/:aid], see src/links.ts) so they survive sign-in redirects.
// Map them onto the in-app hash route before anything else (login included) so the destination is kept.
(function adoptPathRoute() {
  var m = /^\/p\/([^/]+)(?:\/a\/([^/]+)(?:\/(preview))?)?\/?$/.exec(location.pathname);
  if (!m) return;
  history.replaceState(null, "", "/#/p/" + m[1] + (m[2] ? "/a/" + m[2] + (m[3] ? "/preview" : "") : ""));
})();
(async function boot() {
  try {
    var me;
    try { me = await api("GET", "/api/me", undefined, { noAuthRedirect: true }); }
    catch (e1) {
      // Hosted: exchange the verified Cloudflare Access identity for an app session (no passphrase).
      if (e1.status !== 401 || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) throw e1;
      await api("POST", "/auth/access-login", {}, { noAuthRedirect: true });
      me = await api("GET", "/api/me", undefined, { noAuthRedirect: true });
    }
    S.me = me.principal; S.csrf = me.csrf;
    if (S.me.kind !== "human") { S.me = null; return viewLogin("Bearer-token principals cannot use the browser app."); }
    purgeForeignDrafts(S.me.id);
  } catch (e) { S.me = null; }
  route();
})();
})();
`;
