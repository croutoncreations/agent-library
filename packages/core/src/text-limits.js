/** UTF-8 bytes per text revision (Markdown, HTML, JSON and CSV), independent of transport limits. */
export const TEXT_MAX_BYTES = 10 * 1024 * 1024;
/** Markdown's higher renderer memory cost requires a smaller, partial-preview input budget. */
export const MARKDOWN_PREVIEW_MAX_BYTES = 262144;
/** HTML is rendered only in full: a cut-off page is not useful. */
export const HTML_RENDER_MAX_BYTES = 1048576;
/** JSON envelope budget for app/v1 create and save routes only. */
export const TEXT_WRITE_BODY_BYTES = 11 * 1024 * 1024;
