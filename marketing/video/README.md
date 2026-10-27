# Agent Library launch video (Remotion)

This is a self-contained package with its own `package.json`. It is not part of the Worker build, CI or typecheck.

```bash
# 1. Generate assets from the real app (repo root; ~3 min + ~8 min)
node scripts/marketing/capture.mjs        # stills + collage tiles -> tmp/marketing
node scripts/marketing/clips.mjs          # 60 fps UI clips -> tmp/marketing/clips (both also save tmp/media/qa.mp4)
# 2. Copy them, the brand mark and your music track into public/ (git-ignored)
cd marketing/video && npm install && MUSIC=/path/to/track.mp3 npm run assets
# 3. Preview / render
npm run studio                            # Remotion Studio
npm run render                            # out/agent-library-hero.mp4 (1920x1080 @ 60 fps)
```

- **Look:** the app's dark theme (`src/theme.ts` mirrors `src/web/app.css` dark tokens), Inter plus JetBrains Mono, and the Fold mark.
- **Timing:** the music is ~95.1 BPM with the first beat at 0.61 s. Scene boundaries use `beatFrame(n)` (`src/timeline.ts`), so cuts land on beats.
- **Agent names** appear as plain text chips only, with no third-party logos.
- **Music** is not included (the launch video's track is licensed separately). Pass your own with `MUSIC=/path/to/track.mp3`; the beat timing in `src/theme.ts` matches the original track.
- **License:** [Remotion](https://www.remotion.dev/docs/license) has its own license (free for individuals and small companies). It is used only to render this video and is not part of Agent Library.
