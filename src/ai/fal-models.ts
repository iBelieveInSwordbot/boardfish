// Boardfish 5 — FAL model registry.
//
// Every FAL model we plan to expose in the node editor is registered here.
// The Inspector uses `inputs[]` to auto-generate a form; the DAG executor
// uses `endpoint` when calling `POST /api/fal/run`.
//
// All endpoints in this file are verified against https://fal.ai/models/<slug>/api
// docs as of 2026-07-15. If FAL changes a slug or schema, update here.

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
  // first-frame reference — but Kling v3 uses `start_image_url` and Veo 3.1
  // first-last-frame uses `first_frame_url`. Defaults to `image_urls` if omitted.
  refImageKey?: string;
  // If true, refImageKey expects an array of URLs; if false, a single string.
  refImageIsArray?: boolean;
  // When a model needs multiple *distinct* image input ports (e.g. Veo 3.1
  // First/Last Frame needs both first_frame_url and last_frame_url), declare
  // each here. The node renders one port per entry (in order); the executor
  // routes whatever image reaches that port to `falKey` in the payload.
  // Overrides refImageKey/refImageIsArray when present.
  refPorts?: Array<{ portId: string; label: string; falKey: string }>;
  // For gen nodes where the number of refs is user-controlled (Nano Banana
  // Pro accepts 1–6; Seedance 2 Reference accepts up to 9), set the max.
  // The Inspector's +/− stepper reads this cap.
  maxRefInputs?: number;
  // When the fal /models/pricing endpoint returns a single unit_price but
  // the model actually charges more at higher resolutions (Nano Banana Pro
  // at 1K vs 2K vs 4K), declare per-resolution multipliers here. The cost
  // estimator reads node.data.resolution and multiplies unit_price by this.
  // Keyed on the same string that appears in the resolution `select` input.
  // Omit for models whose fal-returned price is already correct.
  resolutionCostMultiplier?: Record<string, number>;
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

const IMAGE_ASPECTS_AUTO: { value: string; label: string }[] = [
  { value: 'auto', label: 'auto' },
  ...IMAGE_ASPECTS,
];

// GPT Image 2 uses named `image_size` presets instead of a raw aspect ratio.
// From `openai/gpt-image-2` OpenAPI: portrait/landscape/square in three ratios.
const GPT_IMAGE_2_SIZES: { value: string; label: string }[] = [
  { value: 'square_1024',   label: 'Square (1024×1024)'    },
  { value: 'landscape_4_3', label: 'Landscape 4:3'         },
  { value: 'landscape_16_9',label: 'Landscape 16:9'        },
  { value: 'portrait_3_4',  label: 'Portrait 3:4'          },
  { value: 'portrait_9_16', label: 'Portrait 9:16'         },
];

// Flux 2 Pro uses named size presets too.
const FLUX_2_SIZES: { value: string; label: string }[] = [
  { value: 'auto',           label: 'auto (match reference)' },
  { value: 'square_hd',      label: 'Square HD'              },
  { value: 'square',         label: 'Square'                 },
  { value: 'portrait_4_3',   label: 'Portrait 4:3'           },
  { value: 'portrait_16_9',  label: 'Portrait 16:9'          },
  { value: 'landscape_4_3',  label: 'Landscape 4:3'          },
  { value: 'landscape_16_9', label: 'Landscape 16:9'         },
];

const VIDEO_ASPECTS_WIDE_TALL: { value: string; label: string }[] = [
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '9:16', label: '9:16 (vertical)' },
];

const VIDEO_ASPECTS_WIDE_TALL_SQUARE: { value: string; label: string }[] = [
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '9:16', label: '9:16 (vertical)' },
  { value: '1:1',  label: '1:1  (square)' },
];

const VIDEO_ASPECTS_AUTO: { value: string; label: string }[] = [
  { value: 'auto', label: 'auto (match source)' },
  { value: '16:9', label: '16:9 (widescreen)' },
  { value: '9:16', label: '9:16 (vertical)' },
];

const PROMPT_INPUT: FalModelInput = {
  key: 'prompt',
  label: 'Prompt',
  type: 'text',
  required: true,
  help: 'What to generate.',
};

