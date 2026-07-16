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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

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

// Storyboard / scripted-flow image generation.
//
// Historically shelled to `openclaw infer image generate --model
// google/gemini-3-pro-image-preview`, which routes to Google AI Studio and
// requires a separate prepay account. As of 2026-07-16 that account ran
// out and Matt asked to route this through fal Nano Banana Pro so all of
// Boardfish is billed to one provider (fal). Same endpoint the node
// editor's Image Gen node uses, so pricing/creds are already wired.
//
// Returns the same shape the client expects: { dataUrl, width, height, mime }.
async function generateImage({ prompt, aspectRatio }) {
  if (!FAL_KEY) throw new Error('FAL_KEY not configured on server');
  const endpoint = 'fal-ai/nano-banana-pro';
  const input = {
    prompt,
    aspect_ratio: aspectRatio || '16:9',
    num_images: 1,
    output_format: 'png',
  };
  const submitUrl = `${FAL_BASE}/${endpoint}`;
  const submit = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new Error(`FAL submit ${submit.status}: ${body.slice(0, 300)}`);
  }
  const submitJson = await submit.json();
  const requestId = submitJson.request_id;
  if (!requestId) throw new Error(`FAL did not return a request_id: ${JSON.stringify(submitJson).slice(0, 300)}`);
  const statusUrl = submitJson.status_url || `${FAL_BASE}/${endpoint}/requests/${requestId}/status`;
  const resultUrl = submitJson.response_url || `${FAL_BASE}/${endpoint}/requests/${requestId}`;
  const started = Date.now();
  let result = null;
  while (Date.now() - started < FAL_POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
    const s = await fetch(statusUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    if (!s.ok) continue;
    const sj = await s.json();
    if (sj.status === 'COMPLETED') {
      const r = await fetch(resultUrl, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
      result = await r.json();
      break;
    }
    if (sj.status === 'FAILED' || sj.status === 'ERROR') {
      throw new Error(`FAL job failed: ${JSON.stringify(sj).slice(0, 300)}`);
    }
  }
  if (!result) throw new Error('FAL job timed out');
  // Nano Banana returns { images: [{ url, width, height, content_type }], ... }
  const image = Array.isArray(result?.images) ? result.images[0] : null;
  const imgUrl = image?.url;
  if (!imgUrl) throw new Error(`no image URL in FAL result: ${JSON.stringify(result).slice(0, 300)}`);
  // Download the image and convert to a data URL to match the previous
  // (openclaw-infer) return shape. Storyboard consumers embed this
  // directly in <img src>, so keeping data URLs avoids CORS surprises.
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`FAL image download failed: ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mime = image?.content_type || 'image/png';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  return {
    dataUrl,
    width: image?.width,
    height: image?.height,
    mime,
  };
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
// Admin-scope key for Platform APIs (billing, usage, pricing). Separate
// from FAL_KEY because Platform APIs require an admin-scope key while
// FAL_KEY may be a lower-privilege inference key.
const FAL_ADMIN_KEY = process.env.FAL_ADMIN_KEY || FAL_KEY || '';
const FAL_BASE = 'https://queue.fal.run';
const FAL_PLATFORM_BASE = 'https://api.fal.ai/v1';
// Cap how long we'll poll a single FAL job. Video jobs can genuinely take a
// few minutes; images are seconds. 5 min is a safe ceiling; the client can
// still cancel by disconnecting.
const FAL_POLL_MAX_MS = 5 * 60 * 1000;
const FAL_POLL_INTERVAL_MS = 1500;

// ---------- Platform API caches ----------
// Billing: short TTL so the node view balance stays fresh but we don't
// hammer fal every second when multiple tabs are open.
const BILLING_CACHE_TTL_MS = 60 * 1000; // 1 min
// Pricing: long TTL. Model prices don't change day-to-day.
const PRICING_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let billingCache = { value: null, at: 0, error: null };
const pricingCache = new Map(); // endpoint_id -> { value, at, error }

async function fetchFalBilling() {
  const now = Date.now();
  if (billingCache.value && now - billingCache.at < BILLING_CACHE_TTL_MS) {
    return { fresh: false, ...billingCache.value };
  }
  const res = await fetch(`${FAL_PLATFORM_BASE}/account/billing?expand=credits`, {
    headers: { Authorization: `Key ${FAL_ADMIN_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`fal /account/billing ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const value = {
    balance: json?.credits?.current_balance ?? null,
    currency: json?.credits?.currency ?? 'USD',
    // fal credits are prepaid USD (1 credit = $1). Documented
    // in Matt's notes; matches invoice behavior. Sent to the client
    // so the pill can render "1 credit = $1 USD" without hard-coding.
    pricePerCredit: 1.0,
    fetchedAt: now,
  };
  billingCache = { value, at: now, error: null };
  return { fresh: true, ...value };
}

async function fetchFalPrice(endpointId) {
  const now = Date.now();
  const cached = pricingCache.get(endpointId);
  if (cached && cached.value && now - cached.at < PRICING_CACHE_TTL_MS) {
    return { fresh: false, ...cached.value };
  }
  const url = `${FAL_PLATFORM_BASE}/models/pricing?endpoint_id=${encodeURIComponent(endpointId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Key ${FAL_ADMIN_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`fal /models/pricing ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const price = Array.isArray(json?.prices) ? json.prices[0] : null;
  if (!price) {
    const err = new Error(`no pricing found for endpoint "${endpointId}"`);
    err.status = 404;
    throw err;
  }
  const value = {
    endpointId,
    unit: price.unit,
    unitPrice: price.unit_price,
    currency: price.currency || 'USD',
    fetchedAt: now,
  };
  pricingCache.set(endpointId, { value, at: now, error: null });
  return { fresh: true, ...value };
}

app.get('/api/fal/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(FAL_KEY),
    // Whether Platform APIs (billing, pricing) will work.
    platformConfigured: Boolean(FAL_ADMIN_KEY),
  });
});

// Current credit balance for the node view top bar.
app.get('/api/fal/billing', async (_req, res) => {
  if (!FAL_ADMIN_KEY) {
    return res.status(503).json({ error: 'FAL_ADMIN_KEY not configured on server' });
  }
  try {
    const info = await fetchFalBilling();
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error('[fal billing]', err.message);
    res.status(err.status || 502).json({ error: String(err.message || err) });
  }
});

// Per-endpoint pricing lookup for the Generate button cost hint.
// Query: ?endpoint=fal-ai/nano-banana-pro (URL-encoded)
app.get('/api/fal/price', async (req, res) => {
  if (!FAL_ADMIN_KEY) {
    return res.status(503).json({ error: 'FAL_ADMIN_KEY not configured on server' });
  }
  const endpointId = String(req.query.endpoint || '').trim();
  if (!endpointId || !endpointId.startsWith('fal-ai/')) {
    return res.status(400).json({ error: 'endpoint (fal-ai/...) query param required' });
  }
  try {
    const info = await fetchFalPrice(endpointId);
    res.json({ ok: true, ...info });
  } catch (err) {
    console.error('[fal price]', endpointId, err.message);
    res.status(err.status || 502).json({ error: String(err.message || err), endpointId });
  }
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

// Optional HTTPS. Point TLS_CERT_FILE + TLS_KEY_FILE at cert + key files
// (e.g. Tailscale-issued certs: `tailscale cert swordbot.tail2a1eb4.ts.net`)
// to serve the app over HTTPS. Chromium blocks "insecure download" on
// http:// origins, so HTTPS is required when users need to download the
// generated MP4s / renders.
//
// Behavior:
//   * If TLS_CERT_FILE and TLS_KEY_FILE are both present, listen on HTTPS.
//   * If HTTP_REDIRECT_PORT is also set, additionally spin up a tiny
//     HTTP listener on that port that 301-redirects to https://<host>.
//   * Missing / unreadable cert files log a warning and fall back to HTTP
//     so the app never fails to boot because of a stale cert path.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE  = process.env.TLS_KEY_FILE  || '';
const HTTP_REDIRECT_PORT = process.env.HTTP_REDIRECT_PORT ? Number(process.env.HTTP_REDIRECT_PORT) : null;

function tryLoadTlsOptions() {
  if (!TLS_CERT_FILE || !TLS_KEY_FILE) return null;
  try {
    const cert = readFileSync(TLS_CERT_FILE);
    const key  = readFileSync(TLS_KEY_FILE);
    return { cert, key };
  } catch (err) {
    console.warn(`[boardfish-ai-proxy] TLS cert/key unreadable (${err.code || err.message}); falling back to HTTP.`);
    return null;
  }
}

const tlsOptions = tryLoadTlsOptions();
const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
const scheme = tlsOptions ? 'https' : 'http';

server.listen(PORT, HOST, () => {
  const bindLabel = HOST === '0.0.0.0' ? `all interfaces:${PORT}` : `${HOST}:${PORT}`;
  console.log(`[boardfish-ai-proxy] listening (${scheme}) on ${bindLabel}`);
  console.log(`  Static app: ${SERVE_STATIC ? DIST_DIR : '(none — dev-mode, no dist/ found)'}`);
  console.log(`  POST /api/ronan/shot-list   { script, defaultAspect?, constraints?, sessionId?, directorRefs?, styleKey? }`);
  console.log(`  POST /api/ronan/refine      { instruction, shot, sessionId?, defaultAspect?, directorRefs? }`);
  console.log(`  POST /api/fal/run           { endpoint, input } → submit + wait for a FAL job`);
  console.log(`  GET  /api/fal/health        → whether FAL_KEY is configured`);
  console.log(`  GET  /api/styles            → list of available style presets`);
  console.log(`  POST /api/image/generate    { prompt, aspectRatio? }`);
  console.log(`  GET  /api/health`);
});

// Optional HTTP -> HTTPS redirect listener. Runs alongside the HTTPS server
// so links to the old http://host:5175/ still work.
if (tlsOptions && HTTP_REDIRECT_PORT) {
  const redirect = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0] || HOST;
    const location = `https://${host}:${PORT}${req.url}`;
    res.writeHead(301, { Location: location });
    res.end();
  });
  redirect.listen(HTTP_REDIRECT_PORT, HOST, () => {
    console.log(`[boardfish-ai-proxy] http\u2192https redirect on ${HOST}:${HTTP_REDIRECT_PORT} \u2192 https://<host>:${PORT}`);
  });
}
