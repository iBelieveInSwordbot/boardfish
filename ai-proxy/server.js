// Boardfish 4 AI proxy.
// Bridges the Vite dev server / built app to OpenClaw:
//   POST /api/ronan/shot-list   → Ronan turns a script into a structured shot list
//   POST /api/ronan/refine      → Ronan rewrites a single shot with fresh direction
//   POST /api/image/generate    → Nano Banana Pro renders one panel image (returns data URL)
//
// Everything runs local. No auth (bind to 127.0.0.1 only). Kill with Ctrl-C.

import express from 'express';
import { spawn } from 'node:child_process';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT || 5174);
const OPENCLAW = process.env.OPENCLAW_BIN || 'openclaw';

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
const DIRECTOR_PREAMBLE = `You are Ronan, working as a great film director. Think in the tradition of Scorsese (bold camera moves, kinetic energy, character close-ups that reveal soul), Tarantino (long dialogue takes broken by sudden violence, low-angle hero shots, chapter-like structure), and Hitchcock (subjective POV, suspense from what's *not* shown, meticulous framing, use of space).

For each script, decide:
- How to break it into shots (not one shot per line — think in beats)
- Camera language per shot (wide/medium/close/insert; angle; movement)
- What the audience should *feel* in each moment
- Aspect ratio choice per shot when it serves the story (default to the storyboard's aspect if unsure)

Your image prompts must be usable by a text-to-image model that can't read scripts. They should be visually concrete: subject, action, lighting, mood, camera angle, style. No dialogue. No abstract emotions without visual anchors.`;

function buildShotListPrompt({ script, defaultAspect, constraints }) {
  return `${DIRECTOR_PREAMBLE}

TASK: Read this script and produce a shot list.

SCRIPT:
"""
${script}
"""

CONSTRAINTS:
- Default panel aspect ratio: ${defaultAspect || '16:9'} (only override per-shot if it clearly serves the story)
- Style: black-and-white pencil-sketch storyboard aesthetic (concise line work, greytone shading), unless the constraints below say otherwise
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
      "imagePrompt": "visually concrete text-to-image prompt: subject, action, lighting, mood, camera language, style. Include the style directive at the end.",
      "directorNote": "why this shot at this beat (Scorsese would... / Hitchcock's rule about... / etc.). One line."
    }
  ]
}

Return between 4 and 40 shots depending on script length. Do NOT include the JSON in a code fence. Start your response with { and end with }.`;
}

// ---------- Routes ----------

app.get('/api/health', async (_req, res) => {
  try {
    await runOpenclaw(['--version']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/ronan/shot-list', async (req, res) => {
  const { script, defaultAspect, constraints, sessionId } = req.body || {};
  if (!script || typeof script !== 'string') {
    return res.status(400).json({ error: 'script (string) required' });
  }
  try {
    const prompt = buildShotListPrompt({ script, defaultAspect, constraints });
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
  const { instruction, shot, sessionId, defaultAspect } = req.body || {};
  if (!instruction || !shot) {
    return res.status(400).json({ error: 'instruction and shot required' });
  }
  try {
    const message = `${DIRECTOR_PREAMBLE}

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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[boardfish-ai-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`  POST /api/ronan/shot-list   { script, defaultAspect?, constraints?, sessionId? }`);
  console.log(`  POST /api/ronan/refine      { instruction, shot, sessionId?, defaultAspect? }`);
  console.log(`  POST /api/image/generate    { prompt, aspectRatio? }`);
  console.log(`  GET  /api/health`);
});
