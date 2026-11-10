/** UTF-8 bytes per text revision (Markdown, HTML, JSON and CSV), independent of transport limits. */
export const TEXT_MAX_BYTES = 10 * 1024 * 1024;
/** JSON envelope budget for app/v1 create and save routes only. */
export const TEXT_WRITE_BODY_BYTES = 11 * 1024 * 1024;
