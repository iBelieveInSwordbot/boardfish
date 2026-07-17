// Boardfish 6 AI proxy (branched from v5 baseline).
// Bridges the Vite dev server / built app to OpenClaw + FAL:
//   POST /api/ronan/shot-list   → Ronan turns a script into a structured shot list + assets
//   POST /api/ronan/refine      → Ronan rewrites a single shot with fresh direction
//   POST /api/image/generate    → Nano Banana Pro renders one panel image (returns data URL)
//   POST /api/import/pdf        → Extract plain text from an uploaded PDF (multipart)
//   POST /api/fal/run           → Submit a job to any FAL model endpoint and wait for the result
//   GET  /api/fal/health        → Whether FAL_KEY is configured on the server
//   GET  /api/styles            → Named style presets
//
// Everything runs local. No browser auth (bind can be 0.0.0.0 for tailnet).
// The FAL API key lives in the server env (FAL_KEY) and is never returned
// to the browser — the browser only sends job payloads through /api/fal/run.

import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

ALSO extract three asset lists from the script:

- ACTORS: every named character who appears in a shot. If the script uses a generic role (WAITRESS, GUARD #2) but no name, use that role as the name. Do NOT invent minor background people who never speak or are only referenced in passing.
- LOCATIONS: every distinct place a shot happens in. Match slug lines when present ("INT. DINER - NIGHT" → "Diner"). Merge repeats.
- PROPS: important story objects the camera lingers on or that plot depends on (the letter, the pistol, the briefcase). Do NOT include ambient set dressing.

For each asset, write a "description" that is a visually concrete prompt the same text-to-image model could render blind. Include the style directive verbatim at the end of the description if one is provided. Actor descriptions should describe the person head-to-toe (age, build, hair, wardrobe, notable features, expression) so a full-body reference image is generatable. Location descriptions should describe the place at the time of day it appears (lighting, era, mood, notable set pieces). Prop descriptions describe the object in isolation (material, era, condition, distinguishing features).

For each shot, also fill in a "refs" object listing which of those asset names actually appear in that shot (subset of the asset names you produced above). This lets the storyboard tool wire the asset images in as visual references.

RESPOND WITH ONE JSON OBJECT AND NOTHING ELSE. No markdown fences, no commentary before or after. Schema:

{
  "title": "short project title you infer from the script",
  "directorNotes": "2-3 sentences on your overall approach (which director's sensibility, why)",
  "actors": [ { "name": "JOE", "description": "full-body prompt describing JOE" } ],
  "locations": [ { "name": "Diner", "description": "prompt describing the diner interior at night" } ],
  "props": [ { "name": "Letter", "description": "prompt describing the crumpled hand-written letter" } ],
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
      "directorNote": "why this shot at this beat, referencing the named directors when relevant. One line.",
      "refs": { "actors": ["JOE"], "locations": ["Diner"], "props": [] }
    }
  ]
}

