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

/**
 * A single option in a preset group. When `prompt` is omitted, the option's
 * `label` is written as the field value verbatim (the classic behavior).
 * When `prompt` is set, picking the option writes the full descriptive
 * prompt into the field — lets the picker show a short name like
 * "Cineon Log" while the model sees the full stylistic paragraph.
 *
 * `heading` marks a non-selectable group-header row rendered as a disabled
 * option, so long lists can be organized visually (e.g. LIVE ACTION vs
 * STYLIZED for the Style Tags group).
 */
export type PresetGroupOption =
  | string
  | { label: string; prompt?: string; heading?: false }
  | { label: string; heading: true };

export const PRESET_GROUPS: Record<PresetGroupId, { label: string; options: PresetGroupOption[] }> = {
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
  // Curated style presets (Matt 2026-07-18): each picks a short label in
  // the dropdown but writes a full descriptive prompt into the field so
  // the model gets an opinionated style paragraph without the user having
  // to type it out. Two subgroups: LIVE ACTION and STYLIZED.
  'style-tags': {
    label: 'Style Tags',
    options: [
      { label: 'LIVE ACTION', heading: true },
      {
        label: 'Realistic',
        prompt:
          'Shot on ARRI Alexa Mini LF with Cooke S4 prime lenses, naturalistic color science, warm flattering skin tones, organic highlight rolloff, rich shadow detail with deep blacks, very subtle filmic grain, slightly desaturated naturalistic palette, shallow depth of field with creamy bokeh, 24fps cinematic motion aesthetic, professional color grade.',
      },
      {
        label: 'Cineon Log',
        prompt:
          'Cineon log color space, very flat low-contrast, largest midtone range possible for maximum details, lifted black point, no pure black, no blown out highlights, desaturated wide dynamic range, film negative scan aesthetic, log-encoded, S-curve tone mapping, 10-bit color depth appearance, if the overall image is dark, lift the dark values significantly into the mid-tone range.',
      },
      {
        label: 'Leica M',
        prompt:
          'Cinematic editorial street photography, shot on Leica M with 85mm f/1.4 prime lens at open aperture, shallow depth of field with creamy bokeh dissolving the background into soft painterly shapes, subject sharply rendered in center frame with tack-sharp eye focus, filmic color grade reminiscent of Kodak Portra 400 crossed with a modern digital cinema LUT, lifted shadows with slight milky matte black point, gentle roll-off in highlights, fine organic film grain overlay, subtle chromatic aberration and lens breathing at edges, hazy atmospheric depth, documentary realism with a melancholic contemplative mood, high dynamic range but low contrast, natural skin tones with preserved texture and micro-detail, cover-worthy magazine composition, National Geographic meets Vogue Homme aesthetic, ultra-detailed, photorealistic 8K quality.',
      },
      {
        label: 'Leica Q',
        prompt:
          'Shot on a full-frame Leica M camera, 28mm lens, f/1.4, photorealistic, very shallow depth of field with creamy bokeh, soft background separation, Leica color science, natural color grading, high resolution, crisp focus on eyes and face, ultra-detailed skin and fabric texture. Realistic documentary style with premium editorial fashion photography feel, moody, introspective, grounded, slightly gritty atmosphere.',
      },
      {
        label: '16mm Indie Film Look',
        prompt:
          'Shot on Arriflex 16SR3 with Zeiss Super Speed primes, Kodak Vision3 7219 500T film stock, organic halation around highlights, gentle gate weave, slightly soft optical character, naturalistic available-light aesthetic, muted earthy color palette, warm desaturated tones, soft contrast curve, 1970s American indie cinema texture, professional film scan finish.',
      },
      {
        label: '1970s Film Look',
        prompt:
          'Shot on Panavision Panaflex Gold with Panavision C-Series anamorphic primes, Eastman Color 5247 35mm film stock, warm amber and earthy tone palette, soft low-contrast highlights, blue horizontal anamorphic lens flares, oval anamorphic bokeh, slightly faded shadow detail with lifted blacks, 1970s New Hollywood color science, nostalgic film-print warmth, professional photochemical timing.',
      },
      {
        label: 'B/W Noir',
        prompt:
          'Classic 1940s film noir style, shot on monochrome Kodak Plus-X 35mm black-and-white film with a Mitchell BNC camera, deep crushed blacks with bright specular highlights, hard-key chiaroscuro lighting, low-key contrast ratios, smoky atmospheric haze, fine silver-halide grain structure, subtle halation around practical bulbs, deep-focus composition in the classic Hollywood tradition, glossy silver-gelatin print finish, period-accurate 1940s-50s American film noir cinematic look.',
      },
      {
        label: 'Cyberpunk Neon-Noir',
        prompt:
          'Shot on ARRI Alexa LF with Zeiss Master Anamorphic primes, modern cyberpunk neon-noir cinematography, deep crushed blacks with high-contrast neon practical lighting, vibrant blues purples and magenta neon palette, oval anamorphic bokeh and horizontal blue lens flares, thick volumetric atmospheric haze, rain-slicked reflective wet street surfaces, dramatic chiaroscuro from sign and signage glow, cool teal-and-magenta DI color grade, dystopian futuristic mood, contemporary high-end neo-noir cinematic finish.',
      },
      { label: 'STYLIZED', heading: true },
      // Boardfish-native styles: keep the short tag — executor + storyboard
      // pipeline already know how to expand these into full style prompts
      // via STYLE_PRESETS on the server.
      { label: 'Pencil Sketch' },
      { label: 'Ink Wash' },
      {
        label: 'Stylized 3D',
        prompt:
          '3D animated feature film style, physically-based path-traced rendering, exaggerated stylized character proportions, soft warm indirect light bounce, subsurface scattering on skin, micro-detail in fabric weave and hair clumping, sculpted push-pulled rim lighting, vibrant designed color script palette, soft ambient occlusion in contact shadows, polished glossy surface finish, theatrical key-and-fill lighting design, modern feature-animation production finish.',
      },
      {
        label: 'Cute 3D',
        prompt:
          'Cute stylized 3D animation style, physically-based path-traced rendering, soft rounded character silhouettes, oversized expressive features, warm saturated candy-color palette, soft subsurface scattering on skin, fluffy hair clumping with stray strand detail, plush fabric weave texture, gentle wraparound rim lighting, soft indirect light bounce, creamy background bokeh, ambient occlusion in contact shadows, whimsical family-friendly atmosphere, polished modern feature-animation finish.',
      },
      {
        label: 'Mid-Century Modern',
        prompt:
          'Mid-century modern adult animated cartoon style, realistic character proportions, clean bold confident line art, flat color fills with hard-edged single-tone shadow shapes, detailed facial features and eyes, retro 1950s-60s espionage wardrobe and production design, bold color blocking throughout both characters and environments, hand-painted matte-painting backgrounds with visible brushwork and simplified architectural forms, graphic-novel-influenced composition, sharp directional Cold-War-noir key lighting, dry-humor adult-animation aesthetic, stylish retro-modern finish.',
      },
      {
        label: 'Comic — Modern',
        prompt:
          'Modern American comic book style, sharp digital inking with controlled variable line weight, bold outer contours and finer interior detail, dynamic action posing with confident foreshortening, gradient and cel-style digital color rendering, dramatic chiaroscuro shadows, glossy modern color finish, rim-lit hero lighting, high-contrast color blocking, expressive splash-page composition, contemporary superhero house-style production aesthetic.',
      },
      {
        label: 'Comic — Classic',
        prompt:
          'Early Golden Age comic book style, hand-inked linework with bold contour weight, flat primary-color fills, visible Ben-Day dot halftone pattern, four-color CMYK newsprint registration, slight off-register color bleed, limited hard-edged shadow shapes, minimal cross-hatching, 1940s-50s pulp-era heroic figure construction, vintage newsprint paper texture, period-accurate pulp comic finish.',
      },
      {
        label: 'Claymation',
        prompt:
          'Stop-motion claymation style, characters and props sculpted from plasticine clay with visible fingerprint and sculpting-tool texture, simple shape-driven character design, realistic three-point practical stage lighting, glossy white catchlight in every eye with visible sclera, fabric and felt costume textures, subtle armature wobble between frames, characteristic 12fps stop-motion motion cadence, modest family-friendly costume design, traditional handcrafted stop-motion feature production finish.',
      },
      {
        label: 'Shonen Anime',
        prompt:
          'Modern action shonen anime style, hand-drawn cel-shaded characters with hard color holds, dynamic sakuga action posing, sharp clean linework with controlled weight variation, vibrant saturated character palette, hand-painted background plates with painterly atmospheric depth, dramatic rim lighting and selective bloom, high-contrast shadow shapes, expressive impact frames with motion smears, digital ink-and-paint finish, premium theatrical Japanese animation compositing.',
      },
      {
        label: 'Moe Anime',
        prompt:
          'Moe slice-of-life anime style, soft cel-shaded characters with gentle two-tone shading, pastel color palette, large expressive eyes with detailed catchlight highlights, fluffy multi-tone hair rendering with stray strand detail, gentle volumetric window light, hand-painted backgrounds with soft focal falloff, charming everyday composition, warm sentimental atmosphere, digital ink-and-paint finish, premium modern Japanese slice-of-life production aesthetic.',
      },
      {
        label: 'Japanese Watercolor',
        prompt:
          'Japanese watercolor style drips in a physically accurate fluid simulation like wet paint on paper. Painting is loose around the edges with exposed paper and drips. Watercolor illustration, textured cold-press paper, semi-transparent washes, wet-on-wet gradients, soft bleeding edges, light dry-brush accents, subtle sketchy ink linework with variable weight, minimal contour lines, low saturation and gentle contrast, diffuse backlighting with soft reflections, delicate cast shadows, visible paper grain, pigment granulation and blooms, loose impressionistic detail, airy negative space, vignette with edge drips and splatter effects, calm luminous serene nostalgic mood, hand-painted travelogue aesthetic.',
      },
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

/**
 * Normalize a mixed `string | { label, prompt?, heading? }` option array
 * into a uniform shape callers can iterate without repeatedly type-checking.
 * Headings are preserved so the picker can render them as disabled group
 * dividers.
 */
export type NormalizedPresetOption = {
  label: string;
  /** Value that ends up in `field.value` when this option is picked. When
   *  the option has a `prompt`, that becomes the value. Otherwise the label. */
  value: string;
  /** True for section-header rows in long lists (LIVE ACTION / STYLIZED). */
  heading: boolean;
};

export function normalizePresetOptions(
  opts: PresetGroupOption[] | undefined,
): NormalizedPresetOption[] {
  if (!opts) return [];
  return opts.map((o) => {
    if (typeof o === 'string') return { label: o, value: o, heading: false };
    if ('heading' in o && o.heading) return { label: o.label, value: '', heading: true };
    const prompt = (o as { prompt?: string }).prompt;
    return { label: o.label, value: (prompt && prompt.trim()) || o.label, heading: false };
  });
}

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
  /**
   * When true, this preset is shown to the user as an EXAMPLE workflow in
   * the "User Saved Presets" section of the picker rather than as a
   * top-level built-in. Kept in code (not user storage) so it's always
   * available even on a fresh install — users treat it like a saved
   * preset (can apply, can duplicate via Save-current-as…).
   */
  example?: boolean;
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

// Two categories:
//  * Top-level (builtIn && !example): "Text Prompt" (legacy — handled by the
//    picker's __clear__ path, no preset entry needed) and "Multi Prompt".
//  * Example workflows (builtIn && example): show in the User Saved Presets
//    section as ready-to-use starting points. Users can Save-current-as to
//    fork them into their own list.
export const BUILT_IN_PRESETS: NodePresetTemplate[] = [
  { id: 'builtin:multi-prompt', name: 'Multi Prompt', fields: MULTI_PROMPT_TEMPLATE, builtIn: true },
  { id: 'builtin:image-prompt', name: 'Image Prompt', fields: IMAGE_PROMPT_TEMPLATE, builtIn: true, example: true },
  { id: 'builtin:movie-prompt', name: 'Movie Prompt', fields: MOVIE_PROMPT_TEMPLATE, builtIn: true, example: true },
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
