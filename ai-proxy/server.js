// Boardfish 5 AI proxy (branched from v4 baseline).
// Bridges the Vite dev server / built app to OpenClaw + FAL:
//   POST /api/ronan/shot-list   → Ronan turns a script into a structured shot list
//   POST /api/ronan/refine      → Ronan rewrites a single shot with fresh direction
//   POST /api/image/generate    → Nano Banana Pro renders one panel image (returns data URL)
//   POST /api/fal/run           → Submit a job to any FAL model endpoint and wait for the result
//   GET  /api/fal/health        → Whether FAL_KEY is configured on the server
//   GET  /api/styles            → Named style presets
//
// Everything runs local. No browser auth (bind can be 0.0.0.0 for tailnet).
// The FAL API key lives in the server env (FAL_KEY) and is never returned
// to the browser — the browser only sends job payloads through /api/fal/run.

import express from 'express';
import { spawn } from 'node:child_process';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// FAL requests to Nano Banana Pro with N reference images push the JSON
// body past Express's default 100 kb limit fast. Each ref image is inlined
// as a base64 data URL by the browser (raw file bytes * 1.33). Cap 100 mb
// to accommodate 6 refs at 4K + headroom for edit endpoints. If you ever
// see PayloadTooLargeError from bodyParser, bump this.
app.use(express.json({ limit: '100mb' }));

const PORT = Number(process.env.PORT || 5174);
// Default bind is loopback-only. When serving over Tailscale (or any LAN), pass
//   HOST=0.0.0.0 npm start
// so remote tailnet devices can reach the app. Tailscale ACLs already restrict
// who can hit the tailnet in the first place.
const HOST = process.env.HOST || '127.0.0.1';
const OPENCLAW = process.env.OPENCLAW_BIN || 'openclaw';
// If ../dist exists we serve the built Boardfish app from the same origin so
// there's exactly one URL to share. Fall back to just API routes otherwise
// (that's the dev-server mode where Vite proxies /api to us).
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const SERVE_STATIC = existsSync(DIST_DIR);

// ---------- OpenClaw helpers ----------

function runOpenclaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`openclaw exited ${code}: ${stderr || stdout}`));
    });
  });
}

// Ronan is stateful. Reuse a sessionId across calls in the same project so he
// remembers the script and prior direction decisions.
async function callRonan({ message, sessionId }) {
  const args = ['agent', '--agent', 'ronan', '--json', '--timeout', '120', '--message', message];
  if (sessionId) args.push('--session-id', sessionId);
  const { stdout } = await runOpenclaw(args);
  const parsed = JSON.parse(stdout);
  const text = parsed?.result?.payloads?.[0]?.text ?? '';
  const nextSessionId = parsed?.result?.meta?.agentMeta?.sessionId ?? sessionId ?? null;
  return { text, sessionId: nextSessionId, raw: parsed };
}

async function generateImage({ prompt, aspectRatio }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'boardfish-ai-'));
  const outPath = path.join(dir, 'panel.png');
  const args = [
    'infer', 'image', 'generate',
    '--prompt', prompt,
    '--model', 'google/gemini-3-pro-image-preview',
    '--output', outPath,
    '--json',
  ];
  if (aspectRatio) args.push('--aspect-ratio', aspectRatio);
  const { stdout } = await runOpenclaw(args);
  // openclaw prints preamble lines (warnings, migrations) before the JSON envelope.
  // Scan for the first top-level object that parses cleanly.
  const envelope = parseTopLevelJson(stdout);
  if (!envelope) throw new Error(`no JSON envelope in openclaw output: ${stdout.slice(0, 500)}`);
  const output = envelope?.outputs?.[0];
  if (!output?.path) throw new Error(`no output image: ${JSON.stringify(envelope).slice(0, 500)}`);
  const bytes = await readFile(output.path);
  const mime = output.mimeType || 'image/png';
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  // Best-effort cleanup — don't await, don't crash.
  unlink(output.path).catch(() => {});
  return { dataUrl, width: output.width, height: output.height, mime };
}

// ---------- Ronan director prompts ----------

// System-ish preamble: prepended to every shot-list request so Ronan reliably
// thinks like a director and returns clean JSON. Ronan's own agent config
// already gives him a persona; this is the *task* framing on top of that.
const DIRECTOR_PREAMBLE_BASE = `You are Ronan, working as a great film director. By default, think in the tradition of Scorsese (bold camera moves, kinetic energy, character close-ups that reveal soul), Tarantino (long dialogue takes broken by sudden violence, low-angle hero shots, chapter-like structure), and Hitchcock (subjective POV, suspense from what's *not* shown, meticulous framing, use of space).

For each script, decide:
- How to break it into shots (not one shot per line — think in beats)
- Camera language per shot (wide/medium/close/insert; angle; movement)
- What the audience should *feel* in each moment
- Aspect ratio choice per shot when it serves the story (default to the storyboard's aspect if unsure)

Your image prompts must be usable by a text-to-image model that can't read scripts. They should be visually concrete: subject, action, lighting, mood, camera angle, style. No dialogue. No abstract emotions without visual anchors.`;

