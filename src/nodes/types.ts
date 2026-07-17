// Boardfish 5 — Node Editor type system
//
// The editor stores a graph of nodes + edges plus a viewport (pan/zoom). Each
// node has:
//   - a `kind` that selects its rendering + inspector via NODE_KINDS registry
//   - a `data` bag with kind-specific config (prompt text, model id, etc.)
//   - a static/dynamic port list (per-kind; recomputed on demand for kinds
//     with variable fan-in like prompt-concat)
//   - an optional `output` snapshot from the most recent execution
//
// Coords are canvas coords, NOT screen coords. Screen-to-canvas conversion
// happens once in NodeEditor via the (panOffset, zoom) transform.

import { getFalModel, resolveFalModelId } from '../ai/fal-models';

export type NodeId = string;
export type PortId = string;

// All node kinds supported by the editor.
//
// - text-prompt / image-gen / out are the default seeded chain
// - switch chooses between multiple upstream inputs
// - null-node barrels its single input straight through (useful for keeping
//   long chains tidy)
// - prompt-concat merges N text inputs into one text output
// - movie-gen and custom-fal are Phase B/2 stubs — registered so graphs
//   can round-trip, but no executor / UI beyond a "coming soon" preview
export type NodeKind =
  | 'text-prompt'
  | 'image-gen'
  | 'movie-gen'
  | 'out'
  | 'switch'
  | 'null-node'
  | 'prompt-concat'
  | 'prompt-enhancer'
  | 'llm-run'
  | 'image-describer'
  | 'video-describer'
  | 'panel-ref'
  | 'custom-fal';

export type PortDataType = 'text' | 'image' | 'video' | 'any';

export type NodePort = {
  id: PortId;
  side: 'in' | 'out';
  dataType: PortDataType;
  label: string;
};

export type NodeOutput = {
  kind: 'text' | 'image' | 'video';
  // For image/video, a data URL (base64) or a fetched-URL cache key. The
  // executor is responsible for materializing remote FAL results into a
  // dataUrl before caching here so downstream nodes have local bytes.
  dataUrl?: string;
  // For text.
  text?: string;
  mime?: string;
  generatedAt?: number;
};

// -----------------------------------------------------------------------
// Internal `data` piggy-back keys (all prefixed with `__` so kind-specific
// fields never collide). These live on `BaseNode.data` so the existing
// UPDATE_NODE_DATA reducer path can persist them without new actions:
//
//   __size:    { width, height }  — explicit size override from resize
//                                    handle (graph-utils.readNodeSize).
//   __history: NodeOutput[]        — prior generations for this node,
//                                    oldest first, unbounded (see appendHistory)
//                                    (graph-utils.appendHistory).
//   __runtime: unknown             — reserved for transient exec state.
//
// XML export skips all of these; see graph-utils.graphToXml.
// -----------------------------------------------------------------------

export type BaseNode = {
  id: NodeId;
  kind: NodeKind;
  // Canvas coordinates (pre-zoom, pre-pan). Top-left corner of the node.
  x: number;
  y: number;
  // Optional size override. If absent, defaults come from NODE_KINDS.
  width?: number;
  height?: number;
  // Port list. Static per-kind for most, but stored so the renderer + wiring
  // code can iterate cheaply without re-invoking the registry every frame.
  // For dynamic-port kinds (prompt-concat), whoever mutates data should also
  // refresh ports via `NODE_KINDS[kind].ports(data)`.
  ports: NodePort[];
  // Per-kind config. Free-form; the Inspector knows what to look for.
  data: Record<string, unknown>;
  // Last executed output snapshot, if any.
  output?: NodeOutput;
};

export type Edge = {
  id: string;
  from: { nodeId: NodeId; portId: PortId };
  to: { nodeId: NodeId; portId: PortId };
};