Return between 4 and 40 shots depending on script length. Keep asset descriptions terse (≤ 400 characters each) so the response fits in one turn. Do NOT include the JSON in a code fence. Do NOT prefix with any prose like "Here is" or "I'll board". Start your response with the { character and end with the } character. Do not use smart quotes (“ ”) inside strings; use straight quotes ONLY.`;
}

// ---------- Media store ----------
// Persist generated images/videos to disk so browser localStorage doesn't
// have to hold megabytes of base64. Client POSTs a data URL, we hash the
// bytes, write to <MEDIA_DIR>/<sha>.<ext>, and return a stable URL that
// survives page reloads / back button navigation.
//
// Layout:
//   <MEDIA_DIR>/aa/aa11...ff.png
//   <MEDIA_DIR>/aa/aa11...ff.mp4
// The sha is content-addressed so identical bytes dedupe automatically.

const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.resolve(__dirname, '..', 'data', 'media');

try { mkdirSync(MEDIA_DIR, { recursive: true }); }
catch (err) { console.warn(`[media] cannot create MEDIA_DIR (${MEDIA_DIR}):`, err.message); }

const EXT_FOR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
};

const MIME_FOR_EXT = Object.fromEntries(
  Object.entries(EXT_FOR_MIME).map(([m, e]) => [e, m])
);
// PNG magic: 89 50 4E 47
function sniffMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && buf.slice(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  // MP4 ftyp box at offset 4
  if (buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:([^;,]+)?(?:;([^,]+))?,(.*)$/);
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const isBase64 = (m[2] || '').split(';').includes('base64');
  const payload = m[3] || '';
  const buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime, buf };
}

function storeMediaBytes(buf, mimeHint) {
  const sniffed = sniffMime(buf);
  const mime = (mimeHint && EXT_FOR_MIME[mimeHint]) ? mimeHint : sniffed;
  const ext = EXT_FOR_MIME[mime] || 'bin';
  const sha = createHash('sha256').update(buf).digest('hex');
  const dir = path.join(MEDIA_DIR, sha.slice(0, 2));
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const filepath = path.join(dir, `${sha.slice(2)}.${ext}`);
  if (!existsSync(filepath)) {
    writeFileSync(filepath, buf);
  }
  return { sha, ext, mime, bytes: buf.length, filepath };
}

app.post('/api/media/put', async (req, res) => {
  try {
    const { dataUrl, mime: mimeHint } = req.body || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'dataUrl (data: URL string) required' });
    }
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return res.status(400).json({ error: 'invalid data URL' });
    const rec = storeMediaBytes(parsed.buf, mimeHint || parsed.mime);
    const id = `${rec.sha}.${rec.ext}`;
    res.json({
      ok: true,
      id,
      url: `/api/media/${id}`,
      mime: rec.mime,
      bytes: rec.bytes,
    });
  } catch (err) {
    console.error('[media/put] error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/health', (_req, res) => {
  res.json({ ok: true, dir: MEDIA_DIR, exists: existsSync(MEDIA_DIR) });
});

app.get('/api/media/:id', (req, res) => {
  const id = String(req.params.id || '');
  // Accept plain "<sha>.<ext>" — reject anything else to prevent path traversal.
  if (!/^[a-f0-9]{64}\.[a-z0-9]{1,6}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid media id' });
  }
  const [sha, ext] = id.split('.');
  const filepath = path.join(MEDIA_DIR, sha.slice(0, 2), `${sha.slice(2)}.${ext}`);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'not found' });
  const mime = MIME_FOR_EXT[ext] || 'application/octet-stream';
  try {
    const stat = statSync(filepath);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(filepath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
      console.error('[shot-list] no JSON block found in Ronan reply. First 400 chars:', text.slice(0, 400));
      console.error('[shot-list] last 400 chars:', text.slice(-400));
      return res.status(502).json({ error: 'Ronan did not return valid JSON', raw: text.slice(0, 4000) });
    }
    const { value: parsed, repair } = tryParseJsonWithRepairs(cleaned);
    if (!parsed) {
      console.error('[shot-list] JSON parse failed even after repairs. Length:', cleaned.length);
      console.error('[shot-list] first 400 chars:', cleaned.slice(0, 400));
      console.error('[shot-list] last 400 chars:', cleaned.slice(-400));
      return res.status(502).json({ error: 'Ronan did not return valid JSON', raw: cleaned.slice(0, 4000) });
    }
    if (repair) console.warn(`[shot-list] JSON repaired via: ${repair}`);
    res.json({ ok: true, sessionId: nextSessionId, shotList: parsed, repair: repair || undefined });
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

// ---------- PDF / text import (Boardfish 6) ----------
//
// The AI Director drawer accepts a pasted script OR an uploaded file. This
// endpoint accepts a multipart PDF (or a plain-text file) and returns the
// extracted text as a string so the browser can drop it into the script
// textarea. We use pdfjs-dist's legacy build so it runs in Node without a
// browser DOM.

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  // 25 MB is enough for a 100-page feature-length screenplay PDF.
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post('/api/import/pdf', pdfUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded (expected multipart field "file")' });
  const filename = req.file.originalname || 'upload';
  const mime = req.file.mimetype || '';
  const buf = req.file.buffer;
  try {
    // Plain text passthrough for .txt / .fdx / .fountain
    if (mime.startsWith('text/') || /\.(txt|fdx|fountain|md)$/i.test(filename)) {
      const text = buf.toString('utf8');
      return res.json({ ok: true, filename, text, pages: 1, kind: 'text' });
    }
    // Everything else is treated as PDF. pdfjs-dist loads and extracts text.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // pdfjs-dist worker: use fake worker in Node (no browser worker thread).
    // See https://mozilla.github.io/pdf.js/getting_started/#nodejs.
    // In legacy build the pdfjs.GlobalWorkerOptions.workerSrc read is
    // guarded; setting `disableWorker` or leaving it unset is fine because
    // getDocument() with the raw buffer runs the parse on the main thread.
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true });
    const doc = await loadingTask.promise;
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Group runs by their vertical position to reconstruct line breaks.
      // pdfjs items expose transform[5] = y-origin; when it changes we insert
      // a newline. Same-line runs get joined with a single space.
      let lastY = null;
      let line = '';
      const lines = [];
      for (const item of tc.items) {
        const s = ('str' in item) ? item.str : '';
        const y = ('transform' in item && Array.isArray(item.transform)) ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) {
          lines.push(line.trimEnd());
          line = '';
        }
        line += s;
        if ('hasEOL' in item && item.hasEOL) {
          lines.push(line.trimEnd());
          line = '';
        }
        lastY = y;
      }
      if (line.trim()) lines.push(line.trimEnd());
      parts.push(lines.join('\n'));
    }
    const text = parts.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    res.json({ ok: true, filename, text, pages: doc.numPages, kind: 'pdf' });
  } catch (err) {
    console.error('[import-pdf] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- LLM (text / image-describe / video-describe) endpoints ----------
//
// Backing store for the Boardfish 6 node editor's Prompt Enhancer, Run Any
// LLM, Image Describer, and Video Describer nodes. All shell out to the
// OpenClaw CLI (`openclaw capability model|image|video ...`) so provider
// credentials stay server-side.
//
// Model catalog is cached in-process. Restart the proxy to pick up new
// models added via `openclaw configure`.

// LLM_DEFAULT_MODEL: optional env override for the "Server default" option in
// each Inspector's model dropdown. Falls back to a reasonable Anthropic/OpenAI
// pick from the catalog when unset.
const LLM_DEFAULT_MODEL = process.env.LLM_DEFAULT_MODEL || 'openai/gpt-5.4';

// Curated allow-lists of models exposed to the Boardfish node UI. Matt's
// rules (2026-07-16):
//   • Prompt Enhancer / Run Any LLM — text quality models only:
//     Anthropic Sonnet + OpenAI ChatGPT (+ agents appended later).
//   • Image Describer / Video Describer — vision quality models only:
//     Anthropic Opus + OpenAI ChatGPT (no agents; agent CLI can't take
//     image inputs yet).
// Default in both pickers is OpenAI ChatGPT (gpt-5.4).
const LLM_ALLOWLIST_TEXT = new Set([
  'anthropic/claude-sonnet-4-6',
  'openai/gpt-5.4',
]);
const LLM_ALLOWLIST_VISION = new Set([
  'anthropic/claude-opus-4-7',
  'openai/gpt-5.4',
]);
// Union so /api/llm/models with no filter returns everything a client
// might legitimately pick.
const LLM_ALLOWLIST_ALL = new Set([...LLM_ALLOWLIST_TEXT, ...LLM_ALLOWLIST_VISION]);
// tmp scratch dir for describe-image / describe-video file writes. We write
// the incoming data URL to a real file because `openclaw capability image
// describe` takes --file <path>, not stdin.
const LLM_TMP_DIR = path.join(__dirname, 'tmp-llm');
try { mkdirSync(LLM_TMP_DIR, { recursive: true }); } catch { /* ignore */ }

