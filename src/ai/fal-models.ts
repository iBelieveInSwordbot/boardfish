// Boardfish 5 — FAL model registry.
//
// Every FAL model we plan to expose in the node editor is registered here.
// The Inspector uses `inputs[]` to auto-generate a form; the DAG executor
// uses `endpoint` when calling `POST /api/fal/run`.
//
// Endpoints tagged with `"endpoint verified pending"` in `notes` are educated
// guesses — Wozbot will confirm against the FAL docs and fix them up later.

export type FalModelKind = 'image' | 'video';

export type FalModelInput = {
  // A schema-lite for the Inspector to render controls automatically.
  key: string;                                    // input key sent to FAL
  label: string;                                  // human label
  type: 'text' | 'number' | 'select' | 'aspect' | 'seed' | 'boolean' | 'image-url';
  required?: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];  // for select
  min?: number;
  max?: number;
  step?: number;
  help?: string;
};

export type FalModelDef = {
  id: string;                        // stable client id, e.g. "nano-banana-pro"
  label: string;                     // "Nano Banana Pro"
  vendor: string;                    // "Google", "OpenAI", "Kling", "ByteDance", etc.
  kind: FalModelKind;                // 'image' or 'video'
  endpoint: string;                  // FAL path, e.g. "fal-ai/nano-banana-pro" or "fal-ai/veo3"
  // Some models expose a separate endpoint for image-to-image / edit that takes
  // reference images. When the executor has upstream image inputs, it will
  // route to `editEndpoint` instead of `endpoint`. If unset, `endpoint` is
  // used for both t2i and edit calls.
  editEndpoint?: string;
  // Which FAL input key carries reference images when the graph provides them.
  // Most modern FAL image models use `image_urls` (array). Older models use
  // `image_url` (singular string). Video models often use `image_url` for
  // first-frame reference. Defaults to `image_urls` if omitted.
  refImageKey?: string;
  // If true, refImageKey expects an array of URLs; if false, a single string.
  refImageIsArray?: boolean;
  inputs: FalModelInput[];           // input schema for the Inspector
  supportsImageInput?: boolean;      // takes an existing image as reference/edit source
  supportsPrompt: boolean;           // true for text-driven models
  costHint?: string;                 // "~$0.05/gen", optional; user-visible
  status: 'active' | 'coming-soon';  // 'coming-soon' shows in dropdown but disables Generate
  notes?: string;                    // one-line description of what it's best at
};

// ---------- Common input fragments ----------

const IMAGE_ASPECTS: { value: string; label: string }[] = [
  { value: '1:1',  label: '1:1  (square)' },
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '9:16', label: '9:16 (vertical)' },
  { value: '4:3',  label: '4:3' },
  { value: '3:4',  label: '3:4' },
  { value: '3:2',  label: '3:2' },
  { value: '2:3',  label: '2:3' },
  { value: '4:5',  label: '4:5' },
  { value: '5:4',  label: '5:4' },
  { value: '21:9', label: '21:9 (cinematic)' },
];

const VIDEO_ASPECTS: { value: string; label: string }[] = [
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '9:16', label: '9:16 (vertical)' },
  { value: '1:1',  label: '1:1  (square)' },
];

const PROMPT_INPUT: FalModelInput = {
  key: 'prompt',
  label: 'Prompt',
  type: 'text',
  required: true,
  help: 'What to generate.',
};

const IMAGE_URL_INPUT: FalModelInput = {
  key: 'image_url',
  label: 'Source image',
  type: 'image-url',
  required: false,
  help: 'Optional reference image (edit / img2img / img2video).',
};

const SEED_INPUT: FalModelInput = {
  key: 'seed',
  label: 'Seed',
  type: 'seed',
  required: false,
  help: 'Deterministic seed. Leave blank for a random one.',
};

// ---------- Model definitions ----------

