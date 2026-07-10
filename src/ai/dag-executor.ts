// Boardfish 5 — DAG executor.
//
// Given a NodeGraph, topo-sort it, then walk each node and dispatch on kind.
// Text nodes are pure. Image/movie/custom-fal nodes call `runFalJob()` via the
// local ai-proxy. FAL-CDN URLs get inlined to data URLs so the .boardfish zip
// is self-contained.
//
// The parallel subagent owns `src/nodes/types.ts`. At the time this file was
// written that file may not exist yet, so we declare a **local minimal shape**
// of NodeGraph / BaseNode / NodeId here. When the real types land, swap:
//
//     import type { NodeGraph, BaseNode, NodeId } from '../nodes/types';
//
// and delete the local declarations below. The runtime shape assumed here
// (id / kind / data / output, plus a flat edges array of {from, to}) matches
// what the design brief specifies.
//
// TODO(wozbot): replace local types with `import type ... from '../nodes/types'`
// once the parallel node-editor subagent lands `src/nodes/types.ts`.
//
// TODO(wozbot): unit test — vitest isn't in the current package.json and
// adding a `.test.ts` would need a runner + tsx/ts-node setup. When we add
// vitest, cover at minimum:
//   1. topoSort() orders a diamond A -> {B,C} -> D correctly.
//   2. subgraphFor(startAt) collects startAt + descendants + ancestors.
//   3. A text-prompt -> image-gen -> out chain populates the Out node's
//      dataUrl using a mocked runFalJob + urlToDataUrl.

import {
  runFalJob,
  extractImageUrl,
  extractVideoUrl,
  urlToDataUrl,
} from './client';
import { getFalModel } from './fal-models';

// ---------- Local minimal type fallbacks ----------

export type NodeId = string;

export type NodeKind =
  | 'text-prompt'
  | 'image-gen'
  | 'movie-gen'
  | 'out'
  | 'switch'
  | 'null-node'
  | 'prompt-concat'
  | 'custom-fal';

// Output shape stored on each node after execution. The real BaseNode.output
// will be broader than this; we use a permissive shape so we can attach the
// fields we care about without fighting the type system.
export type NodeOutput = {
  kind?: 'text' | 'image' | 'video' | 'unknown';
  text?: string;
  dataUrl?: string;
  mime?: string;
  sourceUrl?: string;   // original FAL CDN URL, before data-URL inlining
  requestId?: string;   // FAL request id for debugging
  error?: string;
  updatedAt?: number;
};

export type BaseNode = {
  id: NodeId;
  kind: NodeKind;
  data: Record<string, unknown>;
  output?: NodeOutput;
  // The real BaseNode will carry more fields (position, label, etc). We only
  // touch id / kind / data / output here.
};

export type NodeEdge = {
  id?: string;
  from: NodeId;          // source node id
  to: NodeId;            // target node id
  fromPort?: string;     // optional named output port
  toPort?: string;       // optional named input port
};

export type NodeGraph = {
  nodes: BaseNode[];
  edges: NodeEdge[];
};

// ---------- Public API ----------

export type ExecutionEvent =
  | { kind: 'started';  nodeId: NodeId }
  | { kind: 'progress'; nodeId: NodeId; message: string }
  | { kind: 'output';   nodeId: NodeId; output: NodeOutput }
  | { kind: 'failed';   nodeId: NodeId; error: string }
  | { kind: 'done';     graph: NodeGraph };

export type ExecuteOpts = {
  // If startAt is given, only execute that node + its downstream dependents.
  // Ancestors of startAt are included so their outputs can be resolved as
  // inputs, but ancestors that already have a valid cached `output` are
  // skipped (not re-run). If omitted, execute the whole graph.
  startAt?: NodeId;
  onEvent?: (e: ExecutionEvent) => void;
  signal?: AbortSignal;
};