export type NodeGraph = {
  nodes: BaseNode[];
  edges: Edge[];
  panOffset: { x: number; y: number };
  zoom: number;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

let _idCounter = 0;

/** Short, human-readable id. Not cryptographically strong; graphs are local. */
export function newId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

export function emptyGraph(): NodeGraph {
  return {
    nodes: [],
    edges: [],
    panOffset: { x: 0, y: 0 },
    zoom: 1,
  };
}

// ---------------------------------------------------------------------------
// Default port layouts (kept here rather than in registry.ts to avoid a
// circular import; the registry uses these when building per-kind defs).
// ---------------------------------------------------------------------------

/** Default ports for each kind. `prompt-concat` uses its data.count instead. */
export function defaultPortsFor(kind: NodeKind, data?: Record<string, unknown>): NodePort[] {
  switch (kind) {
    case 'text-prompt':
      return [
        { id: 'out', side: 'out', dataType: 'text', label: 'text' },
      ];
    case 'image-gen': {
      // Ref inputs are dynamic. Model may declare either:
      //   (a) refPorts: distinct named ports (e.g. first/last frame). Executor
      //       routes each port's image to that port's falKey.
      //   (b) maxRefInputs (or generic): a variable-count list; the +/−
      //       stepper in the Inspector drives data.refCount within [1..cap].
      // Legacy fallback: single 'ref' port.
      const model = getFalModelForData(data);
      const ports: NodePort[] = [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
      ];
      if (model?.refPorts && model.refPorts.length > 0) {
        for (const rp of model.refPorts) {
          ports.push({ id: rp.portId, side: 'in', dataType: 'image', label: rp.label });
        }
      } else {
        const cap = clampInt(model?.maxRefInputs ?? 6, 1, 9);
        const refCount = clampInt((data?.refCount as number) ?? 1, 1, cap);
        for (let i = 0; i < refCount; i++) {
          const id = i === 0 ? 'ref' : `ref${i}`;
          const label = refCount === 1 ? 'ref (opt.)' : `ref ${i + 1}`;
          ports.push({ id, side: 'in', dataType: 'image', label });
        }
      }
      ports.push({ id: 'out', side: 'out', dataType: 'image', label: 'image' });
      return ports;
    }
    case 'movie-gen': {
      // Model may declare refPorts (Veo 3.1 FLF: first + last) OR a
      // maxRefInputs count (Seedance 2 Reference: up to 9). Default is a
      // single optional 'first' frame port.
      const model = getFalModelForData(data);
      const ports: NodePort[] = [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
      ];
      if (model?.refPorts && model.refPorts.length > 0) {
        for (const rp of model.refPorts) {
          ports.push({ id: rp.portId, side: 'in', dataType: 'image', label: rp.label });
        }
      } else if (model?.maxRefInputs && model.maxRefInputs > 1) {
        const cap = clampInt(model.maxRefInputs, 1, 9);
        const refCount = clampInt((data?.refCount as number) ?? 1, 1, cap);
        for (let i = 0; i < refCount; i++) {
          const id = i === 0 ? 'first' : `ref${i}`;
          const label = refCount === 1 ? 'first frame (opt.)' : `ref ${i + 1}`;
          ports.push({ id, side: 'in', dataType: 'image', label });
        }
      } else {
        // Legacy default: single 'first' frame.
        ports.push({ id: 'first', side: 'in', dataType: 'image', label: 'first frame (opt.)' });
      }
      ports.push({ id: 'out', side: 'out', dataType: 'video', label: 'video' });
      return ports;
    }
    case 'out':
      return [
        { id: 'in', side: 'in', dataType: 'any', label: 'panel image' },
      ];
    case 'switch': {
      const count = clampInt((data?.count as number) ?? 2, 2, 6);
      const ins: NodePort[] = [];
      for (let i = 0; i < count; i++) {
        ins.push({ id: `in${i}`, side: 'in', dataType: 'any', label: `in ${i + 1}` });
      }
      ins.push({ id: 'out', side: 'out', dataType: 'any', label: 'out' });
      return ins;
    }
    case 'null-node':
      return [
        { id: 'in', side: 'in', dataType: 'any', label: 'in' },
        { id: 'out', side: 'out', dataType: 'any', label: 'out' },
      ];
    case 'prompt-concat': {
      // Concat supports 2–8 input ports (bumped from 6). The Inspector's
      // +/− stepper is bound to the same range.
      const count = clampInt((data?.count as number) ?? 2, 2, 8);
      const ins: NodePort[] = [];
      for (let i = 0; i < count; i++) {
        ins.push({ id: `in${i}`, side: 'in', dataType: 'text', label: `text ${i + 1}` });
      }
      ins.push({ id: 'out', side: 'out', dataType: 'text', label: 'text' });
      return ins;
    }
    case 'prompt-enhancer':
      // Takes one text prompt in, emits one (enhanced) text prompt out.
      // Enhancement instructions + model live in `data`, not on the wire.
      return [
        { id: 'in', side: 'in', dataType: 'text', label: 'prompt' },
        { id: 'out', side: 'out', dataType: 'text', label: 'enhanced' },
      ];
    case 'llm-run':
      // General-purpose LLM call. Text-in, text-out with an optional image
      // reference (vision). Systems/user prompt style is folded into a
      // single request server-side.
      return [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
        { id: 'image', side: 'in', dataType: 'image', label: 'image (opt.)' },
        { id: 'out', side: 'out', dataType: 'text', label: 'text' },
      ];
    case 'image-describer':
      // Vision → prompt. One image in, one text prompt out.
      return [
        { id: 'image', side: 'in', dataType: 'image', label: 'image' },
        { id: 'out', side: 'out', dataType: 'text', label: 'prompt' },
      ];
    case 'video-describer':
      // Vision (video) → prompt. One video in, one text prompt out.
      return [
        { id: 'video', side: 'in', dataType: 'video', label: 'video' },
        { id: 'out', side: 'out', dataType: 'text', label: 'prompt' },
      ];
    case 'panel-ref':
      return [
        { id: 'out', side: 'out', dataType: 'image', label: 'panel image' },
      ];
    case 'custom-fal':
      return [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
        { id: 'image', side: 'in', dataType: 'image', label: 'image' },
        { id: 'out', side: 'out', dataType: 'any', label: 'out' },
      ];
  }
}

// Given a node's data blob, resolve its modelId (via alias map) and look up
// the FAL model registry. Returns null when the node has no modelId or the
// id doesn't match any registered model. Kept internal to this module so the
// port fn can peek at model.refPorts / model.maxRefInputs.
function getFalModelForData(data?: Record<string, unknown>) {
  const raw = typeof data?.modelId === 'string' ? (data.modelId as string) : '';
  if (!raw) return null;
  const resolved = resolveFalModelId(raw) ?? raw;
  return getFalModel(resolved);
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(Number.isFinite(n) ? n : lo);
  return Math.max(lo, Math.min(hi, v));
}

/** Default data blob per kind. Kept centralized so registry + seeding match. */
export function defaultDataFor(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case 'text-prompt':
      return { text: '' };
    case 'image-gen':
      return {
        // Field names align with dag-executor: modelId + aspect_ratio + num_images.
        // FAL's Nano Banana Pro (and most image endpoints) accept these directly.
        modelId: 'nano-banana-pro',
        aspect_ratio: '16:9',
        num_images: 1,
      };
    case 'movie-gen':
      return {
        modelId: 'veo-3',
        aspect_ratio: '16:9',
        // Veo 3 wants a string enum ("4s"/"6s"/"8s"); Kling/Seedance execute
        // via a per-model select/number coercion in the executor.
        duration: '8s',
        // Variants: default 1. Executor fires N parallel FAL jobs.
        num_videos: 1,
      };
    case 'out':
      return {};
    case 'switch':
      return { count: 2, selected: 0 };
    case 'null-node':
      return {};
    case 'prompt-concat':
      return { count: 2, separator: ' ' };
    case 'prompt-enhancer':
      return {
        // modelId is a canonical OpenClaw model catalog id (e.g.
        // 'claude-opus-4-7', 'gpt-5.2'). Empty string means "server picks
        // its default text model" (whatever the proxy's LLM_DEFAULT_MODEL
        // env var / catalog default resolves to).
        modelId: '',
        // Sensible default instructions — user can override in the Inspector.
        instructions:
          'Rewrite the following prompt to be more vivid and specific for a text-to-image model. Preserve the original intent. Add concrete visual detail (subject, setting, lighting, camera, mood). Return ONLY the rewritten prompt — no preamble, no quotes, no explanation.',
      };
    case 'llm-run':
      return {
        modelId: '',
        // Optional system-style guidance concatenated with the upstream
        // prompt text on the server. Empty by default → the upstream
        // prompt is sent verbatim.
        instructions: '',
      };
    case 'image-describer':
      return {
        modelId: '',
        instructions:
          'Describe this image as a detailed text-to-image prompt. Cover subject, composition, lighting, palette, style, mood, and camera. Return ONLY the prompt — no preamble, no quotes.',
      };
    case 'video-describer':
      return {
        modelId: '',
        instructions:
          'Describe this video as a detailed text-to-video prompt. Cover subject, action/motion, camera movement, setting, lighting, palette, style, mood, and pacing. Return ONLY the prompt — no preamble, no quotes.',
      };
    case 'panel-ref':
      return {
        // Which storyboard panel this node points at (looked up by id at
        // pick time). imageDataUrl is snapshotted so the graph runs even
        // if the panel's live image later changes.
        panelId: '',
        panelLabel: '',
        imageDataUrl: '',
      };
    case 'custom-fal':
      return {
        // fal.ai endpoint slug, e.g. "fal-ai/flux-pro/v1.1" or
        // "fal-ai/kling-video/v2.1/master/image-to-video".
        endpoint: '',
        // Free-form JSON payload merged into the FAL job input. Upstream
        // text (prompt port) becomes `prompt` and upstream image (image
        // port) becomes `image_url` unless overridden here.
        inputJson: '{}',
        // Optional: override which key upstream image maps to. Some models
        // want `image_urls` (array) or `first_frame_image`, etc.
        imageKey: 'image_url',
      };
  }
}

