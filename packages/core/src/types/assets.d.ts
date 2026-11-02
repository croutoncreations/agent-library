// Browser assets kept as *.txt and imported as text (wrangler's default Text rule; esbuild text loader).
declare module "*.txt" { const text: string; export default text; }
