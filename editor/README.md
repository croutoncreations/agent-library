# Embedded editor provenance

The maintained Worker baseline contains a CodeMirror 6 bundle. This directory restores its original source and an isolated exact lockfile so its provenance and dependency notices can be verified without a private checkout.

```sh
npm ci --prefix editor
npm run check:editor
npm audit --prefix editor
```

`build.mjs` builds in memory and compares SHA-256 with `editor/provenance.json` and the editor hash in the committed Worker. It never edits the Worker or changes the production build. The historical source commit and all 21 bundled package versions are recorded in the manifest. All 21 have MIT licenses, retained with their copyright years in THIRD_PARTY_NOTICES.md. The root project license does not replace third-party notices.

The renderer in `src/render/markdown.module.js` is application code with no package imports. Inline SVG geometry is identified as Lucide-style; the upstream ISC/Feather MIT notices are also retained. Native development tooling is installed from npm with its own licenses and is not embedded in the Worker.
