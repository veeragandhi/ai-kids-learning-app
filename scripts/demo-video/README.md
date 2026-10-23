# Demo video harness

Records the four AmigosNest landing-page demos against a **live** app instance
and exports them as H.264 MP4s. No mocked API responses — the lesson, the quiz
and the guided-thinking replies come from the real model.

| Script | Purpose |
| --- | --- |
| `rec-common.mjs` | Shared config: base URL, demo parent/child, browser profile, marker helper |
| `prep-profile.mjs` | Signs in, uploads the source document, generates one lesson so later runs have data |
| `record-a.mjs` | Demo A — kids learning hub |
| `record-b.mjs` | Demo B — parent dashboard |
| `record-c.mjs` | Demo C — upload → AI lesson |
| `record-d.mjs` | Demo D — guided thinking → quiz |
| `record-f-explore.mjs` | Demo F — Home Explore questions across a child's lessons |
| `build-videos.mjs` | Trims the raw captures, draws the corner label, exports MP4 + poster, writes `qa-report.json` |
| `build-consolidated.mjs` | Combines the parent dashboard, lesson workflow, guided Ask, quiz, and Explore into one upload-ready walkthrough |
| `frames.mjs` | Frame-diff analysis used to find dead time and to QA the exports |

## Requirements

- A running AmigosNest instance reachable over HTTP (the scripts default to
  `http://localhost:3100`).
- `playwright` (with browsers installed) and `ffmpeg-static` — both already in
  this repo's `devDependencies`.
- A parent account with a child profile, plus one uploaded document.
- `Arial Bold.ttf` for the corner label (override with `DEMO_FONT`).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_BASE_URL` | `http://localhost:3100` | App instance to record |
| `DEMO_WORK_DIR` | `$TMPDIR/amigosnest-demos` | Raw captures, markers and browser profiles |
| `DEMO_DEST` | `artifacts/amigosnest-demos` | Where the MP4s/poster/QA report are written |
| `DEMO_SOURCE_FILE` | `uploads/elephants.txt` | Document uploaded during demo C |
| `DEMO_FONT` | `/System/Library/Fonts/Supplemental/Arial Bold.ttf` | Font for the corner label |
| `FFMPEG_PATH` | `ffmpeg-static` binary | ffmpeg override |

## Notes

- Captures are viewport-only (1440×900, no browser chrome, no mouse cursor).
- Each recorder writes wall-clock markers to `out/marks-<demo>.json`;
  `build-videos.mjs` uses them to cut the two real model waits and to place the
  poster frame.
- The demo parent (`demo.parent@amigosnest.test`) and child (Milo, 🐯, age 7)
  are fictional. Point `rec-common.mjs` at your own account if you re-record.
- `record-f-explore.mjs` records real questions and answers from the Home
  Explore entry using the child's Plants and Elephants materials. Standalone
  Explore retrieves from all documents owned by that child, then grounds each
  response in the most relevant retrieved chunks; it does not load every saved
  lesson body into one prompt. It exports
  `artifacts/amigosnest-demos/amigosnest-explore.mp4` and its poster directly.
- `build-consolidated.mjs` combines the parent dashboard, upload-to-lesson,
  guided Ask, quiz, and Explore clips in that order. The separate child-hub
  overview is intentionally omitted because it reopened the same saved
  elephant lesson immediately after the lesson-generation clip.