export const FAL_MODELS: FalModelDef[] = [
  // ============================================================
  // IMAGE MODELS
  // ============================================================

  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    vendor: 'Google',
    kind: 'image',
    endpoint: 'fal-ai/nano-banana-pro',              // text-to-image
    editEndpoint: 'fal-ai/nano-banana-pro/edit',     // image-to-image / reference edit
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.05/img',
    notes:
      'Gemini 3 Pro Image — top-tier photoreal + text rendering. Verified end-to-end 2026-07-10.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: IMAGE_ASPECTS,
      },
      {
        key: 'num_images',
        label: 'Number of images',
        type: 'number',
        default: 1,
        min: 1,
        max: 4,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'nano-banana-1',
    label: 'Nano Banana 1',
    vendor: 'Google',
    kind: 'image',
    endpoint: 'fal-ai/nano-banana',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'coming-soon',
    notes: 'Older / faster Nano Banana. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '1:1',
        options: IMAGE_ASPECTS,
      },
      {
        key: 'num_images',
        label: 'Number of images',
        type: 'number',
        default: 1,
        min: 1,
        max: 4,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    vendor: 'Google',
    kind: 'image',
    endpoint: 'fal-ai/nano-banana-2',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'coming-soon',
    notes: 'endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: IMAGE_ASPECTS,
      },
      {
        key: 'num_images',
        label: 'Number of images',
        type: 'number',
        default: 1,
        min: 1,
        max: 4,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'gpt-image-2',
    label: 'GPT-image 2',
    vendor: 'OpenAI',
    kind: 'image',
    endpoint: 'fal-ai/gpt-image-2',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'coming-soon',
    notes: 'OpenAI GPT-image 2 via FAL. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '1:1',
        options: IMAGE_ASPECTS,
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        default: 'high',
        options: [
          { value: 'low',    label: 'Low'    },
          { value: 'medium', label: 'Medium' },
          { value: 'high',   label: 'High'   },
          { value: 'auto',   label: 'Auto'   },
        ],
      },
      IMAGE_URL_INPUT,
    ],
  },

  // ============================================================
  // VIDEO MODELS
  // ============================================================

  {
    id: 'veo-3',
    label: 'Veo 3',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.75/sec',
    notes: 'Google Veo 3 — top-tier text-to-video and image-to-video.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'number',
        default: 5,
        min: 2,
        max: 10,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-3-fast',
    label: 'Veo 3 Fast',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3/fast',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Veo 3 Fast — cheaper, quicker draft-quality video. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'number',
        default: 5,
        min: 2,
        max: 10,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-2',
    label: 'Veo 2',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo2',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'coming-soon',
    notes: 'Veo 2 — legacy. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'number',
        default: 5,
        min: 2,
        max: 8,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-1-6-pro',
    label: 'Kling 1.6 Pro',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v1.6/pro/text-to-video',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes:
      'Kling 1.6 Pro. For image-to-video variant, swap endpoint to fal-ai/kling-video/v1.6/pro/image-to-video. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '5',
        options: [
          { value: '5',  label: '5s'  },
          { value: '10', label: '10s' },
        ],
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-1-6-standard',
    label: 'Kling 1.6 Standard',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v1.6/standard/text-to-video',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling 1.6 Standard tier. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '5',
        options: [
          { value: '5',  label: '5s'  },
          { value: '10', label: '10s' },
        ],
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-2-master',
    label: 'Kling 2 Master',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v2/master/text-to-video',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'coming-soon',
    notes: 'Kling 2 Master — flagship. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '5',
        options: [
          { value: '5',  label: '5s'  },
          { value: '10', label: '10s' },
        ],
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-1-pro',
    label: 'Seedance 1 Pro',
    vendor: 'ByteDance',
    kind: 'video',
    endpoint: 'fal-ai/bytedance/seedance/v1/pro/text-to-video',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes:
      'ByteDance Seedance 1 Pro — long-form, strong motion. For i2v use fal-ai/bytedance/seedance/v1/pro/image-to-video. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'number',
        default: 5,
        min: 3,
        max: 12,
        step: 1,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '1080p',
        options: [
          { value: '480p',  label: '480p'  },
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
        ],
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-1-lite',
    label: 'Seedance 1 Lite',
    vendor: 'ByteDance',
    kind: 'video',
    endpoint: 'fal-ai/bytedance/seedance/v1/lite/text-to-video',
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Seedance 1 Lite — faster/cheaper draft tier. endpoint verified pending.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'number',
        default: 5,
        min: 3,
        max: 10,
        step: 1,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },
];

// ---------- Indexes / lookups ----------

function bucketByKind(): Record<FalModelKind, FalModelDef[]> {
  const out: Record<FalModelKind, FalModelDef[]> = { image: [], video: [] };
  for (const m of FAL_MODELS) out[m.kind].push(m);
  return out;
}

export const FAL_MODELS_BY_KIND: Record<FalModelKind, FalModelDef[]> = bucketByKind();

const MODEL_INDEX: Map<string, FalModelDef> = new Map(FAL_MODELS.map((m) => [m.id, m]));

export function getFalModel(id: string): FalModelDef | null {
  return MODEL_INDEX.get(id) ?? null;
}