// Named style presets. `label` is what the UI shows, `tag` is what gets
// appended to every image prompt. Keep tags short — Nano Banana Pro follows
// terse style directives much better than paragraph-long ones.
const STYLE_PRESETS = {
  'pencil-sketch': {
    label: 'Pencil sketch',
    tag: 'Black-and-white pencil-sketch aesthetic, concise line work, greytone shading.',
  },
  'ink-wash': {
    label: 'Ink wash',
    tag: 'Black-and-white ink-wash illustration, loose brushwork, high-contrast shadows.',
  },
  'photoreal': {
    label: 'Photoreal',
    tag: 'Photorealistic cinematic still, natural lighting, shallow depth of field, film grain.',
  },
  'noir': {
    label: 'Film noir',
    tag: 'Black-and-white film-noir cinematography, hard chiaroscuro lighting, deep shadows, 35mm grain.',
  },
  'anime': {
    label: 'Anime',
    tag: 'Anime key-frame illustration, clean linework, cel-shaded color, dramatic composition.',
  },
  'watercolor': {
    label: 'Watercolor',
    tag: 'Loose watercolor illustration, soft edges, muted palette, paper texture.',
  },
  'comic-ink': {
    label: 'Comic book ink',
    tag: 'Comic-book ink illustration, bold outlines, halftone shading, dynamic composition.',
  },
  'none': {
    label: 'No style directive',
    tag: '',
  },
};

function styleTagFor(styleKey) {
  const preset = STYLE_PRESETS[styleKey] || STYLE_PRESETS['pencil-sketch'];
  return preset.tag;
}

function buildDirectorPreamble({ directorRefs }) {
  if (!directorRefs || !String(directorRefs).trim()) return DIRECTOR_PREAMBLE_BASE;
  return `${DIRECTOR_PREAMBLE_BASE}

DIRECTOR REFERENCES (user-provided): ${String(directorRefs).trim()}

Before drafting the shot list, do a mental research pass on each named director/artist. Consider:
- Their signature camera language (favorite lens lengths, angles, movement)
- How their long-time director of photography would light and frame these beats
- How their editor would cut the coverage (shot lengths, when to hold, when to cut hard)
- Any recurring visual motifs or compositional rules they're known for

Board this script as if that team were producing it. Weight the references you were given over the defaults above.`;
}

function buildShotListPrompt({ script, defaultAspect, constraints, directorRefs, styleKey }) {
  const styleTag = styleTagFor(styleKey);
  const styleLine = styleTag
    ? `- Style directive to append to every image prompt: "${styleTag}"`
    : `- No global style directive — let each shot's image prompt describe its own look.`;
  return `${buildDirectorPreamble({ directorRefs })}

TASK: Read this script and produce a shot list.

SCRIPT:
"""
${script}
"""

CONSTRAINTS:
- Default panel aspect ratio: ${defaultAspect || '16:9'} (only override per-shot if it clearly serves the story)
${styleLine}
${constraints ? `- Additional user constraints: ${constraints}` : ''}

RESPOND WITH ONE JSON OBJECT AND NOTHING ELSE. No markdown fences, no commentary before or after. Schema:

{
  "title": "short project title you infer from the script",
  "directorNotes": "2-3 sentences on your overall approach (which director's sensibility, why)",
  "shots": [
    {
      "shotNumber": 1,
      "slug": "INT. DINER - NIGHT",
      "action": "one line of what happens in this beat",
      "shotType": "WIDE | MEDIUM | CLOSE | EXTREME_CLOSE | INSERT | OTS | POV",
      "cameraMove": "STATIC | PAN | TILT | DOLLY | HANDHELD | CRANE | ZOOM (or a short phrase)",
      "angle": "EYE | HIGH | LOW | DUTCH | OVERHEAD",
      "aspectRatio": "16:9",
      "imagePrompt": "visually concrete text-to-image prompt: subject, action, lighting, mood, camera language. Append the style directive verbatim at the end if one is provided above.",
      "directorNote": "why this shot at this beat, referencing the named directors when relevant. One line."
    }
  ]
}

Return between 4 and 40 shots depending on script length. Do NOT include the JSON in a code fence. Start your response with { and end with }.`;
}

// ---------- Routes ----------

app.get('/api/styles', (_req, res) => {
  const styles = Object.entries(STYLE_PRESETS).map(([key, v]) => ({ key, label: v.label, tag: v.tag }));
  res.json({ ok: true, styles });
});