const NEGATIVE_PROMPT_INPUT: FalModelInput = {
  key: 'negative_prompt',
  label: 'Negative prompt',
  type: 'text',
  required: false,
  help: 'What to avoid.',
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

// Common output-format select (png/jpeg/webp).
const OUTPUT_FORMAT_INPUT: FalModelInput = {
  key: 'output_format',
  label: 'Output format',
  type: 'select',
  default: 'png',
  options: [
    { value: 'png',  label: 'PNG'  },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
  ],
};

// Common safety-tolerance select (1 = strictest, 6 = most permissive).
const SAFETY_TOLERANCE_INPUT: FalModelInput = {
  key: 'safety_tolerance',
  label: 'Safety tolerance',
  type: 'select',
  default: '4',
  options: [
    { value: '1', label: '1 (strict)' },
    { value: '2', label: '2' },
    { value: '3', label: '3' },
    { value: '4', label: '4' },
    { value: '5', label: '5' },
    { value: '6', label: '6 (loose)' },
  ],
  help: '1 = strictest content filter, 6 = most permissive.',
};

const SYSTEM_PROMPT_INPUT: FalModelInput = {
  key: 'system_prompt',
  label: 'System prompt (optional)',
  type: 'text',
  required: false,
  help: 'Steers the model persona / style.',
};

// ---------- Model definitions ----------

export const FAL_MODELS: FalModelDef[] = [
  // ============================================================
  // IMAGE MODELS  (all `active` — Matt wants no more gray-outs)
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
    maxRefInputs: 6,
    // Nano Banana Pro charges more at higher resolutions but fal's
    // /models/pricing only returns a single baseline unit_price ($0.15,
    // treated as the 1K tier). Multipliers below are approximate scaling
    // factors reported by fal for 2K/4K output; tune when actual invoices
    // land. The estimator applies this to the base unit_price so 1K stays
    // matched to the returned value.
    resolutionCostMultiplier: { '1K': 1, '2K': 2, '4K': 4 },
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.05/img',
    notes: 'Gemini 3 Pro Image — top-tier photoreal + text rendering. Auto-swaps to /edit endpoint with an image input.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: IMAGE_ASPECTS_AUTO,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '1K',
        options: [
          { value: '1K', label: '1K' },
          { value: '2K', label: '2K' },
          { value: '4K', label: '4K' },
        ],
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
      OUTPUT_FORMAT_INPUT,
      SAFETY_TOLERANCE_INPUT,
      SYSTEM_PROMPT_INPUT,
      {
        key: 'enable_web_search',
        label: 'Enable web search',
        type: 'boolean',
        default: false,
        help: 'Let the model pull in web context (adds latency + cost).',
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
    editEndpoint: 'fal-ai/nano-banana-2/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    maxRefInputs: 6,
    // Nano Banana 2 exposes 0.5K/1K/2K/4K. Same scaling assumption as
    // Nano Banana Pro (see comment above). 0.5K ≈ half a 1K.
    resolutionCostMultiplier: { '0.5K': 0.5, '1K': 1, '2K': 2, '4K': 4 },
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.03/img',
    notes: 'Gemini 3.1 Flash Image — faster / cheaper than Pro. Accepts multi-modal context (image/video/audio/pdf refs).',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: 'auto',
        options: IMAGE_ASPECTS_AUTO,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '1K',
        options: [
          { value: '0.5K', label: '0.5K' },
          { value: '1K',   label: '1K'   },
          { value: '2K',   label: '2K'   },
          { value: '4K',   label: '4K'   },
        ],
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
      OUTPUT_FORMAT_INPUT,
      SAFETY_TOLERANCE_INPUT,
      SYSTEM_PROMPT_INPUT,
      {
        key: 'thinking_level',
        label: 'Thinking level',
        type: 'select',
        default: '',
        options: [
          { value: '',       label: 'off' },
          { value: 'minimal',label: 'minimal' },
          { value: 'medium', label: 'medium' },
          { value: 'high',   label: 'high' },
        ],
        help: 'When set, enables model thinking (slower, more considered).',
      },
      {
        key: 'enable_web_search',
        label: 'Enable web search',
        type: 'boolean',
        default: false,
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
    editEndpoint: 'fal-ai/nano-banana/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.02/img',
    notes: 'Gemini 2.5 Flash Image — the original.',
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
      OUTPUT_FORMAT_INPUT,
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    vendor: 'OpenAI',
    kind: 'image',
    endpoint: 'openai/gpt-image-2',
    editEndpoint: 'openai/gpt-image-2/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'OpenAI gpt-image-2 via FAL. Uses `image_size` presets (portrait/landscape/square) instead of raw aspect_ratio.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'image_size',
        label: 'Image size',
        type: 'select',
        default: 'landscape_4_3',
        options: GPT_IMAGE_2_SIZES,
      },
      {
        key: 'quality',
        label: 'Quality',
        type: 'select',
        default: 'high',
        options: [
          { value: 'auto',   label: 'Auto'   },
          { value: 'low',    label: 'Low'    },
          { value: 'medium', label: 'Medium' },
          { value: 'high',   label: 'High'   },
        ],
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
      OUTPUT_FORMAT_INPUT,
      IMAGE_URL_INPUT,
    ],
  },

  {
    id: 'flux-2-pro',
    label: 'FLUX 2 Pro',
    vendor: 'Black Forest Labs',
    kind: 'image',
    endpoint: 'fal-ai/flux-2-pro',
    editEndpoint: 'fal-ai/flux-2-pro/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'FLUX 2 Pro — Black Forest Labs\' flagship. Named size presets.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'image_size',
        label: 'Image size',
        type: 'select',
        default: 'landscape_16_9',
        options: FLUX_2_SIZES,
      },
      OUTPUT_FORMAT_INPUT,
      {
        key: 'safety_tolerance',
        label: 'Safety tolerance',
        type: 'select',
        default: '2',
        options: [
          { value: '1', label: '1 (strict)' },
          { value: '2', label: '2' },
          { value: '3', label: '3' },
          { value: '4', label: '4' },
          { value: '5', label: '5 (loose)' },
        ],
      },
      {
        key: 'enable_safety_checker',
        label: 'Safety checker',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'flux-1-1-pro-ultra',
    label: 'FLUX 1.1 [pro] Ultra',
    vendor: 'Black Forest Labs',
    kind: 'image',
    endpoint: 'fal-ai/flux-pro/v1.1-ultra',
    supportsImageInput: false,
    supportsPrompt: true,
    status: 'active',
    notes: 'FLUX 1.1 [pro] Ultra — highest resolution (4MP), best quality.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: [
          { value: '21:9', label: '21:9' },
          { value: '16:9', label: '16:9' },
          { value: '4:3',  label: '4:3'  },
          { value: '3:2',  label: '3:2'  },
          { value: '1:1',  label: '1:1'  },
          { value: '2:3',  label: '2:3'  },
          { value: '3:4',  label: '3:4'  },
          { value: '9:16', label: '9:16' },
          { value: '9:21', label: '9:21' },
        ],
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
      OUTPUT_FORMAT_INPUT,
      {
        key: 'raw',
        label: 'Raw mode',
        type: 'boolean',
        default: false,
        help: 'Less-processed, more natural output.',
      },
      {
        key: 'safety_tolerance',
        label: 'Safety tolerance',
        type: 'select',
        default: '2',
        options: [
          { value: '1', label: '1 (strict)' },
          { value: '2', label: '2' },
          { value: '3', label: '3' },
          { value: '4', label: '4' },
          { value: '5', label: '5' },
          { value: '6', label: '6 (loose)' },
        ],
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'seedream-v4-5',
    label: 'Seedream V4.5',
    vendor: 'ByteDance',
    kind: 'image',
    endpoint: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    editEndpoint: 'fal-ai/bytedance/seedream/v4.5/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'ByteDance Seedream V4.5 — strong photoreal + typography.',
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
      OUTPUT_FORMAT_INPUT,
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'grok-imagine-image',
    label: 'Grok Imagine Image',
    vendor: 'xAI',
    kind: 'image',
    endpoint: 'xai/grok-imagine-image',
    editEndpoint: 'xai/grok-imagine-image/edit',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'xAI Grok Imagine — text + image inputs, native to X.',
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

  // ============================================================
  // VIDEO MODELS
  // Per Matt's 2026-07-15 spec:
  //   - Veo 3.0
  //   - Veo 3.1 (all variants)
  //   - Kling 2.5 Turbo Pro
  //   - Kling v3 (all variants)
  //   - Seedance 2 (all variants)
  // All other video models removed.
  // ============================================================

  {
    id: 'veo-3',
    label: 'Veo 3',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3',
    editEndpoint: 'fal-ai/veo3/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.75/sec',
    notes: 'Google Veo 3 — native audio. Auto-swaps to image-to-video with a first-frame image.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '8s',
        options: [
          { value: '4s', label: '4s' },
          { value: '6s', label: '6s' },
          { value: '8s', label: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      {
        key: 'auto_fix',
        label: 'Auto-fix prompt',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-3-1',
    label: 'Veo 3.1',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3.1',
    editEndpoint: 'fal-ai/veo3.1/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Google Veo 3.1 — improved motion + lip-sync, up to 4K.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '8s',
        options: [
          { value: '4s', label: '4s' },
          { value: '6s', label: '6s' },
          { value: '8s', label: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      {
        key: 'auto_fix',
        label: 'Auto-fix prompt',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-3-1-fast',
    label: 'Veo 3.1 Fast',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3.1/fast',
    editEndpoint: 'fal-ai/veo3.1/fast/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Veo 3.1 Fast — draft quality at lower cost.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '8s',
        options: [
          { value: '4s', label: '4s' },
          { value: '6s', label: '6s' },
          { value: '8s', label: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      {
        key: 'auto_fix',
        label: 'Auto-fix prompt',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-3-1-flf',
    label: 'Veo 3.1 First/Last Frame',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3.1/first-last-frame-to-video',
    // Two dedicated ports. Executor routes each to its own FAL key.
    refPorts: [
      { portId: 'first', label: 'first frame', falKey: 'first_frame_url' },
      { portId: 'last',  label: 'last frame',  falKey: 'last_frame_url'  },
    ],
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Veo 3.1 first/last frame interpolation. Wire images to BOTH first and last ports.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: 'auto',
        options: VIDEO_ASPECTS_AUTO,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '8s',
        options: [
          { value: '4s', label: '4s' },
          { value: '6s', label: '6s' },
          { value: '8s', label: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      {
        key: 'last_frame_url',
        label: 'Last frame URL',
        type: 'image-url',
        required: false,
        help: 'Optional end frame. Paste a URL; the graph does not wire this port yet.',
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'veo-3-1-fast-flf',
    label: 'Veo 3.1 Fast First/Last Frame',
    vendor: 'Google',
    kind: 'video',
    endpoint: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
    refPorts: [
      { portId: 'first', label: 'first frame', falKey: 'first_frame_url' },
      { portId: 'last',  label: 'last frame',  falKey: 'last_frame_url'  },
    ],
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Veo 3.1 Fast first/last frame — wire images to BOTH first and last ports.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: 'auto',
        options: VIDEO_ASPECTS_AUTO,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'select',
        default: '8s',
        options: [
          { value: '4s', label: '4s' },
          { value: '6s', label: '6s' },
          { value: '8s', label: '8s' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      {
        key: 'last_frame_url',
        label: 'Last frame URL',
        type: 'image-url',
        required: false,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-2-5-turbo-pro',
    label: 'Kling 2.5 Turbo Pro',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    editEndpoint: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling 2.5 Turbo Pro — fast pro-tier Kling.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
        help: 'How closely the model sticks to the prompt (0–1).',
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-v3-pro',
    label: 'Kling v3 Pro',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v3/pro/text-to-video',
    editEndpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
    refImageKey: 'start_image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling v3 Pro — best quality Kling. i2v uses start_image_url.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: false,
      },
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-v3-standard',
    label: 'Kling v3 Standard',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v3/standard/text-to-video',
    editEndpoint: 'fal-ai/kling-video/v3/standard/image-to-video',
    refImageKey: 'start_image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling v3 Standard — balanced quality/speed.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: false,
      },
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-v3-turbo-pro',
    label: 'Kling v3 Turbo Pro',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v3/turbo/pro/text-to-video',
    editEndpoint: 'fal-ai/kling-video/v3/turbo/pro/image-to-video',
    refImageKey: 'start_image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling v3 Turbo Pro — fast pro-quality Kling v3.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-v3-4k',
    label: 'Kling v3 4K',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    // 4K tier is image-to-video only; there is no text-to-video endpoint.
    endpoint: 'fal-ai/kling-video/v3/4k/image-to-video',
    editEndpoint: 'fal-ai/kling-video/v3/4k/image-to-video',
    refImageKey: 'start_image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.42/sec (4K)',
    notes: 'Kling v3 4K — top-tier native 4K Kling. Image-to-video only; wire a start image.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'kling-v3-turbo-standard',
    label: 'Kling v3 Turbo Standard',
    vendor: 'Kling (Kuaishou)',
    kind: 'video',
    endpoint: 'fal-ai/kling-video/v3/turbo/standard/text-to-video',
    editEndpoint: 'fal-ai/kling-video/v3/turbo/standard/image-to-video',
    refImageKey: 'start_image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Kling v3 Turbo Standard — fastest Kling v3 draft.',
    inputs: [
      PROMPT_INPUT,
      NEGATIVE_PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
      {
        key: 'cfg_scale',
        label: 'CFG scale',
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-2',
    label: 'Seedance 2',
    vendor: 'ByteDance',
    kind: 'video',
    endpoint: 'bytedance/seedance-2.0/text-to-video',
    editEndpoint: 'bytedance/seedance-2.0/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'ByteDance Seedance 2 — SOTA video with native audio + camera control.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
        default: '720p',
        options: [
          { value: '480p',  label: '480p'  },
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-2-fast',
    label: 'Seedance 2 Fast',
    vendor: 'ByteDance',
    kind: 'video',
    endpoint: 'bytedance/seedance-2.0/fast/text-to-video',
    editEndpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Seedance 2 Fast — draft quality at lower cost.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
        default: '720p',
        options: [
          { value: '480p',  label: '480p'  },
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      IMAGE_URL_INPUT,
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-2-ref',
    label: 'Seedance 2 Reference',
    vendor: 'ByteDance',
    kind: 'video',
    // Reference-to-video endpoint accepts up to 9 images + 3 videos + 3 audio
    // clips. The graph only wires a single image today; more can be pasted
    // into the raw inputs via Custom FAL if needed.
    endpoint: 'bytedance/seedance-2.0/reference-to-video',
    editEndpoint: 'bytedance/seedance-2.0/reference-to-video',
    refImageKey: 'image_urls',
    refImageIsArray: true,
    maxRefInputs: 9,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    costHint: '~$0.30/sec (720p)',
    notes: 'Seedance 2 Reference-to-Video — multi-reference i2v (up to 9 image refs). SOTA quality.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
        default: '720p',
        options: [
          { value: '480p',  label: '480p'  },
          { value: '720p',  label: '720p'  },
          { value: '1080p', label: '1080p' },
          { value: '4k',    label: '4K'    },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
      },
      SEED_INPUT,
    ],
  },

  {
    id: 'seedance-2-mini',
    label: 'Seedance 2 Mini',
    vendor: 'ByteDance',
    kind: 'video',
    endpoint: 'bytedance/seedance-2.0/mini/text-to-video',
    editEndpoint: 'bytedance/seedance-2.0/mini/image-to-video',
    refImageKey: 'image_url',
    refImageIsArray: false,
    supportsImageInput: true,
    supportsPrompt: true,
    status: 'active',
    notes: 'Seedance 2 Mini — cheapest Seedance 2 tier.',
    inputs: [
      PROMPT_INPUT,
      {
        key: 'aspect_ratio',
        label: 'Aspect ratio',
        type: 'aspect',
        default: '16:9',
        options: VIDEO_ASPECTS_WIDE_TALL_SQUARE,
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
        default: '720p',
        options: [
          { value: '480p', label: '480p' },
          { value: '720p', label: '720p' },
        ],
      },
      {
        key: 'generate_audio',
        label: 'Generate audio',
        type: 'boolean',
        default: true,
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

// Alias map: old model ids from earlier versions of this file map to the
// current id so persisted graphs don't blow up after a rename.
const MODEL_ID_ALIASES: Record<string, string> = {
  'gpt-image-1':      'gpt-image-2',       // Matt's 2026-07-15 correction
  'veo-3-fast':       'veo-3-1-fast',      // Removed per spec; fall back to 3.1 Fast
  'seedance-2-pro':   'seedance-2',        // Renamed and unified
};

export function resolveFalModelId(id: string | undefined | null): string | null {
  if (!id) return null;
  if (MODEL_INDEX.has(id)) return id;
  const aliased = MODEL_ID_ALIASES[id];
  if (aliased && MODEL_INDEX.has(aliased)) return aliased;
  return null;
}
