# Local social-video pipeline

Renders the AmigosNest vertical cut (1080×1920, 35s) without leaving the machine:
Windows SAPI for the voiceover, pure-Node WAV synthesis for the music and sound
effects, Playwright for the pictures, `ffmpeg-static` for the mix and encode.

```bash
npm run video:social:timeline     # rebuild script + voiceover + timeline only (fast)
npm run video:social:stills       # full render, plus one PNG per scene for review
npm run video:social              # full render
```

Run flags (pass through npm with `--`):

| flag | effect |
| --- | --- |
| `--timeline-only` | measure the voiceover, write the timeline, skip recording |
| `--reuse-voiceover` | keep the existing WAVs — use after editing animation only |
| `--stills` | also write `artifacts/social-video/stills/*.png` |

Output lands in `artifacts/social-video/` (git-ignored):

```
AmigosNest-thinking-companion-35s-9x16.mp4   the deliverable
timeline.json                                every cue, for debugging/QC
stills/                                      one review frame per scene
work/voice/*.wav                             per-line voiceover renders
work/*.m4a                                   music + sfx bed
```

`marketing/social-video/timeline.js` is generated next to the stage HTML — it is the
only thing the page reads, so picture and sound can never disagree about timing.

## Files

| file | role |
| --- | --- |
| `scripts/social-video/lines.mjs` | **source of truth for the words**: scenes, lines, voices, `TARGET_SECONDS` |
| `scripts/social-video/direction.mjs` | turns the script into cues (camera, expression, overlay, tint, sfx) and fits the cut to `TARGET_SECONDS` |
| `scripts/social-video/renders.mjs`… | see `render.mjs` — orchestrates voiceover → music → recording → mix |
| `scripts/social-video/audio.mjs` | offline WAV synthesis: music bed, chime, whoosh, tick |
| `scripts/social-video/tts-voiceover.ps1` | one SAPI line → one WAV |
| `marketing/social-video/amigosnest-35s.html` | the stage: SVG art + a renderer that only knows how to apply cues |
| `marketing/social-video/SCRIPT.md` | the script as a human-readable shot list |

## Requirements

* Windows (SAPI voices). `Microsoft Zira Desktop` + `Microsoft David Desktop` ship
  with Windows; pitch/rate shaping in `VOICES` stands in for a native Indian-English
  voice.
* `playwright` chromium + `ffmpeg-static` (already dev dependencies).
* The **first** render is slow: Playwright cold start plus a real-time recording, so
  expect roughly 2 minutes for 35 seconds of video on a laptop CPU.

## Timing model

1. Every spoken line is rendered to its own WAV and measured — speech length comes
   from the files, never from an estimate.
2. Closing cards keep a fixed hold (they are reading time); scene lead-ins are fixed
   by `LEAD`.
3. Whatever is left of `TARGET_SECONDS` is divided across the pauses between spoken
   beats, so the cut always lands on the target instead of running long.
4. If the pauses get squeezed below ~1.2s in total, the build prints a warning —
   that is the signal to shorten a line or raise `TARGET_SECONDS`.

## Notes / limits

* The recording always opens on 1.5s of black; the recorder measures where black
  actually ends and shifts the audio by that amount, so A/V sync does not depend on
  the browser's startup time.
* `alimiter` is only applied when the bundled ffmpeg build has it (it is a slim
  build); otherwise the mix falls back to a plain volume-safe encode.
* Everything here is offline and local: no cloud TTS, no stock music library, no
  model calls. Do not add a hosted voice or music service to this path.