let _modelsCache = null;
let _modelsCacheAt = 0;
const MODELS_CACHE_MS = 5 * 60_000;

// Synthetic "agent" entries the model picker exposes alongside raw catalog
// models. Each maps to an OpenClaw agent id and gets routed through
// `openclaw agent --agent <id>` in /api/llm/run instead of
// `capability model run`. Handy for Prompt Enhancer / Run Any LLM when Matt
// wants a persona (Ronan the director, CarlBot the deep researcher) rather
// than a raw model. Ids are prefixed `agent/` so the executor can detect
// them and swap CLI paths.
const AGENT_MODEL_ENTRIES = [
  {
    id: 'agent/ronan',
    name: 'RonanBot 🔍 (director / writer)',
    provider: 'openclaw-agent',
    input: ['text'],
    reasoning: false,
  },
  {
    id: 'agent/carlbot',
    name: 'CarlBot (deep research)',
    provider: 'openclaw-agent',
    input: ['text'],
    reasoning: false,
  },
];

async function fetchLlmModels() {
  const now = Date.now();
  if (_modelsCache && (now - _modelsCacheAt) < MODELS_CACHE_MS) return _modelsCache;
  const { stdout } = await runOpenclaw(['capability', 'model', 'list', '--json']);
  // The CLI wraps its JSON output with a preamble/wallpaper block; strip
  // everything before the first '[' and after the matching ']'.
  const first = stdout.indexOf('[');
  const last = stdout.lastIndexOf(']');
  if (first < 0 || last < 0) throw new Error('capability model list --json returned no JSON array');
  const arr = JSON.parse(stdout.slice(first, last + 1));
  // Pick a sensible default: env override wins; else fall back to the
  // curated OpenAI ChatGPT pick (Matt's 2026-07-16 preference).
  let defaultModelId = LLM_DEFAULT_MODEL;
  if (!defaultModelId) {
    const preferred = ['gpt-5.4', 'claude-sonnet-4-6', 'claude-opus-4-7'];
    for (const p of preferred) {
      if (arr.find((m) => m.id === p)) { defaultModelId = p; break; }
    }
    if (!defaultModelId && arr.length > 0) defaultModelId = arr[0].id;
  }
  _modelsCache = { models: arr, defaultModelId };
  _modelsCacheAt = now;
  return _modelsCache;
}

