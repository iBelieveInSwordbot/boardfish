# Boardfish 4 · AI Director

New in Boardfish 4: **Ronan** (Scorsese/Tarantino/Hitchcock director agent) turns
scripts into structured shot lists, and **Nano Banana Pro** (Gemini 3 Pro Image)
renders the panels. Everything else from Boardfish 3 is unchanged — this is
strictly additive.

## Architecture

```
┌──────────────────────────┐        HTTP        ┌──────────────────────────┐         spawn(openclaw ...)
│ Boardfish 4 web UI       │ ─────────────────▶ │ ai-proxy (Node/Express)  │ ────────────────────────▶  Ronan agent  (gpt-5)
│ (Vite dev server :5173)  │  /api/ronan/*     │ 127.0.0.1:5174           │                             Nano Banana (google/gemini-3-pro-image)
│                          │  /api/image/*     │                          │
└──────────────────────────┘                    └──────────────────────────┘
```

- The React app calls same-origin `/api/*`; Vite's dev proxy forwards to `:5174`.
- The proxy shells out to the `openclaw` CLI (`agent --agent ronan` and
  `infer image generate`).
- No credentials in the browser. No direct model access from the client.

## Running it

Terminal 1 — the AI proxy:

```bash
cd projects/boardfish/ai-proxy
npm install       # first time only
npm start
# [boardfish-ai-proxy] listening on http://127.0.0.1:5174
```

Terminal 2 — the app:

```bash
cd projects/boardfish
npm run dev
# ➜  Local:   http://localhost:5173/
```

Open http://localhost:5173/ and click ✨ **AI Director** in the toolbar (⌘K).

## Flow

1. **Paste a script.** Any length; Ronan will decide how many shots.
2. **Optional direction.** e.g. "more Hitchcock", "handheld", "color, not b&w".
3. **Generate shot list.** Ronan returns 4–40 shots with slugs, camera language,
   aspect ratios, image prompts, and per-shot director notes.
4. **Edit prompts inline.** Expand any shot row to tweak its image prompt before
   generation.
5. **Create storyboard.** A new storyboard item is added at the end of the doc,
   panels are seeded with the shot data and (if enabled) images are rendered
   sequentially via Nano Banana Pro. Each panel keeps its `aiPrompt` for later
   edits and re-gens.

## Per-panel controls (hover any panel)

- ✨ **AI** — first-time generation. Opens the prompt editor.
- ✎ **Prompt** — edit the stored prompt.
- ↻ **Re-gen** — regenerate with the current prompt (no dialog).

New blank panels also expose the ✨ **AI** button, so you can add a panel and
type a description straight into it.

## Files touched (net-new only, per Matt's rule)

- `src/types.ts` — `Panel.aiPrompt?: string` added (optional, back-compat)
- `src/store.ts` — new action `SET_LAST_STORYBOARD_PANELS`; `aiPrompt` threaded
  through `normalizePanel` and `deepClonePanel`
- `src/project-io.ts` — `aiPrompt` persists in the `.boardfish` zip payload
- `src/ai/{client.ts,types.ts}` — new (AI proxy client)
- `src/components/AIDrawer.tsx` — new (script → shot list modal)
- `src/components/Panel.tsx` — hover-revealed AI controls at bottom-right
- `src/components/Toolbar.tsx` — ✨ AI Director button + brand rename to "Boardfish 4"
- `src/App.tsx` — mounts `AIDrawer`, adds ⌘K shortcut
- `src/App.css` — AI drawer + panel AI control styles
- `vite.config.ts` — `/api` proxy to the local ai-proxy
- `ai-proxy/` — new Node/Express bridge

Existing Boardfish 3 code paths are untouched. Old projects load and save the
same way; the new `aiPrompt` field is silently absent on legacy panels.

## Debugging

- `curl http://127.0.0.1:5174/api/health` — is the proxy up?
- `curl -X POST http://127.0.0.1:5174/api/ronan/shot-list -H 'Content-Type: application/json' -d '{"script":"..."}'`
- Nano Banana output arrives as a data URL that goes straight into
  `Panel.imageDataUrl`, so it participates in the existing PDF/zip export
  pipeline unchanged.
- Ronan runs stateful sessions. The shot-list response returns a `sessionId`
  the client can (later) pass back to continue the same conversation.
