# Boardfish 5 — Video Storyboards

Started from `v4.0.0` on 2026-07-09.

## Goals

Extend Boardfish 4 with per-panel video capability so the storyboard becomes a rough animatic:

- Generate a short video clip from a still panel (Veo / Runway / etc.)
- Or: text-to-video directly from the shot's `imagePrompt`
- Preview + trim/loop per panel
- Play a whole storyboard as a sequence (basic timeline / animatic view)
- Export as MP4 (stretch)

## Constraints (do NOT break)

- v4 must stay untouched. Jenn is actively using it at
  `http://swordbot.tail2a1eb4.ts.net:5174/` and cannot be interrupted.
- v5 runs on port **5175** at `http://swordbot.tail2a1eb4.ts.net:5175/`.
- `.boardfish` project files must round-trip: v4 files open in v5,
  and v5 files without video content should stay v4-compatible where possible.

## Provider decisions (TBD with Matt)

- Video model: Google Veo 3 vs Runway vs another? Matt to decide.
- Cost caps: video is 10-100× the cost of stills, so we probably want a per-panel
  "generate video" button rather than batch-by-default.

## Ports / URLs

| Version | URL                                              | Port | LaunchAgent                        | Dir                                    |
|---------|--------------------------------------------------|------|------------------------------------|----------------------------------------|
| v4      | http://swordbot.tail2a1eb4.ts.net:5174/          | 5174 | ai.wozbot.boardfish4.plist         | ~/wozbot/projects/boardfish            |
| v5      | http://swordbot.tail2a1eb4.ts.net:5175/          | 5175 | ai.wozbot.boardfish5.plist         | ~/wozbot/projects/boardfish-5          |

## Backup story (as of 2026-07-09)

- GitHub: `iBelieveInSwordbot/boardfish`
- v4 branch: `boardfish-4-ai` (pushed)
- v4 tag: `v4.0.0` (pushed) — recovery point for v5 baseline
- v5 branch: `boardfish-5-video`
