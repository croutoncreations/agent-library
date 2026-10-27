# Marketing screenshots and clips

`node scripts/marketing/capture.mjs --out tmp/marketing` starts the real Worker (`src/index.js`) under local
`wrangler dev` on loopback, seeds a fictional demo library (`seed.mjs`) and captures screenshots with headless Chrome.
`node scripts/marketing/clips.mjs` (default `--out tmp/marketing/clips`, where `marketing/video` looks for them) does the same, then records short UI clips for the launch video
(`marketing/video/`); see the header of `clips.mjs` for the clip list and `--only`/`--scheme`.

- **Demo content** (`demo-content.mjs`, `demo-images.mjs`): "Tidepool", a made-up habit tracker launching 1.0, owned by
  "Maya Chen". There are four projects (Tidepool app, Market research, QA runs, Personal), with Markdown docs (tables,
  code, quotes, embedded images), an HTML one-pager, a PNG chart, artwork, a JPEG "photo", a PDF, a screen recording,
  and CSV/JSON data files. All of it is synthetic, with no real people, users or production data.
- **Authors are real code paths.** "Claude", "ChatGPT" and the other assistants connect through the real OAuth consent
  flow and write over MCP with change notes. "Claude Code", "Codex" and "Pi" use project tokens and the real upload
  begin/PUT/finish. "Muse" uses a `/v1` API key. The owner writes through the browser API. So History, the "connected
  app" badges and Connections show actual product behavior. Tokens live in memory only and are never printed or saved.
- **Believable timestamps.** After seeding, the server stops, timestamps in the throwaway local D1 file are
  backdated (minutes to weeks ago), the owner is renamed "Maya Chen", and the server restarts on the same state.
- **Output**: `NN-scene-{desktop|mobile}-{light|dark}.png`. Desktop is 1440x900 @2x (2880x1800, 16:10) and mobile is
  390x844 @3x (1170x2532). The reader also has a `-full` full-page capture for scroll animations.

Options: `--only home,reader,...` (scene names are the second column of the `plan` table in `capture.mjs`, e.g. home,
project, reader, editor, landing, video, chart, pdf, history, diff, connections, tokens, csv, json, plus consent), `--scale 2`, `--port`.