app.get('/api/llm/models', async (req, res) => {
  try {
    const filter = String(req.query.filter || '').toLowerCase();
    const allow =
      filter === 'vision-only' ? LLM_ALLOWLIST_VISION
      : filter === 'text-only' ? LLM_ALLOWLIST_TEXT
      : LLM_ALLOWLIST_ALL;
    const { models, defaultModelId } = await fetchLlmModels();
    // Trim to the fields the browser needs. Full catalog entries carry a lot
    // of provider metadata (api, compat.*) that the client doesn't touch.
    // Emit `id` as provider-qualified (`anthropic/claude-opus-4-7`) because
    // bare ids like `claude-opus-4-7` will otherwise route to the first
    // provider that happens to list the model — which in this workspace is
    // ollama and 404s.
    const trimmed = models.map((m) => {
      const provider = m.provider || 'unknown';
      const qualified = provider !== 'unknown' && m.id ? `${provider}/${m.id}` : (m.id || '');
      return {
        id: qualified,
        name: m.name || m.id,
        provider,
        contextWindow: m.contextWindow,
        input: Array.isArray(m.input) ? m.input : ['text'],
        reasoning: !!m.reasoning,
      };
    });
    // Filter to Matt's curated allow-list for the requested picker kind.
    const filtered = trimmed.filter((m) => allow.has(m.id));
    // Nicer display names to match Matt's phrasing — easier to scan than
    // "Claude Sonnet 4.6" / "Claude Opus 4.7" etc.
    for (const m of filtered) {
      if (m.id === 'anthropic/claude-sonnet-4-6') m.name = 'Anthropic Sonnet';
      if (m.id === 'anthropic/claude-opus-4-7') m.name = 'Anthropic Opus';
      if (m.id === 'openai/gpt-5.4') m.name = 'OpenAI ChatGPT';
    }
    // Append the synthetic OpenClaw-agent entries (Ronan, CarlBot) to
    // TEXT-only pickers. Vision pickers exclude them because the agent
    // CLI can't accept image inputs yet.
    if (filter !== 'vision-only') {
      for (const a of AGENT_MODEL_ENTRIES) filtered.push({ ...a });
    }
    // Reassign so the response payload uses the filtered set.
    trimmed.length = 0;
    for (const m of filtered) trimmed.push(m);
    // Qualify the default too so the client shows/sends the same shape.
    let defaultQualified = defaultModelId;
    if (defaultModelId && !defaultModelId.includes('/')) {
      const found = models.find((m) => m.id === defaultModelId);
      if (found?.provider) defaultQualified = `${found.provider}/${defaultModelId}`;
    }
    res.json({ ok: true, models: trimmed, defaultModelId: defaultQualified });
  } catch (err) {
    console.error('[llm/models] error', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Decode a `data:<mime>;base64,<b64>` URL to a Buffer + inferred file ext.
function dataUrlToBuffer(url) {
  if (typeof url !== 'string') throw new Error('data URL is not a string');
  const m = url.match(/^data:([^;,]+)(?:;base64)?,(.+)$/);
  if (!m) throw new Error('data URL malformed');
  const mime = m[1];
  const isBase64 = url.includes(';base64,');
  const payload = m[2];
  const buf = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  const ext = mimeToExt(mime);
  return { buf, mime, ext };
}

function mimeToExt(mime) {
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  };
  return map[mime] || 'bin';
}

// Write a data URL to a temp file and return its absolute path. Caller owns
// cleanup (best-effort; we also sweep old files > 1h at boot below).
function dataUrlToTempFile(url, prefix) {
  const { buf, ext } = dataUrlToBuffer(url);
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const filename = `${prefix}-${hash}.${ext}`;
  const p = path.join(LLM_TMP_DIR, filename);
  writeFileSync(p, buf);
  return p;
}

// Sweep any tmp files older than 1h at boot so LLM_TMP_DIR doesn't grow
// forever. Cheap: called once, non-recursive, ignores errors.
try {
  const dirents = readdirSync(LLM_TMP_DIR);
  const cutoff = Date.now() - 60 * 60_000;
  for (const name of dirents) {
    const p = path.join(LLM_TMP_DIR, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch { /* ignore */ }
  }
} catch { /* directory not readable — ignore */ }

async function resolveModelId(requested, filterKind = 'text-only') {
  // Pick the right allow-list for the picker context (text vs vision).
  const allow = filterKind === 'vision-only' ? LLM_ALLOWLIST_VISION : LLM_ALLOWLIST_TEXT;
  // Agent entries are always valid (they route through the agent CLI, not
  // the model CLI, so they don't need to be in the catalog).
  const isAgent = typeof requested === 'string' && requested.startsWith('agent/');
  // If the client sent something in the allow-list (or an agent), honor it.
  if (isAgent) return requested;
  if (requested && allow.has(requested)) return requested;
  // Anything else — empty string, stale modelId from a saved project
  // (e.g. github-copilot/*, bare claude-opus-4-7, gpt-5.4-mini) — snap
  // to the server default so the run doesn't 500 on a ghost model.
  if (requested) {
    console.warn(`[llm/run] requested model "${requested}" not in ${filterKind} allow-list — falling back to default.`);
  }
  try {
    const { defaultModelId } = await fetchLlmModels();
    return defaultModelId || '';
  } catch {
    return '';
  }
}

// Build the merged prompt for LLM calls: instructions (if any) + upstream
// prompt. Instructions live as a preamble because `openclaw capability
// model run` doesn't split system vs. user prompts on the CLI.
function buildLlmPrompt(instructions, prompt) {
  const instr = (instructions || '').trim();
  const usr = (prompt || '').trim();
  if (instr && usr) return `${instr}\n\n---\n\n${usr}`;
  return instr || usr;
}

// Extract the plain-text reply from `openclaw capability model run --json`.
// The CLI wraps its JSON with a preamble/wallpaper block; find the first {}
// object.
function extractCliJson(stdout) {
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first < 0 || last < 0) return null;
  try { return JSON.parse(stdout.slice(first, last + 1)); }
  catch { return null; }
}

function extractLlmText(parsed) {
  if (!parsed) return '';
  // capability model run --json (current shape): { outputs: [{ text, mediaUrl }] }
  if (Array.isArray(parsed.outputs)) {
    for (const o of parsed.outputs) {
      if (o && typeof o.text === 'string' && o.text.trim() !== '') return o.text;
    }
  }
  // Legacy shape: { text: "..." }
  if (typeof parsed.text === 'string') return parsed.text;
  // Legacy Ronan-style shape: { result: { payloads: [{ text }] } }
  const p = parsed?.result?.payloads;
  if (Array.isArray(p)) {
    for (const pl of p) {
      if (pl && typeof pl.text === 'string') return pl.text;
    }
  }
  // capability image/video describe → { description } or { summary }
  if (typeof parsed.description === 'string') return parsed.description;
  if (typeof parsed.summary === 'string') return parsed.summary;
  return '';
}

app.post('/api/llm/run', async (req, res) => {
  const { prompt, modelId, instructions, imageDataUrl } = req.body || {};
  console.log(`[llm/run] request modelId=${JSON.stringify(modelId)} promptLen=${(prompt||'').length} hasImage=${!!imageDataUrl}`);
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }
  let tmpFile = null;
  try {
    const resolvedModel = await resolveModelId(modelId);
    console.log(`[llm/run] resolvedModel=${JSON.stringify(resolvedModel)} (from requested=${JSON.stringify(modelId)})`);
    // Agent route: `agent/<id>` synthetic entries shell to
    // `openclaw agent --agent <id>` instead of `capability model run`. The
    // agent picks its own model per its openclaw.json config. Image inputs
    // aren't currently wired through the agent CLI, so if one arrives with
    // an agent selection we degrade gracefully to text-only.
    if (typeof resolvedModel === 'string' && resolvedModel.startsWith('agent/')) {
      const agentId = resolvedModel.slice('agent/'.length);
      const merged = buildLlmPrompt(instructions, prompt);
      const args = ['agent', '--agent', agentId, '--json', '--timeout', '180', '--message', merged];
      const { stdout } = await runOpenclaw(args);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = extractCliJson(stdout); }
      // Agent CLI returns { result: { payloads: [{ text }] } }; fall back to
      // the shared extractor for anything odd.
      const text = parsed?.result?.payloads?.[0]?.text ?? extractLlmText(parsed);
      if (!text) {
        console.error(`[llm/run agent=${agentId}] no text. First 400:`, stdout.slice(0, 400));
        return res.status(502).json({ error: `Agent ${agentId} returned no text`, raw: stdout.slice(0, 2000) });
      }
      return res.json({ ok: true, text: String(text).trim(), modelId: resolvedModel });
    }
    const args = ['capability', 'model', 'run', '--json'];
    if (resolvedModel) args.push('--model', resolvedModel);
    const merged = buildLlmPrompt(instructions, prompt);
    args.push('--prompt', merged);
    if (imageDataUrl && typeof imageDataUrl === 'string') {
      tmpFile = dataUrlToTempFile(imageDataUrl, 'llm-img');
      args.push('--file', tmpFile);
    }
    const { stdout } = await runOpenclaw(args);
    const parsed = extractCliJson(stdout);
    const text = extractLlmText(parsed);
    if (!text) {
      console.error('[llm/run] no text in reply. First 400:', stdout.slice(0, 400));
      return res.status(502).json({ error: 'LLM returned no text', raw: stdout.slice(0, 2000) });
    }
    res.json({ ok: true, text: text.trim(), modelId: resolvedModel });
  } catch (err) {
    console.error('[llm/run] error', err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    // Best-effort cleanup. If the sweep at boot missed anything, delete here.
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* ignore */ } }
  }
});

