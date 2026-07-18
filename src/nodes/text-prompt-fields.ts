// Text Prompt v2 — structured fields + presets.
//
// Data model (all optional except `text` for legacy fallback):
//   data.text?:  string                 // legacy single-field prompt
//   data.fields?: PromptField[]         // present = structured mode
//   data.presetName?: string            // inspector display label
//
// This module is UI-agnostic (no React); the executor and the registry
// Preview / Inspector all import it. Keeping the concat logic in one place
// guarantees the Preview and the runner render identical text.

// ---------- Preset groups ----------

export type PresetGroupId =
  | 'shot-type'
  | 'focal-length'
  | 'lighting'
  | 'perspective'
  | 'style-tags'
  | 'camera-movement';

export const PRESET_GROUPS: Record<PresetGroupId, { label: string; options: string[] }> = {
  'shot-type': {
    label: 'Shot Type',
    options: [
      'Establishing Shot',
      'Extreme Wide Shot',
      'Wide Shot',
      'Full Shot',
      'Medium Wide / Cowboy',
      'Medium Shot',
      'Medium Close-Up',
      'Close-Up',
      'Extreme Close-Up',
      'Two-Shot',
      'Over-the-Shoulder',
      'Insert / Detail Shot',
      'Single / One-Shot',
    ],
  },
  'focal-length': {
    label: 'Focal Length',
    options: [
      'Ultra Wide (14-20mm)',
      'Wide (24-35mm)',
      'Standard (40-50mm)',
      'Short Telephoto (70-85mm)',
      'Telephoto (100-200mm)',
      'Long Telephoto (200mm+)',
      'Macro',
      'Anamorphic',
    ],
  },
  lighting: {
    label: 'Lighting',
    options: [
      'Natural / Available Light',
      'Soft / Diffused Light',
      'Hard Light',
      'Low-Key',
      'High-Key',
      'Backlighting',
      'Side Lighting',
      'Rim / Edge Lighting',
      'Rembrandt Lighting',
      'Candlelight',
      'Firelight',
      'Neon / Colored Lighting',
      'Practical Lighting',
      'Silhouette',
      'Top / Overhead Light',
      'Under Lighting',
      'Volumetric / God Rays',
      'Chiaroscuro',
      'Golden Hour',
      'Sunset',
      'Blue Hour / Twilight',
      'Moonlight',
    ],
  },
  perspective: {
    label: 'Perspective',
    options: [
      'Eye Level',
      'Low Angle',
      'High Angle',
      "Overhead / Bird's Eye",
      "Worm's Eye",
      'Dutch Angle / Canted',
      'POV / First Person',
      'Extreme Wide Shot',
      'Aerial / Drone',
      'Hip Level',
    ],
  },
  'style-tags': {
    label: 'Style Tags',
    options: [
      'Photorealistic',
      'Pencil Sketch',
      'Ink Wash',
      'Noir',
      'Anime',
      'Watercolor',
      'Comic Ink',
      'Cinematic',
      'Documentary',
      'Vintage Film',
      'Digital Painting',
      'Concept Art',
      '3D Render',
      'Storyboard Sketch',
    ],
  },
  'camera-movement': {
    label: 'Camera Movement',
    options: [
      'Arc',
      'Crab',
      'Pan',
      'Static',
      'Tilt',
      'Tracking Shot',
      'Zoom In',
      'Zoom Out',
    ],
  },
};

// ---------- Field shape ----------

export type PromptField =
  | { id: string; kind: 'text'; label: string; value: string; join: 'inline' | 'block' }
  | {
      id: string;
      kind: 'preset-text';
      label: string;
      value: string;
      presetGroup: PresetGroupId;
      join: 'inline' | 'block';
    }
  | {
      id: string;
      kind: 'dialogue';
      label: string;
      value: string;
      actorId?: string;
      actorName?: string;
      join: 'block';
    }
  | { id: string; kind: 'section'; label: string };

// ---------- IDs ----------

export function makeFieldId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through */
  }
  return 'field_' + Math.random().toString(36).slice(2, 10);
}

// ---------- Concat helper ----------
//
// Rules (from spec):
//   - Walk fields in order.
//   - Skip section entirely (label only).
//   - Skip fields whose trimmed value is empty.
//   - Dialogue: `[ACTOR_NAME]: "value"` if actorName set, else just `value`.
//     Always on its own line.
//   - Join adjacent `inline` fields with `, ` (comma + space).
//   - `block` fields get their own line — preceded by a newline if content
//     already exists, and followed by a newline before the next content.
//   - If fields[] is absent OR empty, fall back to legacyText.

