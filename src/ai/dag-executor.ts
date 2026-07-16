// Boardfish 5 — DAG executor.
//
// Given a NodeGraph, topo-sort it, then walk each node and dispatch on kind.
// Text nodes are pure. Image/movie/custom-fal nodes call `runFalJob()` via the
// local ai-proxy. FAL-CDN URLs get inlined to data URLs so the .boardfish zip
// is self-contained.
//
// Types come from src/nodes/types.ts. Edges use structured {from,to} with
// nodeId + portId; the runner treats any incoming edge as an input and
// exposes `byPort` via `to.portId` so `switch` can pick a/b.
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
  extractImageUrls,
  extractVideoUrl,
  urlToDataUrl,
} from './client';
import { getFalModel, resolveFalModelId } from './fal-models';
import type { FalModelDef } from './fal-models';
import type { NodeGraph, BaseNode, NodeId, Edge } from '../nodes/types';

// The stored per-node output shape used by the executor. This is a superset of
// what BaseNode.output declares in nodes/types.ts (which has kind/dataUrl/text/
// mime/generatedAt). Executor-only diagnostic fields (error/requestId/
// sourceUrl/updatedAt) live in `data.__runtime` on the node to avoid widening
// the persisted type. In-memory we stash them here and merge back later.
export type NodeOutput = {
  kind?: 'text' | 'image' | 'video' | 'unknown';
  text?: string;
  dataUrl?: string;
  mime?: string;
  sourceUrl?: string;
  requestId?: string;
  error?: string;
  updatedAt?: number;
};

// Local alias for the executor's edge iteration.
type NodeEdge = Edge;

// ---------- Public API ----------

export type ExecutionEvent =
  | { kind: 'started';  nodeId: NodeId }
  | { kind: 'progress'; nodeId: NodeId; message: string }
  | { kind: 'output';   nodeId: NodeId; output: BaseNode['output']; dataPatch?: Record<string, unknown> }
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

  // Build adjacency + reverse adjacency (edges are structured {nodeId,portId}).
  const outgoing = new Map<NodeId, NodeEdge[]>();
  const incoming = new Map<NodeId, NodeEdge[]>();
  for (const id of nodesById.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of edges) {
    if (!nodesById.has(e.from.nodeId) || !nodesById.has(e.to.nodeId)) continue; // dangling edge
    outgoing.get(e.from.nodeId)!.push(e);
    incoming.get(e.to.nodeId)!.push(e);
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
      node.output = mergeOutput(output, Date.now());
      // If runImageGen (or similar) staged multi-image extras during the
      // run, forward them as a DELTA (`__historyExtras`) rather than the
      // full `__history` array. The reducer appends to live __history so
      // pushes from the mirror hook aren't lost.
      const dataPatch: Record<string, unknown> = {};
      const extras = (node.data as Record<string, unknown>).__historyExtras;
      if (Array.isArray(extras) && extras.length > 0) {
        dataPatch.__historyExtras = extras;
        // Clear on the executor's snapshot so a subsequent run in the same
        // pass doesn't double-forward stale extras.
        node.data = { ...(node.data as Record<string, unknown>), __historyExtras: [] };
      }
      onEvent?.({
        kind: 'output',
        nodeId,
        output: node.output,
        dataPatch: Object.keys(dataPatch).length ? dataPatch : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Persisted output type doesn't carry error; store it on node.data.__runtime.
      const runtime = (node.data.__runtime ?? {}) as Record<string, unknown>;
      node.data = { ...node.data, __runtime: { ...runtime, error: message } };
      node.output = { kind: 'text', text: '', generatedAt: Date.now() };
      onEvent?.({ kind: 'failed', nodeId, error: message });
      // Fail-fast: downstream nodes have no meaningful input.
      throw err;
    }
  }

  const nextGraph: NodeGraph = {
    ...graph,
    nodes: Array.from(nodesById.values()),
    edges,
  };
  onEvent?.({ kind: 'done', graph: nextGraph });
  return nextGraph;
}