app.post('/api/llm/describe-image', async (req, res) => {
  const { imageDataUrl, modelId, instructions } = req.body || {};
  if (!imageDataUrl || typeof imageDataUrl !== 'string') {
    return res.status(400).json({ error: 'imageDataUrl (string) required' });
  }
  let tmpFile = null;
  try {
    tmpFile = dataUrlToTempFile(imageDataUrl, 'describe-img');
    const resolvedModel = await resolveModelId(modelId, 'vision-only');
    // Route through `capability model run --file <img>` rather than
    // `capability image describe`. Reasons:
    //   1. `image describe` has a Claude PNG bug (sends the file with the
    //      wrong media type — "specified image/jpeg but appears image/png").
    //      `model run --file` uses a different code path that infers the
    //      real MIME type and works for both PNG and JPEG.
    //   2. Every vision model in the catalog can be used uniformly, and
    //      the user's Instructions field is passed as the prompt.
    const args = ['capability', 'model', 'run', '--json', '--file', tmpFile];
    if (resolvedModel) args.push('--model', resolvedModel);
    const promptText = (instructions && instructions.trim()) || 'Describe this image in detail as a text-to-image prompt.';
    args.push('--prompt', promptText);
    const { stdout } = await runOpenclaw(args);
    const parsed = extractCliJson(stdout);
    const text = extractLlmText(parsed);
    if (!text) {
      console.error('[llm/describe-image] no text. First 400:', stdout.slice(0, 400));
      return res.status(502).json({ error: 'Describe-image returned no text', raw: stdout.slice(0, 2000) });
    }
    res.json({ ok: true, text: text.trim(), modelId: resolvedModel });
  } catch (err) {
    console.error('[llm/describe-image] error', err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* ignore */ } }
  }
});