// Runs the graph. Returns a shallow-cloned graph with per-node outputs
// populated. Never mutates the caller's graph in place.
export async function executeGraph(
  graph: NodeGraph,
  opts: ExecuteOpts = {},
): Promise<NodeGraph> {
  const { startAt, onEvent, signal } = opts;

  // Shallow-clone nodes so we can attach outputs without mutating input.
  const nodesById = new Map<NodeId, BaseNode>();
  for (const n of graph.nodes) {
    nodesById.set(n.id, { ...n, data: { ...n.data }, output: n.output ? { ...n.output } : undefined });
  }
  const edges = graph.edges.slice();

  // Build adjacency + reverse adjacency.
  const outgoing = new Map<NodeId, NodeEdge[]>();
  const incoming = new Map<NodeId, NodeEdge[]>();
  for (const id of nodesById.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of edges) {
    if (!nodesById.has(e.from) || !nodesById.has(e.to)) continue; // dangling edge
    outgoing.get(e.from)!.push(e);
    incoming.get(e.to)!.push(e);
  }

  // Decide which nodes participate in this run.
  const participants: Set<NodeId> = startAt
    ? subgraphFor(startAt, outgoing, incoming, nodesById)
    : new Set(nodesById.keys());

  // Topo sort just the participating nodes.
  const order = topoSort(participants, incoming);

  // Track which nodes should actually be *executed* (vs. just used as cached
  // upstream inputs). If startAt is given, ancestors with a valid cached
  // output are not re-run; but startAt itself and everything downstream is.
  const toExecute = new Set<NodeId>();
  if (startAt) {
    const downstream = descendantsOf(startAt, outgoing);
    downstream.add(startAt);
    for (const id of downstream) toExecute.add(id);
    // Ancestors: only execute if they have no cached output.
    for (const id of participants) {
      if (toExecute.has(id)) continue;
      const n = nodesById.get(id)!;
      if (!hasValidOutput(n)) toExecute.add(id);
    }
  } else {
    for (const id of participants) toExecute.add(id);
  }

  for (const nodeId of order) {
    if (signal?.aborted) {
      throw new DOMException('Execution aborted', 'AbortError');
    }
    if (!toExecute.has(nodeId)) continue;

    const node = nodesById.get(nodeId)!;
    onEvent?.({ kind: 'started', nodeId });

    try {
      const inputs = collectInputs(nodeId, incoming, nodesById);
      const output = await runNode(node, inputs, {
        onProgress: (message) =>
          onEvent?.({ kind: 'progress', nodeId, message }),
        signal,
      });
      node.output = { ...output, updatedAt: Date.now() };
      onEvent?.({ kind: 'output', nodeId, output: node.output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      node.output = { kind: 'unknown', error: message, updatedAt: Date.now() };
      onEvent?.({ kind: 'failed', nodeId, error: message });
      // Fail-fast: downstream nodes have no meaningful input.
      throw err;
    }
  }

  const nextGraph: NodeGraph = {
    nodes: Array.from(nodesById.values()),
    edges,
  };
  onEvent?.({ kind: 'done', graph: nextGraph });
  return nextGraph;
}

// ---------- Graph helpers ----------

function subgraphFor(
  startAt: NodeId,
  outgoing: Map<NodeId, NodeEdge[]>,
  incoming: Map<NodeId, NodeEdge[]>,
  nodesById: Map<NodeId, BaseNode>,
): Set<NodeId> {
  const set = new Set<NodeId>();
  if (!nodesById.has(startAt)) return set;
  // startAt + all descendants
  const stack: NodeId[] = [startAt];
  while (stack.length) {
    const id = stack.pop()!;
    if (set.has(id)) continue;
    set.add(id);
    for (const e of outgoing.get(id) ?? []) {
      if (!set.has(e.to)) stack.push(e.to);
    }
  }
  // + all ancestors (needed to resolve inputs)
  const ancStack: NodeId[] = [startAt];
  while (ancStack.length) {
    const id = ancStack.pop()!;
    for (const e of incoming.get(id) ?? []) {
      if (!set.has(e.from)) {
        set.add(e.from);
        ancStack.push(e.from);
      }
    }
  }
  return set;
}

function descendantsOf(
  startAt: NodeId,
  outgoing: Map<NodeId, NodeEdge[]>,
): Set<NodeId> {
  const set = new Set<NodeId>();
  const stack: NodeId[] = [];
  for (const e of outgoing.get(startAt) ?? []) stack.push(e.to);
  while (stack.length) {
    const id = stack.pop()!;
    if (set.has(id)) continue;
    set.add(id);
    for (const e of outgoing.get(id) ?? []) {
      if (!set.has(e.to)) stack.push(e.to);
    }
  }
  return set;
}

// Kahn's algorithm restricted to a set of participating node ids.
function topoSort(
  participants: Set<NodeId>,
  incoming: Map<NodeId, NodeEdge[]>,
): NodeId[] {
  const remainingIn = new Map<NodeId, number>();
  for (const id of participants) {
    const inc = (incoming.get(id) ?? []).filter((e) => participants.has(e.from));
    remainingIn.set(id, inc.length);
  }
  const ready: NodeId[] = [];
  for (const [id, n] of remainingIn) if (n === 0) ready.push(id);

  const outgoingByFrom = new Map<NodeId, NodeId[]>();
  for (const id of participants) outgoingByFrom.set(id, []);
  for (const id of participants) {
    for (const e of incoming.get(id) ?? []) {
      if (participants.has(e.from)) outgoingByFrom.get(e.from)!.push(id);
    }
  }

  const order: NodeId[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const t of outgoingByFrom.get(id) ?? []) {
      const r = (remainingIn.get(t) ?? 0) - 1;
      remainingIn.set(t, r);
      if (r === 0) ready.push(t);
    }
  }

  if (order.length !== participants.size) {
    throw new Error(
      `DAG has a cycle — resolved ${order.length}/${participants.size} nodes before stalling.`,
    );
  }
  return order;
}

function hasValidOutput(n: BaseNode): boolean {
  const o = n.output;
  if (!o) return false;
  if (o.error) return false;
  return Boolean(o.text || o.dataUrl);
}

// ---------- Input resolution ----------

// The DAG uses a flat edges array. We treat any incoming edge as a valid
// upstream input. For dispatch we categorize upstreams by output kind.
type ResolvedInputs = {
  texts: string[];      // text outputs, in edge order
  images: string[];     // image data URLs, in edge order
  videos: string[];     // video data URLs, in edge order
  urls: string[];       // original source URLs (before dataURL inlining)
  // Named ports (if the graph uses them). Useful for switch's a/b/on.
  byPort: Record<string, NodeOutput | undefined>;
};

function collectInputs(
  nodeId: NodeId,
  incoming: Map<NodeId, NodeEdge[]>,
  nodesById: Map<NodeId, BaseNode>,
): ResolvedInputs {
  const inc = incoming.get(nodeId) ?? [];
  const inputs: ResolvedInputs = {
    texts: [],
    images: [],
    videos: [],
    urls: [],
    byPort: {},
  };
  for (const e of inc) {
    const src = nodesById.get(e.from);
    if (!src?.output) continue;
    const o = src.output;
    if (e.toPort) inputs.byPort[e.toPort] = o;
    if (o.text) inputs.texts.push(o.text);
    if (o.dataUrl) {
      if (o.kind === 'video') inputs.videos.push(o.dataUrl);
      else if (o.kind === 'image') inputs.images.push(o.dataUrl);
      else {
        // Best-effort inference from MIME.
        if ((o.mime ?? '').startsWith('video/')) inputs.videos.push(o.dataUrl);
        else inputs.images.push(o.dataUrl);
      }
    }
    if (o.sourceUrl) inputs.urls.push(o.sourceUrl);
  }
  return inputs;
}

// ---------- Per-node runners ----------

type RunCtx = {
  onProgress: (message: string) => void;
  signal?: AbortSignal;
};

async function runNode(
  node: BaseNode,
  inputs: ResolvedInputs,
  ctx: RunCtx,
): Promise<NodeOutput> {
  switch (node.kind) {
    case 'text-prompt':      return runTextPrompt(node);
    case 'prompt-concat':    return runPromptConcat(node, inputs);
    case 'null-node':        return runNullNode(inputs);
    case 'switch':           return runSwitch(node, inputs);
    case 'image-gen':        return runImageGen(node, inputs, ctx);
    case 'movie-gen':        return runMovieGen(node, inputs, ctx);
    case 'out':              return runOut(inputs);
    case 'custom-fal':       return runCustomFal(node, ctx);
    default: {
      // Exhaustiveness guard without using `never` (keeps things loose in case
      // the parallel subagent introduces new node kinds).
      throw new Error(`Unknown node kind: ${String((node as BaseNode).kind)}`);
    }
  }
}

function runTextPrompt(node: BaseNode): NodeOutput {
  const text = String((node.data as { text?: unknown }).text ?? '');
  return { kind: 'text', text };
}

function runPromptConcat(node: BaseNode, inputs: ResolvedInputs): NodeOutput {
  const sep = typeof (node.data as { separator?: unknown }).separator === 'string'
    ? String((node.data as { separator?: unknown }).separator)
    : ' \u00b7 '; // " · " default
  const own = typeof (node.data as { text?: unknown }).text === 'string'
    ? String((node.data as { text?: unknown }).text)
    : '';
  const parts = [...inputs.texts];
  if (own) parts.push(own);
  return { kind: 'text', text: parts.filter(Boolean).join(sep) };
}

function runNullNode(inputs: ResolvedInputs): NodeOutput {
  // Pure passthrough: prefer video, then image, then text.
  if (inputs.videos[0]) return { kind: 'video', dataUrl: inputs.videos[0], mime: 'video/mp4' };
  if (inputs.images[0]) return { kind: 'image', dataUrl: inputs.images[0], mime: 'image/png' };
  if (inputs.texts.length) return { kind: 'text', text: inputs.texts.join('\n') };
  return { kind: 'unknown' };
}

function runSwitch(node: BaseNode, inputs: ResolvedInputs): NodeOutput {
  const on = Boolean((node.data as { on?: unknown }).on);
  // Prefer named ports "a" / "b" if the graph uses them; otherwise fall back
  // to the first two incoming edges (order = a, b).
  const a = inputs.byPort['a'];
  const b = inputs.byPort['b'];
  if (a || b) {
    return (on ? b : a) ?? { kind: 'unknown' };
  }
  // Fallback: use whichever collection has 2 items.
  const pool: NodeOutput[] = [];
  if (inputs.videos.length >= 2) {
    return { kind: 'video', dataUrl: on ? inputs.videos[1] : inputs.videos[0], mime: 'video/mp4' };
  }
  if (inputs.images.length >= 2) {
    return { kind: 'image', dataUrl: on ? inputs.images[1] : inputs.images[0], mime: 'image/png' };
  }
  if (inputs.texts.length >= 2) {
    return { kind: 'text', text: on ? inputs.texts[1] : inputs.texts[0] };
  }
  // Only one input available — return it.
  if (inputs.videos[0]) return { kind: 'video', dataUrl: inputs.videos[0], mime: 'video/mp4' };
  if (inputs.images[0]) return { kind: 'image', dataUrl: inputs.images[0], mime: 'image/png' };
  if (inputs.texts[0]) return { kind: 'text', text: inputs.texts[0] };
  return { kind: 'unknown', ...(pool[0] ?? {}) };
}

function runOut(inputs: ResolvedInputs): NodeOutput {
  // Passthrough: mirrors the final asset so the NodeEditor can find "the
  // final image / video" by walking to Out nodes.
  if (inputs.videos[0]) {
    return { kind: 'video', dataUrl: inputs.videos[0], mime: 'video/mp4' };
  }
  if (inputs.images[0]) {
    return { kind: 'image', dataUrl: inputs.images[0], mime: 'image/png' };
  }
  if (inputs.texts.length) {
    return { kind: 'text', text: inputs.texts.join('\n') };
  }
  return { kind: 'unknown' };
}

async function runImageGen(
  node: BaseNode,
  inputs: ResolvedInputs,
  ctx: RunCtx,
): Promise<NodeOutput> {
  const modelId = String((node.data as { modelId?: unknown }).modelId ?? '');
  if (!modelId) throw new Error('image-gen node has no modelId set.');
  const model = getFalModel(modelId);
  if (!model) throw new Error(`Unknown FAL model: ${modelId}`);
  if (model.kind !== 'image') {
    throw new Error(`Model ${modelId} is a ${model.kind} model, not image.`);
  }
  if (model.status === 'coming-soon') {
    throw new Error(`Model ${modelId} (${model.label}) is not yet available.`);
  }

  const payload = buildFalInput(node, inputs, model.supportsPrompt);
  ctx.onProgress(`Submitting to ${model.label} (${model.endpoint})…`);
  const res = await runFalJob(model.endpoint, payload);
  ctx.onProgress('FAL job complete, downloading image…');

  const imgUrl = extractImageUrl(res.result);
  if (!imgUrl) {
    throw new Error(`Could not find an image URL in ${model.label} response.`);
  }
  const { dataUrl, mime } = await urlToDataUrl(imgUrl);
  return {
    kind: 'image',
    dataUrl,
    mime,
    sourceUrl: imgUrl,
    requestId: res.requestId,
  };
}

async function runMovieGen(
  node: BaseNode,
  inputs: ResolvedInputs,
  ctx: RunCtx,
): Promise<NodeOutput> {
  const modelId = String((node.data as { modelId?: unknown }).modelId ?? '');
  if (!modelId) throw new Error('movie-gen node has no modelId set.');
  const model = getFalModel(modelId);
  if (!model) throw new Error(`Unknown FAL model: ${modelId}`);
  if (model.kind !== 'video') {
    throw new Error(`Model ${modelId} is a ${model.kind} model, not video.`);
  }
  if (model.status === 'coming-soon') {
    throw new Error(`Model ${modelId} (${model.label}) is not yet available.`);
  }

  const payload = buildFalInput(node, inputs, model.supportsPrompt);
  ctx.onProgress(`Submitting to ${model.label} (${model.endpoint})…`);
  const res = await runFalJob(model.endpoint, payload);
  ctx.onProgress('FAL job complete, downloading video…');

  const vidUrl = extractVideoUrl(res.result);
  if (!vidUrl) {
    throw new Error(`Could not find a video URL in ${model.label} response.`);
  }
  const { dataUrl, mime } = await urlToDataUrl(vidUrl);
  return {
    kind: 'video',
    dataUrl,
    mime,
    sourceUrl: vidUrl,
    requestId: res.requestId,
  };
}

async function runCustomFal(node: BaseNode, ctx: RunCtx): Promise<NodeOutput> {
  const endpoint = String((node.data as { endpoint?: unknown }).endpoint ?? '');
  const input = (node.data as { input?: unknown }).input;
  if (!endpoint) throw new Error('custom-fal node has no endpoint set.');
  const inputObj: Record<string, unknown> =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  ctx.onProgress(`Submitting to ${endpoint}…`);
  const res = await runFalJob(endpoint, inputObj);
  ctx.onProgress('FAL job complete.');

  // Guess whether the result is an image or a video and inline it if we can.
  const vidUrl = extractVideoUrl(res.result);
  if (vidUrl) {
    const { dataUrl, mime } = await urlToDataUrl(vidUrl);
    return {
      kind: 'video',
      dataUrl,
      mime,
      sourceUrl: vidUrl,
      requestId: res.requestId,
    };
  }
  const imgUrl = extractImageUrl(res.result);
  if (imgUrl) {
    const { dataUrl, mime } = await urlToDataUrl(imgUrl);
    return {
      kind: 'image',
      dataUrl,
      mime,
      sourceUrl: imgUrl,
      requestId: res.requestId,
    };
  }
  // No recognisable asset URL — return the raw result as JSON text so the
  // user can see what came back.
  return {
    kind: 'unknown',
    text: JSON.stringify(res.result, null, 2),
    requestId: res.requestId,
  };
}

// Build the FAL input payload from a node's `data` (spread verbatim) plus
// upstream text (concatenated) as `prompt` if the model wants one and there
// isn't a manually-set one. Also injects `image_url` from an upstream image
// if the node doesn't have its own image_url set.
function buildFalInput(
  node: BaseNode,
  inputs: ResolvedInputs,
  supportsPrompt: boolean,
): Record<string, unknown> {
  // Copy everything from `data` except the meta-fields we know about.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.data)) {
    if (k === 'modelId') continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }

  if (supportsPrompt) {
    const upstreamPrompt = inputs.texts.join(' ').trim();
    const existing = typeof out.prompt === 'string' ? out.prompt : '';
    if (upstreamPrompt && !existing) out.prompt = upstreamPrompt;
    else if (upstreamPrompt && existing) out.prompt = `${existing} ${upstreamPrompt}`.trim();
  }

  // Inject upstream image as image_url if not already set.
  if (!out.image_url && inputs.images[0]) {
    out.image_url = inputs.images[0];
  }

  return out;
}
