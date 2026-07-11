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
      // Ref inputs are dynamic — Nano Banana Pro (and some others) accept
      // multiple reference images. Inspector's +/− stepper drives
      // data.refCount; 1..6. The FIRST ref keeps the legacy id `ref` so
      // existing saved graphs (which wired to `ref`) don't lose their edge
      // on load. Additional refs use `ref1`, `ref2`, …
      const refCount = clampInt((data?.refCount as number) ?? 1, 1, 6);
      const ports: NodePort[] = [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
      ];
      for (let i = 0; i < refCount; i++) {
        const id = i === 0 ? 'ref' : `ref${i}`;
        const label = refCount === 1 ? 'ref (opt.)' : `ref ${i + 1}`;
        ports.push({ id, side: 'in', dataType: 'image', label });
      }
      ports.push({ id: 'out', side: 'out', dataType: 'image', label: 'image' });
      return ports;
    }
    case 'movie-gen':
      return [
        { id: 'prompt', side: 'in', dataType: 'text', label: 'prompt' },
        { id: 'first', side: 'in', dataType: 'image', label: 'first frame (opt.)' },
        { id: 'out', side: 'out', dataType: 'video', label: 'video' },
      ];
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
    case 'panel-ref':
      return [
        { id: 'out', side: 'out', dataType: 'image', label: 'panel image' },
      ];
    case 'custom-fal':
      return [
        { id: 'in', side: 'in', dataType: 'any', label: 'in' },
        { id: 'out', side: 'out', dataType: 'any', label: 'out' },
      ];
  }
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
      };
    case 'out':
      return {};
    case 'switch':
      return { count: 2, selected: 0 };
    case 'null-node':
      return {};
    case 'prompt-concat':
      return { count: 2, separator: ' ' };
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
      return { endpoint: '' };
  }
}

// ---------------------------------------------------------------------------
// Seeded default graph — 3-node chain used when a Panel opens the editor for
// the first time (no saved graph yet). Positions are laid out left→right so
// the seeded chain reads like a pipeline.
// ---------------------------------------------------------------------------

export function seedDefaultGraph(prompt: string, seedImageDataUrl?: string): NodeGraph {
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