// ---------------------------------------------------------------------------
// Seeded default graph — 3-node chain used when a Panel opens the editor for
// the first time (no saved graph yet). Positions are laid out left→right so
// the seeded chain reads like a pipeline.
// ---------------------------------------------------------------------------

export function seedDefaultGraph(
  prompt: string,
  seedImageDataUrl?: string,
  /**
   * Optional prior generations (oldest→newest) to seed onto the ImageGen
   * node's `__history`. Used to import the storyboard panel's imageHistory
   * into the auto-flow so 'default flow' users don't lose their earlier gens.
   * The current (=most recent) gen is `seedImageDataUrl` and lives on the
   * ImageGen node's `output`; these are the ones BEFORE that.
   */
  imageGenHistory?: NodeOutput[],
): NodeGraph {
  const promptNode: BaseNode = {
    id: newId('n'),
    kind: 'text-prompt',
    x: 80,
    y: 120,
    ports: defaultPortsFor('text-prompt'),
    data: { ...defaultDataFor('text-prompt'), text: prompt },
  };
  // If the panel already has an image, seed the ImageGen node with it as an
  // image-to-image reference (image_url is Nano Banana's edit input). We also
  // pre-populate the node's `output` field so the node's preview shows the
  // image immediately on open, without needing to hit Generate first.
  const genData: Record<string, unknown> = { ...defaultDataFor('image-gen') };
  if (seedImageDataUrl) genData.image_url = seedImageDataUrl;
  if (imageGenHistory && imageGenHistory.length > 0) {
    // Store as internal history piggy-back. `graph-utils.readNodeHistory`
    // reads this. Kept oldest→newest to match the rest of the codebase.
    (genData as Record<string, unknown>).__history = imageGenHistory;
  }
  const genNode: BaseNode = {
    id: newId('n'),
    kind: 'image-gen',
    x: 380,
    y: 120,
    ports: defaultPortsFor('image-gen'),
    data: genData,
    output: seedImageDataUrl
      ? { kind: 'image', dataUrl: seedImageDataUrl, mime: 'image/jpeg', generatedAt: Date.now() }
      : undefined,
  };
  const outNode: BaseNode = {
    id: newId('n'),
    kind: 'out',
    x: 720,
    y: 120,
    ports: defaultPortsFor('out'),
    data: defaultDataFor('out'),
    output: seedImageDataUrl
      ? { kind: 'image', dataUrl: seedImageDataUrl, mime: 'image/jpeg', generatedAt: Date.now() }
      : undefined,
  };
  const edges: Edge[] = [
    {
      id: newId('e'),
      from: { nodeId: promptNode.id, portId: 'out' },
      to: { nodeId: genNode.id, portId: 'prompt' },
    },
    {
      id: newId('e'),
      from: { nodeId: genNode.id, portId: 'out' },
      to: { nodeId: outNode.id, portId: 'in' },
    },
  ];
  return {
    nodes: [promptNode, genNode, outNode],
    edges,
    panOffset: { x: 0, y: 0 },
    zoom: 1,
  };
}