// ---------- FAL passthrough (Boardfish 5 node editor) ----------

const FAL_KEY = process.env.FAL_KEY || '';
const FAL_BASE = 'https://queue.fal.run';
// Cap how long we'll poll a single FAL job. Video jobs can genuinely take a
// few minutes; images are seconds. 5 min is a safe ceiling; the client can
// still cancel by disconnecting.
const FAL_POLL_MAX_MS = 5 * 60 * 1000;
const FAL_POLL_INTERVAL_MS = 1500;

app.get('/api/fal/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(FAL_KEY) });
});

// Submit + wait. Body: { endpoint: "fal-ai/nano-banana/edit" | "fal-ai/veo3" | ...,
//                        input: {...FAL model inputs...},
//                        webhookUrl?: string (unused; sync mode) }
// Returns: { ok: true, result: <the FAL model output payload> }
app.post('/api/fal/run', async (req, res) => {
  if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not configured on server' });
  const { endpoint, input } = req.body || {};
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ error: 'endpoint (string, e.g. "fal-ai/nano-banana/edit") required' });
  }
  if (!input || typeof input !== 'object') {
    return res.status(400).json({ error: 'input (object) required' });
  }
  // Normalize: allow full URLs but require the fal-ai/... path portion.
  const path = endpoint
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^queue\.fal\.run\//, '')
    .replace(/^\/+/, '');
  const submitUrl = `${FAL_BASE}/${path}`;
  try {
    const submit = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!submit.ok) {
      const body = await submit.text();
      return res.status(submit.status).json({ error: `FAL submit failed: ${submit.status}`, body });
    }
    const submitJson = await submit.json();
    const requestId = submitJson.request_id;
    if (!requestId) {
      return res.status(502).json({ error: 'FAL did not return a request_id', body: submitJson });
    }
    // FAL returns authoritative status_url + response_url in the submit payload.
    // For sub-endpoints like `fal-ai/nano-banana-pro/edit`, the poll URLs strip
    // the trailing subpath (e.g. status lives at `fal-ai/nano-banana-pro/requests/...`).
    // Trust FAL's returned URLs; fall back to a derived path only if missing.
    const statusUrl = submitJson.status_url || `${FAL_BASE}/${path}/requests/${requestId}/status`;
    const resultUrl = submitJson.response_url || `${FAL_BASE}/${path}/requests/${requestId}`;
    const started = Date.now();
    // Poll for completion.
    while (Date.now() - started < FAL_POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
      const s = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      if (!s.ok) continue;
      const sj = await s.json();
      if (sj.status === 'COMPLETED') {
        const r = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
        const rj = await r.json();
        // FAL sometimes returns validation errors *inside* a COMPLETED response
        // as `{ detail: [...] }`. Surface those as proper HTTP errors so the UI
        // can show a real message instead of a generic "no image/video URL".
        if (rj && Array.isArray(rj.detail) && rj.detail.length > 0) {
          const first = rj.detail[0] || {};
          const field = Array.isArray(first.loc) ? first.loc.join('.') : String(first.loc ?? '');
          const msg = String(first.msg ?? 'validation error');
          return res.status(400).json({
            error: `FAL ${path} rejected input: ${field ? field + ' — ' : ''}${msg}`,
            detail: rj.detail,
            requestId,
          });
        }
        return res.json({ ok: true, requestId, endpoint: path, result: rj });
      }
      if (sj.status === 'FAILED' || sj.status === 'ERROR') {
        return res.status(502).json({ error: 'FAL job failed', status: sj.status, body: sj });
      }
      // IN_QUEUE / IN_PROGRESS — keep polling.
    }
    return res.status(504).json({ error: 'FAL job timed out', requestId, endpoint: path });
  } catch (err) {
    console.error('[fal] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await runOpenclaw(['--version']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/ronan/shot-list', async (req, res) => {
  const { script, defaultAspect, constraints, sessionId, directorRefs, styleKey } = req.body || {};
  if (!script || typeof script !== 'string') {
    return res.status(400).json({ error: 'script (string) required' });
  }
  try {
    const prompt = buildShotListPrompt({ script, defaultAspect, constraints, directorRefs, styleKey });
    const { text, sessionId: nextSessionId } = await callRonan({ message: prompt, sessionId });
    // Strip any accidental markdown fences or preambles.
    const cleaned = extractJson(text);
    if (!cleaned) {
      return res.status(502).json({ error: 'Ronan did not return valid JSON', raw: text.slice(0, 2000) });
    }
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      return res.status(502).json({ error: `JSON parse failed: ${e.message}`, raw: cleaned.slice(0, 2000) });
    }
    res.json({ ok: true, sessionId: nextSessionId, shotList: parsed });
  } catch (err) {
    console.error('[shot-list] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/ronan/refine', async (req, res) => {
  const { instruction, shot, sessionId, defaultAspect, directorRefs } = req.body || {};
  if (!instruction || !shot) {
    return res.status(400).json({ error: 'instruction and shot required' });
  }
  try {
    const message = `${buildDirectorPreamble({ directorRefs })}

TASK: Refine this single shot per the user's instruction. Preserve the shot number.

CURRENT SHOT (JSON):
${JSON.stringify(shot, null, 2)}

USER INSTRUCTION: ${instruction}

Default aspect if unspecified: ${defaultAspect || '16:9'}

RESPOND WITH ONE JSON OBJECT (the revised shot) AND NOTHING ELSE. Same schema as before. Start with { end with }.`;
    const { text, sessionId: nextSessionId } = await callRonan({ message, sessionId });
    const cleaned = extractJson(text);
    if (!cleaned) return res.status(502).json({ error: 'Ronan did not return valid JSON', raw: text.slice(0, 2000) });
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { return res.status(502).json({ error: `JSON parse failed: ${e.message}`, raw: cleaned.slice(0, 2000) }); }
    res.json({ ok: true, sessionId: nextSessionId, shot: parsed });
  } catch (err) {
    console.error('[refine] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/image/generate', async (req, res) => {
  const { prompt, aspectRatio } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }
  try {
    const out = await generateImage({ prompt, aspectRatio: normalizeAspect(aspectRatio) });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[image] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- helpers ----------

// Scan a multi-line stdout for the first top-level {...} block that parses.
// Handles openclaw's `[state-migrations] ...` preamble and nested braces.
function parseTopLevelJson(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '{') continue;
    // Try to walk forward until braces balance.
    let depth = 0;
    let buf = '';
    for (let j = i; j < lines.length; j++) {
      buf += lines[j] + '\n';
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      if (depth === 0) {
        try { return JSON.parse(buf); } catch { break; }
      }
    }
  }
  // Fallback: last resort — try parsing the full stdout.
  try { return JSON.parse(stdout); } catch { return null; }
}

// Best-effort JSON extraction from a Ronan reply. Ronan is instructed to return
// raw JSON but may wrap it in ```json ... ``` or add a stray sentence. We find
// the outermost {...} block that parses.
function extractJson(text) {
  if (!text) return null;
  // Strip common fences first.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < 0 || last < first) return null;
  return text.slice(first, last + 1);
}

// Nano Banana accepts ratios from the supported set. Coerce numeric ratios to
// the closest supported label.
const SUPPORTED_ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
function normalizeAspect(input) {
  if (!input) return undefined;
  if (typeof input === 'string' && SUPPORTED_ASPECTS.includes(input)) return input;
  const num = typeof input === 'number' ? input : Number(String(input).split(':').map(Number).reduce((a, b) => a / b));
  if (!Number.isFinite(num)) return undefined;
  let best = SUPPORTED_ASPECTS[0];
  let bestDiff = Infinity;
  for (const s of SUPPORTED_ASPECTS) {
    const [w, h] = s.split(':').map(Number);
    const diff = Math.abs(num - w / h);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

// ---------- start ----------

// Static app (only when a prod build exists). Mount AFTER the /api routes so
// they still win. This makes the proxy a one-URL production server.
if (SERVE_STATIC) {
  app.use(express.static(DIST_DIR, { index: 'index.html' }));
  // SPA fallback: any non-/api GET falls back to index.html so client-side
  // paths work if we ever add router routes. (Boardfish is single-page today.)
  // In Express 5, wildcard path syntax changed — use a RegExp instead of '*'.
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.listen(PORT, HOST, () => {
  const bindLabel = HOST === '0.0.0.0' ? `all interfaces:${PORT}` : `${HOST}:${PORT}`;
  console.log(`[boardfish-ai-proxy] listening on ${bindLabel}`);
  console.log(`  Static app: ${SERVE_STATIC ? DIST_DIR : '(none — dev-mode, no dist/ found)'}`);
  console.log(`  POST /api/ronan/shot-list   { script, defaultAspect?, constraints?, sessionId?, directorRefs?, styleKey? }`);
  console.log(`  POST /api/ronan/refine      { instruction, shot, sessionId?, defaultAspect?, directorRefs? }`);
  console.log(`  POST /api/fal/run           { endpoint, input } → submit + wait for a FAL job`);
  console.log(`  GET  /api/fal/health        → whether FAL_KEY is configured`);
  console.log(`  GET  /api/styles            → list of available style presets`);
  console.log(`  POST /api/image/generate    { prompt, aspectRatio? }`);
  console.log(`  GET  /api/health`);
});