// Turn a video file into a single 2x3 mosaic PNG of 6 evenly-spaced
// keyframes so any vision LLM can "describe" it without needing native
// video-input support. Uses ffmpeg (already installed on the mini).
async function videoToKeyframeMosaic(videoPath, mosaicPath) {
  // First: probe duration so we can pick sane sample times.
  const probe = await new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.on('close', () => resolve(parseFloat(out.trim()) || 0));
    child.on('error', () => resolve(0));
  });
  const duration = probe > 0 ? probe : 10;
  // 6 frames, evenly spaced, skipping the first/last 5% to avoid black.
  const start = duration * 0.05;
  const end = duration * 0.95;
  const N = 6;
  const times = [];
  for (let i = 0; i < N; i++) {
    const t = start + ((end - start) * i) / (N - 1);
    times.push(t.toFixed(3));
  }
  const args = [];
  for (const t of times) {
    args.push('-ss', t, '-i', videoPath);
  }
  const scale = times.map((_, i) => `[${i}:v]scale=640:-2:force_original_aspect_ratio=decrease,setsar=1[v${i}]`).join(';');
  const row1 = '[v0][v1][v2]hstack=inputs=3[r1]';
  const row2 = '[v3][v4][v5]hstack=inputs=3[r2]';
  const stack = '[r1][r2]vstack=inputs=2[out]';
  const filter = `${scale};${row1};${row2};${stack}`;
  args.push('-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-y', mosaicPath);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mosaic exited ${code}: ${stderr.slice(-400)}`));
    });
  });
  return { duration, frameCount: N, times };
}

app.post('/api/llm/describe-video', async (req, res) => {
  const { videoDataUrl, modelId, instructions } = req.body || {};
  if (!videoDataUrl || typeof videoDataUrl !== 'string') {
    return res.status(400).json({ error: 'videoDataUrl (string) required' });
  }
  let tmpFile = null;
  let mosaicFile = null;
  try {
    tmpFile = dataUrlToTempFile(videoDataUrl, 'describe-vid');
    // Extract 6 keyframes into a single mosaic PNG so we can route the
    // "describe video" call through the same vision-LLM path as image
    // describe. Previously used `capability video describe` which
    // internally routes to Google Gemini regardless of --model — and
    // Google's prepay account is out of credits. Mosaic strategy lets any
    // vision-capable model handle video (OpenAI, Anthropic, Mistral).
    mosaicFile = path.join(LLM_TMP_DIR, `vid-mosaic-${createHash('sha1').update(tmpFile).digest('hex').slice(0,12)}.png`);
    const mosaicMeta = await videoToKeyframeMosaic(tmpFile, mosaicFile);
    const resolvedModel = await resolveModelId(modelId, 'vision-only');
    const args = ['capability', 'model', 'run', '--json', '--file', mosaicFile];
    if (resolvedModel) args.push('--model', resolvedModel);
    const baseInstr = (instructions && instructions.trim())
      || 'Describe the action in this video in one detailed paragraph. Focus on what happens, camera movement, subjects, and setting. Return only the description — no preamble.';
    const promptText = `The following image is a 3x2 mosaic of ${mosaicMeta.frameCount} keyframes sampled evenly from a ${mosaicMeta.duration.toFixed(1)}-second video. Reading left-to-right, top-to-bottom, the frames represent the video in chronological order.\n\n${baseInstr}`;
    args.push('--prompt', promptText);
    const { stdout } = await runOpenclaw(args, { timeout: 5 * 60_000 });
    const parsed = extractCliJson(stdout);
    const text = extractLlmText(parsed);
    if (!text) {
      console.error('[llm/describe-video] no text. First 400:', stdout.slice(0, 400));
      return res.status(502).json({ error: 'Describe-video returned no text', raw: stdout.slice(0, 2000) });
    }
    res.json({ ok: true, text: text.trim(), modelId: resolvedModel });
  } catch (err) {
    console.error('[llm/describe-video] error', err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    if (tmpFile) { try { unlinkSync(tmpFile); } catch { /* ignore */ } }
    if (mosaicFile) { try { unlinkSync(mosaicFile); } catch { /* ignore */ } }
  }
});

// ---------- Editing tools endpoint ----------
//
// One endpoint handles all 5 editing tools (crop, resize, blur, invert,
// extract-frame). Shells to ffmpeg for both images and videos so we get
// consistent behavior across media kinds without pulling in a Python
// image lib. All operations are deterministic (no API cost).
//
// POST /api/edit/apply { tool, data, mediaKind, dataUrl }
//   → { ok, dataUrl, mediaKind, mime }

const EDIT_TMP_DIR = path.join(__dirname, 'tmp-edit');
try { mkdirSync(EDIT_TMP_DIR, { recursive: true }); } catch { /* ignore */ }

// Sweep old files >1h at boot so tmp-edit doesn't grow forever.
try {
  const dirents = readdirSync(EDIT_TMP_DIR);
  const cutoff = Date.now() - 60 * 60_000;
  for (const name of dirents) {
    const p = path.join(EDIT_TMP_DIR, name);
    try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* ignore */ }
  }
} catch { /* ignore */ }

// Run ffmpeg with the given args. Rejects if exit code != 0. Stderr is
// preserved for error messages (ffmpeg puts real diagnostic info on stderr).
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// ffprobe for video dimensions / duration. Returns { width, height, duration, nb_frames? }.
function runFfprobe(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames,r_frame_rate:format=duration',
      '-of', 'json',
      inputPath,
    ];
    const child = spawn('ffprobe', args);
    let out = '';
    let stderr = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr}`));
      try {
        const parsed = JSON.parse(out);
        const s = parsed.streams?.[0] || {};
        const width = Number(s.width) || 0;
        const height = Number(s.height) || 0;
        const duration = Number(parsed.format?.duration) || 0;
        const nbFrames = Number(s.nb_frames) || 0;
        // r_frame_rate is e.g. "30000/1001" — evaluate.
        let fps = 0;
        if (typeof s.r_frame_rate === 'string' && s.r_frame_rate.includes('/')) {
          const [num, den] = s.r_frame_rate.split('/').map(Number);
          if (den > 0) fps = num / den;
        }
        resolve({ width, height, duration, nbFrames, fps });
      } catch (e) { reject(e); }
    });
  });
}

// Aspect string "W:H" → { w, h }. Returns null for 'custom' or malformed.
function parseAspect(aspect) {
  if (!aspect || aspect === 'custom') return null;
  const m = String(aspect).match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const w = Number(m[1]); const h = Number(m[2]);
  if (w <= 0 || h <= 0) return null;
  return { w, h };
}

// Largest-fitting crop rectangle inside (srcW x srcH) matching aspect w:h.
// Returns { w, h } of the crop — caller decides the (x, y) offset.
function fitCrop(srcW, srcH, aspectW, aspectH) {
  const srcAR = srcW / srcH;
  const dstAR = aspectW / aspectH;
  if (srcAR > dstAR) {
    // Source is wider — crop horizontally.
    const h = srcH;
    const w = Math.round(h * dstAR);
    return { w, h };
  }
  const w = srcW;
  const h = Math.round(w / dstAR);
  return { w, h };
}