// Narrow the executor's rich NodeOutput to the persisted BaseNode.output shape.
// The persisted type only allows kind/dataUrl/text/mime/generatedAt.
function mergeOutput(out: NodeOutput, generatedAt: number): BaseNode['output'] {
  return {
    kind: (out.kind === 'unknown' || !out.kind) ? 'text' : out.kind,
    dataUrl: out.dataUrl,
    text: out.text,
    mime: out.mime,
    generatedAt,
  };
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
      if (!set.has(e.to.nodeId)) stack.push(e.to.nodeId);
    }
  }
  // + all ancestors (needed to resolve inputs)
  const ancStack: NodeId[] = [startAt];
  while (ancStack.length) {
    const id = ancStack.pop()!;
    for (const e of incoming.get(id) ?? []) {
      if (!set.has(e.from.nodeId)) {
        set.add(e.from.nodeId);
        ancStack.push(e.from.nodeId);
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
  for (const e of outgoing.get(startAt) ?? []) stack.push(e.to.nodeId);
  while (stack.length) {
    const id = stack.pop()!;
    if (set.has(id)) continue;
    set.add(id);
    for (const e of outgoing.get(id) ?? []) {
      if (!set.has(e.to.nodeId)) stack.push(e.to.nodeId);
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
    const inc = (incoming.get(id) ?? []).filter((e) => participants.has(e.from.nodeId));
    remainingIn.set(id, inc.length);
  }
  const ready: NodeId[] = [];
  for (const [id, n] of remainingIn) if (n === 0) ready.push(id);

  const outgoingByFrom = new Map<NodeId, NodeId[]>();
  for (const id of participants) outgoingByFrom.set(id, []);
  for (const id of participants) {
    for (const e of incoming.get(id) ?? []) {
      if (participants.has(e.from.nodeId)) outgoingByFrom.get(e.from.nodeId)!.push(id);
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
  // Runtime error flag lives on data.__runtime (persisted output shape doesn't
  // include error). If a previous run set an error, treat the output as stale.
  const runtime = (n.data.__runtime ?? {}) as { error?: unknown };
  if (runtime.error) return false;
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
    const src = nodesById.get(e.from.nodeId);
    if (!src?.output) continue;
    const o = src.output;
    if (e.to.portId) inputs.byPort[e.to.portId] = o;
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
    case 'panel-ref':        return runPanelRef(node);
    case 'custom-fal':       return runCustomFal(node, inputs, ctx);
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

function runPanelRef(node: BaseNode): NodeOutput {
  const dataUrl = String((node.data as { imageDataUrl?: unknown }).imageDataUrl ?? '');
  if (!dataUrl) {
    throw new Error('Panel Ref: no panel picked. Open the Inspector and pick a source panel.');
  }
  return { kind: 'image', dataUrl, mime: 'image/png' };
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
  const rawModelId = String((node.data as { modelId?: unknown }).modelId ?? '');
  if (!rawModelId) throw new Error('image-gen node has no modelId set.');
  const modelId = resolveFalModelId(rawModelId) ?? rawModelId;
  const model = getFalModel(modelId);
  if (!model) throw new Error(`Unknown FAL model: ${rawModelId}` + (rawModelId !== modelId ? ` (aliased to ${modelId})` : ''));
  if (model.kind !== 'image') {
    throw new Error(`Model ${modelId} is a ${model.kind} model, not image.`);
  }
  if (model.status === 'coming-soon') {
    throw new Error(`Model ${modelId} (${model.label}) is not yet available.`);
  }

  // Collect all upstream image refs (Nano Banana Pro accepts multiple).
  const refImages = collectRefImages(node, inputs);
  const payload = buildFalInput(node, inputs, model, refImages);
  // Same guard as movie-gen: better a clear message than a FAL 422.
  if (model.supportsPrompt && (!payload.prompt || String(payload.prompt).trim() === '')) {
    throw new Error(
      `${model.label} needs a prompt. Type one into the node, or wire a Text Prompt into it.`,
    );
  }
  // Route to edit endpoint when we have image refs and the model has one.
  const endpoint = refImages.length > 0 && model.editEndpoint
    ? model.editEndpoint
    : model.endpoint;

  // Total variants requested. FAL's `num_images` is capped at 4 per job by
  // most image endpoints, so we chunk into multiple concurrent jobs of up
  // to 4 each. Cap the total at 20 to prevent runaway.
  const requestedVariants = Math.max(1, Math.min(20, Math.floor(Number((node.data as { num_images?: unknown }).num_images ?? 1))));
  const perJobCap = 4;
  const chunks: number[] = [];
  let remaining = requestedVariants;
  while (remaining > 0) {
    const c = Math.min(perJobCap, remaining);
    chunks.push(c);
    remaining -= c;
  }
  ctx.onProgress(
    `Submitting ${chunks.length} job${chunks.length > 1 ? 's' : ''} to ${model.label} (${endpoint}) for ${requestedVariants} variant${requestedVariants > 1 ? 's' : ''}${refImages.length ? ` with ${refImages.length} ref image${refImages.length > 1 ? 's' : ''}` : ''}…`,
  );

  // Fire each chunked job concurrently. Each job gets its own num_images
  // override on the payload; other keys (prompt, aspect, refs, seed) stay.
  // If a seed is set and multiple jobs run, we offset each chunk by its
  // index so we don't just get 4 copies of the same seed grid.
  const jobs = chunks.map((chunkSize, chunkIdx) => {
    const chunkPayload: Record<string, unknown> = { ...payload, num_images: chunkSize };
    if (typeof chunkPayload.seed === 'number' && chunkIdx > 0) {
      chunkPayload.seed = (chunkPayload.seed as number) + chunkIdx * 1_000_003;
    }
    return runFalJob(endpoint, chunkPayload);
  });
  const results = await Promise.all(jobs);
  const firstReqId = results[0].requestId;
  ctx.onProgress(`FAL jobs complete, downloading ${requestedVariants} image${requestedVariants > 1 ? 's' : ''}…`);

  // Flatten all image URLs across all jobs, preserving order.
  const imgUrls: string[] = [];
  for (const r of results) {
    imgUrls.push(...extractImageUrls(r.result));
  }
  if (imgUrls.length === 0) {
    throw new Error(`Could not find an image URL in ${model.label} response.`);
  }
  const downloaded: Array<{ dataUrl: string; mime: string; sourceUrl: string }> = [];
  for (const u of imgUrls) {
    const { dataUrl: d, mime: m } = await urlToDataUrl(u);
    downloaded.push({ dataUrl: d, mime: m, sourceUrl: u });
  }
  // Extras (indices 1..N-1) become synthetic history entries. Stash them on
  // `node.data.__historyExtras` (a DELTA, not the full replacement) so the
  // React-side reducer can APPEND them to the live __history without
  // clobbering entries the mirror hook has already pushed.
  //
  // We deliberately do NOT push the current `node.output` here — the
  // React-side `useHistoryMirror` effect handles that push when it sees the
  // new `generatedAt` on the incoming output.
  if (downloaded.length > 1) {
    const now = Date.now();
    const extras: NodeOutput[] = [];
    for (let i = 1; i < downloaded.length; i++) {
      const d = downloaded[i];
      extras.push({
        kind: 'image',
        dataUrl: d.dataUrl,
        mime: d.mime,
        sourceUrl: d.sourceUrl,
        requestId: firstReqId,
        generatedAt: now + i, // stable, monotonic per-extra timestamp
      } as NodeOutput);
    }
    node.data = { ...node.data, __historyExtras: extras };
  }
  const first = downloaded[0];
  const imgUrl = first.sourceUrl;
  const dataUrl = first.dataUrl;
  const mime = first.mime;
  return {
    kind: 'image',
    dataUrl,
    mime,
    sourceUrl: imgUrl,
    requestId: firstReqId,
  };
}

// Collect all reference-image data URLs available to this gen node:
//   1. anything upstream via the `ref` input port
//   2. anything already sitting on `node.data.image_url` (legacy) or
//      `node.data.image_urls` (current) — the seedDefaultGraph bakes the
//      panel's current image into data.image_url so a fresh editor open
//      round-trips through image-to-image without needing a wired ref node.
function collectRefImages(node: BaseNode, inputs: ResolvedInputs): string[] {
  const out: string[] = [];
  for (const img of inputs.images) if (img) out.push(img);
  const dataUrl = (node.data as { image_url?: unknown }).image_url;
  const dataUrls = (node.data as { image_urls?: unknown }).image_urls;
  if (typeof dataUrl === 'string' && dataUrl) out.push(dataUrl);
  if (Array.isArray(dataUrls)) {
    for (const u of dataUrls) if (typeof u === 'string' && u) out.push(u);
  }
  // De-dupe while preserving order.
  return Array.from(new Set(out));
}

async function runMovieGen(
  node: BaseNode,
  inputs: ResolvedInputs,
  ctx: RunCtx,
): Promise<NodeOutput> {
  const rawModelId = String((node.data as { modelId?: unknown }).modelId ?? '');
  if (!rawModelId) throw new Error('movie-gen node has no modelId set.');
  const modelId = resolveFalModelId(rawModelId) ?? rawModelId;
  const model = getFalModel(modelId);
  if (!model) throw new Error(`Unknown FAL model: ${rawModelId}` + (rawModelId !== modelId ? ` (aliased to ${modelId})` : ''));
  if (model.kind !== 'video') {
    throw new Error(`Model ${modelId} is a ${model.kind} model, not video.`);
  }
  if (model.status === 'coming-soon') {
    throw new Error(`Model ${modelId} (${model.label}) is not yet available.`);
  }

  // Collect all upstream image refs. For video models we typically pass the
  // first-frame image as `image_url` (singular), which each video model
  // declares via refImageKey / refImageIsArray.
  const refImages = collectRefImages(node, inputs);
  // Use the new-signature buildFalInput (pass `model`) so per-model type
  // coercion runs (Kling duration as string, Seedance duration as number, etc.)
  // and refImages land under the model's declared refImageKey.
  const payload = buildFalInput(node, inputs, model, refImages);
  // Guard against the #1 UX pitfall: user drops a Movie Gen node, hits
  // Generate, and gets a cryptic "Could not find a video URL" because FAL
  // rejected the empty-prompt payload. Fail fast with a clear message.
  if (model.supportsPrompt && (!payload.prompt || String(payload.prompt).trim() === '')) {
    throw new Error(
      `${model.label} needs a prompt. Type one into the node, or wire a Text Prompt into it.`,
    );
  }
  // Route to image-to-video endpoint when we have a first-frame ref image and
  // the model exposes a dedicated i2v endpoint.
  const endpoint = refImages.length > 0 && model.editEndpoint
    ? model.editEndpoint
    : model.endpoint;

  // Variants: FAL video endpoints don't accept num_videos natively, so fire
  // N parallel jobs of 1 each. Cap at 10 (each job costs 1–5 min and $$$).
  const requestedVariants = Math.max(1, Math.min(10, Math.floor(Number((node.data as { num_videos?: unknown }).num_videos ?? 1))));
  ctx.onProgress(
    `Submitting ${requestedVariants} job${requestedVariants > 1 ? 's' : ''} to ${model.label} (${endpoint})${refImages.length ? ' with first-frame reference' : ''}…`,
  );

  // Per-job payload: same base, but bump the seed by job index when a seed
  // is pinned so we don't get N identical videos.
  const jobs = Array.from({ length: requestedVariants }, (_, i) => {
    const jobPayload: Record<string, unknown> = { ...payload };
    if (typeof jobPayload.seed === 'number' && i > 0) {
      jobPayload.seed = (jobPayload.seed as number) + i * 1_000_003;
    }
    return runFalJob(endpoint, jobPayload);
  });
  const results = await Promise.all(jobs);
  const firstReqId = results[0].requestId;
  ctx.onProgress(`FAL jobs complete, downloading ${requestedVariants} video${requestedVariants > 1 ? 's' : ''}…`);

  const vidUrls: string[] = [];
  for (const r of results) {
    const u = extractVideoUrl(r.result);
    if (u) vidUrls.push(u);
  }
  if (vidUrls.length === 0) {
    throw new Error(`Could not find a video URL in ${model.label} response.`);
  }
  const downloaded: Array<{ dataUrl: string; mime: string; sourceUrl: string }> = [];
  for (const u of vidUrls) {
    const { dataUrl: d, mime: m } = await urlToDataUrl(u);
    downloaded.push({ dataUrl: d, mime: m, sourceUrl: u });
  }

  // Extras (variants 2..N) become synthetic history entries via __historyExtras.
  if (downloaded.length > 1) {
    const now = Date.now();
    const extras: NodeOutput[] = [];
    for (let i = 1; i < downloaded.length; i++) {
      const d = downloaded[i];
      extras.push({
        kind: 'video',
        dataUrl: d.dataUrl,
        mime: d.mime,
        sourceUrl: d.sourceUrl,
        requestId: firstReqId,
        generatedAt: now + i,
      } as NodeOutput);
    }
    node.data = { ...node.data, __historyExtras: extras };
  }

  const first = downloaded[0];
  return {
    kind: 'video',
    dataUrl: first.dataUrl,
    mime: first.mime,
    sourceUrl: first.sourceUrl,
    requestId: firstReqId,
  };
}

async function runCustomFal(
  node: BaseNode,
  inputs: ResolvedInputs,
  ctx: RunCtx,
): Promise<NodeOutput> {
  const endpoint = String((node.data as { endpoint?: unknown }).endpoint ?? '').trim();
  if (!endpoint) throw new Error('Custom FAL: no endpoint set. Open the Inspector and paste a fal.ai model slug (e.g. "fal-ai/flux-pro/v1.1").');

  // Parse the free-form JSON payload from the Inspector. Empty/invalid
  // JSON is treated as an empty object rather than an error — the user
  // may be wiring purely upstream (prompt + image) with no extra keys.
  const raw = (node.data as { inputJson?: unknown; input?: unknown }).inputJson
    ?? (node.data as { input?: unknown }).input;
  let inputObj: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inputObj = parsed as Record<string, unknown>;
      } else {
        throw new Error('Custom FAL: input JSON must be an object (not an array/primitive).');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Custom FAL: invalid input JSON — ${msg}`);
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    inputObj = raw as Record<string, unknown>;
  }

  // Merge upstream inputs. Explicit keys in inputJson always win.
  // - text on `prompt` port (or any text input) → `prompt`
  // - image on `image` port (or first image input) → configured `imageKey` (default `image_url`)
  const upstreamPrompt = inputs.byPort['prompt']?.text ?? inputs.texts[0];
  if (upstreamPrompt && inputObj.prompt === undefined) {
    inputObj.prompt = upstreamPrompt;
  }
  const upstreamImage = inputs.byPort['image']?.dataUrl ?? inputs.images[0];
  if (upstreamImage) {
    const imageKey = String((node.data as { imageKey?: unknown }).imageKey ?? 'image_url') || 'image_url';
    if (inputObj[imageKey] === undefined) {
      inputObj[imageKey] = imageKey.endsWith('s') ? [upstreamImage] : upstreamImage;
    }
  }

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

// Build the FAL input payload from a node's `data` (spread verbatim, minus
// meta fields) plus upstream text (concatenated) as `prompt` and reference
// images placed under the model's declared `refImageKey`.
function buildFalInput(
  node: BaseNode,
  inputs: ResolvedInputs,
  modelOrSupportsPrompt: FalModelDef | boolean,
  refImages?: string[],
): Record<string, unknown> {
  // Old signature: buildFalInput(node, inputs, supportsPrompt: boolean)
  // New signature: buildFalInput(node, inputs, model: FalModelDef, refImages: string[])
  // Support both so movie-gen (still on old signature) keeps working.
  const isModel = typeof modelOrSupportsPrompt === 'object';
  const model = isModel ? modelOrSupportsPrompt : null;
  const supportsPrompt = isModel ? model!.supportsPrompt : Boolean(modelOrSupportsPrompt);
  const refImageKey = model?.refImageKey ?? 'image_urls';
  const refImageIsArray = model?.refImageIsArray ?? true;

  // Build an index of the model's declared input types so we can coerce
  // values into what each FAL model actually accepts (Kling wants duration as
  // a string, Seedance wants it as a number, etc.).
  const inputTypeByKey: Record<string, string> = {};
  // Also index the model's declared defaults + option lists so we can snap
  // stale values (e.g. `duration: 5` on a Veo node whose enum is
  // ["4s","6s","8s"]) to a valid option instead of sending a value that FAL
  // will reject with a 422.
  const inputDefaultByKey: Record<string, unknown> = {};
  const inputOptionsByKey: Record<string, Set<string>> = {};
  if (model) {
    for (const inp of model.inputs) {
      inputTypeByKey[inp.key] = inp.type;
      if (inp.default !== undefined) inputDefaultByKey[inp.key] = inp.default;
      if (Array.isArray(inp.options)) {
        inputOptionsByKey[inp.key] = new Set(inp.options.map((o) => String(o.value)));
      }
    }
  }

  // Copy everything from `data` except meta and any ref-image key we'll set below.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.data)) {
    if (k === 'modelId') continue;
    if (k === '__runtime' || k.startsWith('__')) continue;
    // Drop any *_url / *_urls fields on the node; refImages arg is the source of truth.
    if (k === 'image_url' || k === 'image_urls') continue;
    // num_videos is a node-level control ("how many jobs to fire"), not a
    // FAL input. Executor handles concurrency; do not forward to FAL.
    if (k === 'num_videos') continue;
    // refCount is a UI-only stepper for how many ref ports to render.
    if (k === 'refCount') continue;
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    // Per-model coercion. If the model schema says this key is 'select', it
    // wants a string value (Kling duration "5"/"10"). If it says 'number',
    // coerce to a number (Seedance duration).
    const declared = inputTypeByKey[k];
    if (declared === 'select' && typeof v === 'number') out[k] = String(v);
    else if (declared === 'number' && typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;
    } else {
      out[k] = v;
    }
    // Snap select values to the option list when the stored value doesn't
    // match. This rescues stale node data (e.g. Veo duration `5` → `"8s"`)
    // after a schema change.
    if (declared === 'select' && inputOptionsByKey[k]) {
      const cur = String(out[k]);
      if (!inputOptionsByKey[k].has(cur)) {
        if (inputDefaultByKey[k] !== undefined) out[k] = inputDefaultByKey[k];
        else out[k] = Array.from(inputOptionsByKey[k])[0];
      }
    }
  }

  if (supportsPrompt) {
    const upstreamPrompt = inputs.texts.join(' ').trim();
    const existing = typeof out.prompt === 'string' ? out.prompt : '';
    if (upstreamPrompt && !existing) out.prompt = upstreamPrompt;
    else if (upstreamPrompt && existing) out.prompt = `${existing} ${upstreamPrompt}`.trim();
  }

  // Ref images. Three routing strategies, in priority order:
  //
  //  1. model.refPorts: distinct named ports (Veo 3.1 FLF has first + last).
  //     Each port's image goes to the port's declared falKey. Any leftover
  //     images (from upstream fan-out beyond declared ports) are dropped.
  //
  //  2. legacy passed-in refImages arg: caller aggregated all upstream image
  //     inputs into a flat list; place under refImageKey.
  //
  //  3. fallback: first upstream image as `image_url` (legacy movie-gen).
  if (model?.refPorts && model.refPorts.length > 0) {
    for (const rp of model.refPorts) {
      const upstream = inputs.byPort[rp.portId]?.dataUrl;
      // Also accept a pasted URL directly on node.data (e.g. user pasted a
      // last_frame_url string). Priority: wired port > data.
      const fromData = (node.data as Record<string, unknown>)[rp.falKey];
      const val = upstream ?? (typeof fromData === 'string' && fromData ? fromData : undefined);
      if (val) out[rp.falKey] = val;
      else delete out[rp.falKey];
    }
  } else {
    const refs = refImages ?? (inputs.images[0] ? [inputs.images[0]] : []);
    if (refs.length > 0) {
      if (refImageIsArray) out[refImageKey] = refs;
      else out[refImageKey] = refs[0];
    }
  }

  return out;
}