export function concatFields(
  fields: PromptField[] | undefined,
  legacyText: string,
): string {
  if (!fields || fields.length === 0) return legacyText;

  const tokens: { text: string; join: 'inline' | 'block' }[] = [];
  for (const f of fields) {
    if (f.kind === 'section') continue;
    if (f.kind === 'dialogue') {
      const v = (f.value ?? '').trim();
      if (!v) continue;
      const name = (f.actorName ?? '').trim();
      const line = name ? `[${name.toUpperCase()}]: "${v}"` : v;
      tokens.push({ text: line, join: 'block' });
      continue;
    }
    const v = (f.value ?? '').trim();
    if (!v) continue;
    tokens.push({ text: v, join: f.join });
  }

  if (tokens.length === 0) return legacyText || '';

  // Group adjacent inline tokens; each block token stands alone.
  let out = '';
  let inlineBuf: string[] = [];
  const flushInline = () => {
    if (inlineBuf.length === 0) return;
    const chunk = inlineBuf.join(', ');
    if (out.length === 0) out = chunk;
    else out += '\n' + chunk;
    inlineBuf = [];
  };
  for (const t of tokens) {
    if (t.join === 'inline') {
      inlineBuf.push(t.text);
    } else {
      flushInline();
      if (out.length === 0) out = t.text;
      else out += '\n' + t.text;
    }
  }
  flushInline();
  return out;
}

// ---------- Explode helper ----------

/**
 * Return the resolved value string for every non-empty, non-section field.
 * Used by the Explode-to-Nodes escape hatch: each string becomes its own
 * text-prompt node, then a prompt-concat merges them back together.
 */
export function explodeFieldsToTextParts(
  fields: PromptField[] | undefined,
  legacyText: string,
): string[] {
  if (!fields || fields.length === 0) {
    const t = (legacyText ?? '').trim();
    return t ? [t] : [];
  }
  const out: string[] = [];
  for (const f of fields) {
    if (f.kind === 'section') continue;
    if (f.kind === 'dialogue') {
      const v = (f.value ?? '').trim();
      if (!v) continue;
      const name = (f.actorName ?? '').trim();
      out.push(name ? `[${name.toUpperCase()}]: "${v}"` : v);
      continue;
    }
    const v = (f.value ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

// ---------- Built-in presets ----------

export type NodePresetTemplate = {
  id: string;
  name: string;
  fields: PromptField[];
  builtIn?: boolean;
};

const IMAGE_PROMPT_TEMPLATE: PromptField[] = [
  { id: '__t__', kind: 'text', label: 'Image Shot Description', value: '', join: 'block' },
  { id: '__t__', kind: 'section', label: 'Cinematography Specs' },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Shot Type',
    value: '',
    presetGroup: 'shot-type',
    join: 'inline',
  },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Focal Length',
    value: '',
    presetGroup: 'focal-length',
    join: 'inline',
  },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Lighting',
    value: '',
    presetGroup: 'lighting',
    join: 'inline',
  },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Perspective',
    value: '',
    presetGroup: 'perspective',
    join: 'inline',
  },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Style Tags',
    value: '',
    presetGroup: 'style-tags',
    join: 'inline',
  },
  { id: '__t__', kind: 'text', label: 'Staging & Composition', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Action & Performance', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Set & Lighting', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Decisive Moment', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Atmosphere', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Color Palette', value: '', join: 'inline' },
];

const MULTI_PROMPT_TEMPLATE: PromptField[] = [
  { id: '__t__', kind: 'text', label: 'Prompt 1', value: '', join: 'block' },
  { id: '__t__', kind: 'text', label: 'Prompt 2', value: '', join: 'block' },
];

const MOVIE_PROMPT_TEMPLATE: PromptField[] = [
  { id: '__t__', kind: 'text', label: 'Video Shot Description', value: '', join: 'block' },
  { id: '__t__', kind: 'dialogue', label: 'Dialogue', value: '', join: 'block' },
  {
    id: '__t__',
    kind: 'preset-text',
    label: 'Camera Movement',
    value: '',
    presetGroup: 'camera-movement',
    join: 'inline',
  },
  { id: '__t__', kind: 'text', label: 'Video Action', value: '', join: 'block' },
  {
    id: '__t__',
    kind: 'text',
    label: 'Video Performance, Tone + Facial Acting',
    value: '',
    join: 'block',
  },
];

export const BUILT_IN_PRESETS: NodePresetTemplate[] = [
  { id: 'builtin:image-prompt', name: 'Image Prompt', fields: IMAGE_PROMPT_TEMPLATE, builtIn: true },
  { id: 'builtin:movie-prompt', name: 'Movie Prompt', fields: MOVIE_PROMPT_TEMPLATE, builtIn: true },
  { id: 'builtin:multi-prompt', name: 'Multi Prompt', fields: MULTI_PROMPT_TEMPLATE, builtIn: true },
];

/**
 * Return freshly-id'd copies of a built-in preset's fields. The static
 * templates use `__t__` placeholder ids — this replaces them so the graph
 * never has field-id collisions.
 */
export function cloneBuiltInPreset(id: string): PromptField[] {
  const p = BUILT_IN_PRESETS.find((b) => b.id === id);
  if (!p) return [];
  return cloneFieldsFresh(p.fields);
}

/** Copy an array of fields, assigning a fresh id to every entry. */
export function cloneFieldsFresh(fields: PromptField[]): PromptField[] {
  return fields.map((f) => ({ ...f, id: makeFieldId() }) as PromptField);
}
