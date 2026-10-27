// Syntax-highlighting editor for Markdown and HTML documents (CodeMirror 6), built to /editor.js by
// scripts/build-editor.mjs and loaded lazily by the app. It deliberately exposes a TEXTAREA-LIKE adapter
// (value, selectionStart/End, setSelectionRange, scrollTop, focus, readOnly, input/scroll events) so the
// app's autosave, drafts, conflict view, caret anchoring and resume logic keep working unchanged.
// No network access, no eval; styles go through constructable stylesheets (CSP style-src 'self' compatible).
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers, highlightSpecialChars, placeholder as cmPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { tags as t } from "@lezer/highlight";

// Colours come from CSS variables so light/dark themes follow the app.
const hl = HighlightStyle.define([
  { tag: t.heading, color: "var(--cm-heading)", fontWeight: "700" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--cm-link)" },
  { tag: [t.monospace], color: "var(--cm-code)" },
  { tag: [t.quote], color: "var(--cm-muted)", fontStyle: "italic" },
  { tag: [t.list], color: "var(--cm-accent)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--cm-muted)" },
  { tag: [t.tagName], color: "var(--cm-tag)" },
  { tag: [t.angleBracket], color: "var(--cm-muted)" },
  { tag: [t.attributeName, t.propertyName], color: "var(--cm-attr)" },
  { tag: [t.attributeValue, t.string], color: "var(--cm-string)" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "var(--cm-muted)", fontStyle: "italic" },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--cm-keyword)" },
  { tag: [t.number, t.bool, t.atom, t.unit], color: "var(--cm-number)" },
  { tag: [t.className, t.definition(t.variableName), t.function(t.variableName)], color: "var(--cm-def)" },
  { tag: [t.character, t.escape], color: "var(--cm-number)" },
  { tag: [t.invalid], color: "var(--cm-invalid)" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "14.5px", backgroundColor: "var(--field)", color: "var(--fg)", border: "1px solid var(--line2)", borderRadius: "10px", minHeight: "var(--cm-min-h, 58vh)" },
  "&.cm-focused": { outline: "none", borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" },
  ".cm-scroller": { fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", lineHeight: "1.6", maxHeight: "var(--cm-max-h, 75vh)", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--cm-active, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-cursor": { borderLeftColor: "var(--fg)" },
  "&.cm-readonly .cm-content": { opacity: "0.85" },
  ".cm-panels": { backgroundColor: "var(--sunk)", color: "var(--fg)" },
  ".cm-panels input, .cm-panels button": { fontSize: "14px" },
});

/**
 * Mount an editor into `parent`. Returns a textarea-like adapter.
 * opts: { lang: "markdown"|"html", value, label, lineNumbers }
 */
// The app's CSP is style-src 'self' (no inline <style>). style-mod (CodeMirror's style injector) only uses
// CSP-safe constructable stylesheets (document.adoptedStyleSheets) when the root has no .head, so we hand it a
// root object that is the real document for everything (selection, focus, events) except that one check.
let cspSafeRoot = null;
function docRoot() {
  if (cspSafeRoot) return cspSafeRoot;
  const doc = document;
  cspSafeRoot = new Proxy(doc, {
    get(t, k) { if (k === "head") return undefined; const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; },
    set(t, k, v) { return Reflect.set(t, k, v, t); },
  });
  return cspSafeRoot;
}

export function mountEditor(parent, opts) {
  const listeners = { input: [], scroll: [], focus: [], blur: [] };
  const fire = (type) => listeners[type].forEach((fn) => { try { fn(new Event(type)); } catch (e) { setTimeout(() => { throw e; }); } });
  const ro = new Compartment();
  const roAttr = new Compartment();
  let silent = false;
  const lang = opts.lang === "html" ? html({ autoCloseTags: true, matchClosingTags: true }) : markdown({ base: markdownLanguage });
  const view = new EditorView({
    parent,
    root: document.adoptedStyleSheets !== undefined && window.CSSStyleSheet ? docRoot() : undefined,
    state: EditorState.create({
      doc: opts.value || "",
      extensions: [
        opts.lineNumbers ? lineNumbers() : [],
        highlightSpecialChars(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(),
        highlightActiveLine(), highlightSelectionMatches(),
        EditorView.lineWrapping,
        lang, syntaxHighlighting(hl), theme,
        ro.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
        EditorView.editorAttributes.of({ class: "cm-doc-editor" }),
        roAttr.of([]),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": opts.label || "Document source", spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
        opts.placeholder ? cmPlaceholder(opts.placeholder) : [],
        EditorView.updateListener.of((u) => { if (u.docChanged && !silent) fire("input"); }),
        EditorView.domEventHandlers({ scroll: () => { fire("scroll"); }, focus: () => { fire("focus"); }, blur: () => { fire("blur"); } }),
      ],
    }),
  });
  const sc = view.scrollDOM;
  sc.addEventListener("scroll", () => fire("scroll"), { passive: true });
  let readOnly = false;
  const adapter = {
    view,
    dom: view.dom,
    get value() { return view.state.doc.toString(); },
    set value(v) {
      silent = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(v) }, selection: { anchor: 0 } }); }
      finally { silent = false; }
    },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    setSelectionRange(a, b) {
      const n = view.state.doc.length;
      const from = Math.max(0, Math.min(n, a | 0)), to = Math.max(0, Math.min(n, (b ?? a) | 0));
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    },
    get scrollTop() { return sc.scrollTop; },
    set scrollTop(v) { sc.scrollTop = v; },
    get readOnly() { return readOnly; },
    set readOnly(v) {
      readOnly = !!v;
      view.dispatch({ effects: [ro.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        roAttr.reconfigure(readOnly ? EditorView.editorAttributes.of({ class: "cm-readonly" }) : [])] });
    },
    focus(o) { view.focus(); if (!(o && o.preventScroll)) view.dispatch({ scrollIntoView: true }); },
    blur() { view.contentDOM.blur(); },
    select() { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); },
    isFocused() { return view.hasFocus; },
    /** Line height in px (for caret/scroll anchoring that assumes a uniform line height). */
    lineHeight() { return view.defaultLineHeight || 20; },
    /** Document offset of the top visible line and the pixel delta inside it. */
    topAnchor() {
      // lineBlockAtHeight takes a height relative to the document top; the scroller's scrollTop is that height
      // minus the content padding (documentPadding.top).
      const h = Math.max(0, sc.scrollTop - view.documentPadding.top);
      const blk = view.lineBlockAtHeight(h);
      return { pos: blk.from, delta: h - blk.top };
    },
    /** Scroll so that document offset `pos` is the top visible line (+delta px). */
    scrollToPos(pos, delta) {
      const n = view.state.doc.length;
      const blk = view.lineBlockAt(Math.max(0, Math.min(n, pos)));
      sc.scrollTop = Math.max(0, blk.top + view.documentPadding.top + (delta || 0));
    },
    addEventListener(type, fn) { if (listeners[type]) listeners[type].push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
    destroy() { view.destroy(); },
  };
  return adapter;
}