// Compute crop x/y from anchor keyword.
function anchorOffset(srcW, srcH, cropW, cropH, anchor) {
  let x = Math.round((srcW - cropW) / 2);
  let y = Math.round((srcH - cropH) / 2);
  const a = String(anchor || 'center');
  if (a.includes('left')) x = 0;
  if (a.includes('right')) x = srcW - cropW;
  if (a.includes('top')) y = 0;
  if (a.includes('bottom')) y = srcH - cropH;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

// Build the ffmpeg -vf filter chain for a given editing tool.
function buildFilter(tool, data, probe) {
  const srcW = probe.width || 0;
  const srcH = probe.height || 0;
  switch (tool) {
    case 'crop': {
      const aspect = String(data.aspect ?? '16:9');
      const anchor = String(data.anchor ?? 'center');
      const zoom = Math.max(0.2, Math.min(1, Number(data.zoom ?? 1)));
      let cropW, cropH;
      if (aspect === 'custom') {
        cropW = Math.max(1, Math.round(Number(data.width) || srcW));
        cropH = Math.max(1, Math.round(Number(data.height) || srcH));
        cropW = Math.min(cropW, srcW);
        cropH = Math.min(cropH, srcH);
      } else {
        const ar = parseAspect(aspect);
        if (!ar) throw new Error(`Invalid crop aspect "${aspect}"`);
        const fit = fitCrop(srcW, srcH, ar.w, ar.h);
        // Apply zoom (0.2–1.0) as a scale-down factor from the fitted crop.
        // 1.0 = full fitted crop; 0.5 = half-size crop, centered by anchor.
        cropW = Math.max(1, Math.round(fit.w * zoom));
        cropH = Math.max(1, Math.round(fit.h * zoom));
      }
      // Ffmpeg's crop filter refuses even/odd width/height mismatches on
      // some codecs. Round to even values to be safe.
      if (cropW % 2 !== 0) cropW -= 1;
      if (cropH % 2 !== 0) cropH -= 1;
      const { x, y } = anchorOffset(srcW, srcH, cropW, cropH, anchor);
      return `crop=${cropW}:${cropH}:${x}:${y}`;
    }
    case 'resize': {
      const useCustom = Boolean(data.useCustomDims);
      const scale = Math.max(0.05, Math.min(4, Number(data.scale ?? 1)));
      let w, h;
      if (useCustom) {
        w = Math.max(1, Math.round(Number(data.width) || srcW));
        h = Math.max(1, Math.round(Number(data.height) || srcH));
      } else {
        // Scale mode preserves aspect ratio automatically.
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
      }
      // Round to even for codec compatibility.
      if (w % 2 !== 0) w -= 1;
      if (h % 2 !== 0) h -= 1;
      const fit = String(data.fit ?? 'stretch');
      if (!useCustom || fit === 'stretch') return `scale=${w}:${h}`;
      if (fit === 'fit') {
        // Letterbox: scale-to-fit then pad to exact size.
        return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
      }
      // fill: scale-to-cover then center-crop.
      return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    }
    case 'blur': {
      const radius = Math.max(0, Number(data.radius) || 0);
      const kind = String(data.kind ?? 'gaussian');
      if (kind === 'box') {
        // boxblur: luma_radius:luma_power. Power 1 is a single pass.
        const r = Math.round(radius);
        return `boxblur=${r}:1`;
      }
      // gblur sigma is the effective radius parameter.
      return `gblur=sigma=${radius.toFixed(2)}`;
    }
    case 'invert': {
      const alphaOnly = Boolean(data.alphaOnly);
      // For alpha-only inversion, split into alpha + rgb, invert alpha, then
      // merge back. `negate=alpha=1` inverts alpha only when set to 1.
      if (alphaOnly) return `negate=alpha=1`;
      return `negate`;
    }
    case 'extract-frame': {
      // Handled specially (single -ss + -frames:v 1).
      return null;
    }
    default:
      throw new Error(`Unknown edit tool: ${tool}`);
  }
}

app.post('/api/edit/apply', async (req, res) => {
  const { tool, data, mediaKind, dataUrl } = req.body || {};
  if (!tool || typeof tool !== 'string') {
    return res.status(400).json({ error: 'tool (string) required' });
  }
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json({ error: 'dataUrl (string) required' });
  }
  if (!['crop', 'resize', 'blur', 'invert', 'extract-frame'].includes(tool)) {
    return res.status(400).json({ error: `unsupported tool: ${tool}` });
  }
  const kind = mediaKind === 'video' ? 'video' : 'image';
  if (tool === 'extract-frame' && kind !== 'video') {
    return res.status(400).json({ error: 'extract-frame requires a video input' });
  }

  let inFile = null; let outFile = null;
  try {
    // Decode incoming data URL to a temp file. dataUrlToBuffer / mimeToExt
    // are the same helpers used by the LLM endpoints.
    const { buf, ext } = dataUrlToBuffer(dataUrl);
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    inFile = path.join(EDIT_TMP_DIR, `edit-in-${hash}.${ext}`);
    writeFileSync(inFile, buf);

    // Probe the input for dimensions (needed for crop math + resize defaults).
    const probe = await runFfprobe(inFile);
    if (!probe.width || !probe.height) {
      throw new Error('Could not read input dimensions.');
    }

    // Special case: extract-frame emits a single PNG.
    if (tool === 'extract-frame') {
      const pickBy = String(data?.pickBy ?? 'time');
      let timeSec = 0;
      if (pickBy === 'frame') {
        const f = Math.max(0, Math.round(Number(data?.frame) || 0));
        const fps = probe.fps || 30;
        timeSec = f / fps;
      } else {
        timeSec = Math.max(0, Number(data?.time) || 0);
      }
      // Clamp to just under duration so we don't seek past the end.
      if (probe.duration > 0) timeSec = Math.min(timeSec, Math.max(0, probe.duration - 0.05));
      outFile = path.join(EDIT_TMP_DIR, `edit-out-${hash}.png`);
      await runFfmpeg([
        '-ss', String(timeSec),
        '-i', inFile,
        '-frames:v', '1',
        '-y', outFile,
      ]);
      const outBuf = readFileSync(outFile);
      const outUrl = `data:image/png;base64,${outBuf.toString('base64')}`;
      return res.json({ ok: true, dataUrl: outUrl, mediaKind: 'image', mime: 'image/png' });
    }

    // Standard filter path: build -vf, encode result.
    const filter = buildFilter(tool, data || {}, probe);
    if (!filter) throw new Error(`No filter for ${tool}`);

    if (kind === 'image') {
      outFile = path.join(EDIT_TMP_DIR, `edit-out-${hash}.png`);
      await runFfmpeg([
        '-i', inFile,
        '-vf', filter,
        '-frames:v', '1',
        '-y', outFile,
      ]);
      const outBuf = readFileSync(outFile);
      const outUrl = `data:image/png;base64,${outBuf.toString('base64')}`;
      return res.json({ ok: true, dataUrl: outUrl, mediaKind: 'image', mime: 'image/png' });
    }

    // Video path — re-encode to H.264 mp4. Copy audio through (some ffmpeg
    // builds fail if we point -c:a copy at a stream that doesn't exist, so
    // we conditionally check the probe... but for simplicity we just pass
    // -c:a aac and let ffmpeg drop it when no audio is present).
    outFile = path.join(EDIT_TMP_DIR, `edit-out-${hash}.mp4`);
    await runFfmpeg([
      '-i', inFile,
      '-vf', filter,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', outFile,
    ]);
    const outBuf = readFileSync(outFile);
    const outUrl = `data:video/mp4;base64,${outBuf.toString('base64')}`;
    return res.json({ ok: true, dataUrl: outUrl, mediaKind: 'video', mime: 'video/mp4' });
  } catch (err) {
    console.error(`[edit/${tool}] error`, err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    if (inFile) { try { unlinkSync(inFile); } catch { /* ignore */ } }
    if (outFile) { try { unlinkSync(outFile); } catch { /* ignore */ } }
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

// If JSON.parse fails, try common repairs. Handles the most frequent failure
// modes when large-model output is either truncated or contains a few stray
// unescaped characters.
function tryParseJsonWithRepairs(cleaned) {
  // Attempt 0: as-is.
  try { return { value: JSON.parse(cleaned), repair: null }; } catch { /* try repairs */ }

  // Repair 1: strip trailing commas (", }" or ", ]").
  const noTrailing = cleaned
    .replace(/,(\s*[}\]])/g, '$1');
  try { return { value: JSON.parse(noTrailing), repair: 'trailing-comma-strip' }; } catch { /* keep trying */ }

  // Repair 2: replace common smart quotes with ASCII equivalents. Ronan
  // occasionally uses “”‘’ inside description strings.
  const noSmart = noTrailing
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  try { return { value: JSON.parse(noSmart), repair: 'smart-quote-normalize' }; } catch { /* keep trying */ }

  // Repair 3: truncation — output ended mid-string. Walk back from the end to
  // find the last COMPLETE shot / asset entry and close the JSON there. This
  // preserves whatever Ronan produced before hitting max_tokens.
  const truncated = closeTruncatedJson(noSmart);
  if (truncated && truncated !== noSmart) {
    try { return { value: JSON.parse(truncated), repair: 'truncation-close' }; } catch { /* fall through */ }
  }

  return { value: null, repair: null };
}

// Given a possibly-truncated JSON string that starts with '{', find the
// deepest recoverable prefix and close whatever brackets are still open.
// Strategy: walk the string forward, tracking bracket depth + string state.
// For every position where we finish a value cleanly (i.e. just closed a }
// or ] at depth >= 1), remember the position and the current stack. When we
// reach the truncated end, rewind to the last remembered "safe" position
// that's INSIDE the same containing array (so we drop the partial trailing
// item), then append the closes still owed.
function closeTruncatedJson(s) {
  if (!s || s[0] !== '{') return null;
  let inString = false;
  let escape = false;
  const stack = [];
  // Remember the last position where we cleanly closed a value AND the stack
  // state at that moment (deep-copied so later mutations don't overwrite it).
  let safeEnd = -1;
  let safeStack = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); }
    else if (c === '}' || c === ']') {
      stack.pop();
      // Snapshot after a clean close. safeStack captures what's still open.
      safeEnd = i;
      safeStack = stack.slice();
    }
  }
  // Cleanly balanced end → nothing to repair.
  if (stack.length === 0 && !inString) return s;
  // No clean close ever happened → unrecoverable.
  if (safeEnd < 0 || !safeStack) return null;
  // Drop the trailing partial item AND any comma that separated it.
  let head = s.slice(0, safeEnd + 1);
  // Note: we do NOT need to worry about a trailing ',' between the last
  // safe close and the truncation point — the slice up to safeEnd+1 ends
  // exactly on the closing char, so ', {partial' is already gone.
  const closes = safeStack.map((b) => (b === '{' ? '}' : ']')).reverse().join('');
  return head + closes;
}

export function _testJsonRepair(s) {
  return tryParseJsonWithRepairs(s);
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
  console.log(`  POST /api/import/pdf        multipart 'file' → { text, pages, kind }`);
  console.log(`  GET  /api/llm/models        → list LLM models from OpenClaw catalog`);
  console.log(`  POST /api/llm/run           { prompt, modelId?, instructions?, imageDataUrl? }`);
  console.log(`  POST /api/llm/describe-image { imageDataUrl, modelId?, instructions? }`);
  console.log(`  POST /api/llm/describe-video { videoDataUrl, modelId?, instructions? }`);
  console.log(`  POST /api/edit/apply        { tool, data, mediaKind, dataUrl } — crop/resize/blur/invert/extract-frame`);
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
