// Boardfish 5 — pure graph mutation + query helpers.
//
// All functions are immutable: they return a new NodeGraph rather than
// mutating in place. `useReducer` in NodeEditor.tsx composes them into
// actions.

import type { BaseNode, Edge, NodeGraph, NodeId, NodeKind, NodeOutput, NodePort, PortId } from './types';
import { defaultDataFor, defaultPortsFor, newId } from './types';
import { NODE_KINDS_META } from './registry-meta';

// ---------------------------------------------------------------------------
// Node-editor UI helpers added for the resize + history + XML export pass.
// These are pure functions and safe to call from either the reducer path or
// directly from render code.
// ---------------------------------------------------------------------------

/** Bounds enforced by the resize UX. */
export const NODE_MIN_WIDTH = 200;
export const NODE_MIN_HEIGHT = 120;
export const NODE_MAX_WIDTH = 800;
export const NODE_MAX_HEIGHT = 600;

/**
 * Resolve a node's rendered size.
 *
 * Precedence:
 *   1. `data.__size = { width, height }` (piggy-backed on UPDATE_NODE_DATA;
 *      lets us persist resizes without adding a reducer action)
 *   2. explicit `node.width` / `node.height` on the BaseNode
 *   3. the kind's `defaultWidth` / `defaultHeight` from NODE_KINDS_META
 */
export function readNodeSize(node: BaseNode): { width: number; height: number } {
  const meta = NODE_KINDS_META[node.kind];
  const defW = meta?.defaultWidth ?? 220;
  const defH = meta?.defaultHeight ?? 140;
  const size = (node.data as Record<string, unknown>).__size as
    | { width?: number; height?: number }
    | undefined;
  const width = clamp(
    Number(size?.width ?? node.width ?? defW),
    NODE_MIN_WIDTH,
    NODE_MAX_WIDTH,
  );
  const height = clamp(
    Number(size?.height ?? node.height ?? defH),
    NODE_MIN_HEIGHT,
    NODE_MAX_HEIGHT,
  );
  return { width, height };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Return the node's per-node output history (previous generations).
 * Stored on `data.__history` as an array of NodeOutput snapshots, oldest
 * first. The current `node.output` is NOT included in this list — it is the
 * live head.
 */
export function readNodeHistory(node: BaseNode): NodeOutput[] {
  const raw = (node.data as Record<string, unknown>).__history;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is NodeOutput => Boolean(v && typeof v === 'object'));
}

/**
 * Push a previous output snapshot onto a node's per-node history and return
 * the new full array. Bounded to the most recent HISTORY_LIMIT entries so
 * long-running graphs don't inflate `data` indefinitely.
 *
 * NOTE: The DAG executor is the natural place to call this — right before it
 * overwrites `node.output` with a new snapshot it should push the previous
 * one here. Because this pass can't touch dag-executor.ts, the Preview
 * components hook into an effect that mirrors that behavior on the client
 * side. See `pushToHistory` for the reducer-friendly variant.
 */
export const HISTORY_LIMIT = 24;

export function appendHistory(node: BaseNode, prev: NodeOutput | undefined): NodeOutput[] {
  const cur = readNodeHistory(node);
  if (!prev) return cur;
  const next = [...cur, prev];
  if (next.length > HISTORY_LIMIT) next.splice(0, next.length - HISTORY_LIMIT);
  return next;
}

/**
 * Reducer-friendly variant: return a new graph with `prev` appended to the
 * node's history bucket. Kept in graph-utils so dag-executor can drop the
 * following one-liner in the right place when it lands:
 *
 *   graph = pushToHistory(graph, nodeId, oldOutput);
 */
export function pushToHistory(
  g: NodeGraph,
  nodeId: NodeId,
  prev: NodeOutput | undefined,
): NodeGraph {
  if (!prev) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id !== nodeId
        ? n
        : { ...n, data: { ...n.data, __history: appendHistory(n, prev) } },
    ),
  };
}

// ---------------------------------------------------------------------------
// XML export.
// ---------------------------------------------------------------------------

/** Keys on `node.data` that are private editor state and should NOT be
 * serialized. Keep this list in sync with any new `__foo` piggy-backs. */
const INTERNAL_DATA_KEYS = new Set(['__size', '__history', '__runtime']);

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Is the given data-URL-ish string a large binary blob that would blow up
 * the XML file if we inlined it? Filters both data: URIs and huge blob:
 * cache keys.
 */
function isLargeBinary(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > 2048) return true;
  return value.startsWith('data:') || value.startsWith('blob:');
}

/**
 * Render a single data key/value as either an attribute (scalars) or a child
 * element (nested objects / long strings). Skips internal keys and large
 * binary blobs.
 */
function renderDataChild(key: string, value: unknown, indent: string): string | null {
  if (INTERNAL_DATA_KEYS.has(key)) return null;
  if (value === null || value === undefined) return null;
  if (isLargeBinary(value)) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${indent}<${key}>${xmlEscape(String(value))}</${key}>`;
  }
  // Objects / arrays: JSON-encode into a child element with the raw payload.
  try {
    const json = JSON.stringify(value);
    if (json.length > 4096) return null;
    return `${indent}<${key} format="json">${xmlEscape(json)}</${key}>`;
  } catch {
    return null;
  }
}

/**
 * Serialize a graph to the storyboard-oriented XML schema described in the
 * task spec. Skips large data-URL fields, __history, __runtime, __size, and
 * XML-escapes all text content.
 */
export function graphToXml(g: NodeGraph): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<boardfish-graph version="1">');
  lines.push('  <nodes>');
  for (const n of g.nodes) {
    const dataChildren: string[] = [];
    for (const [k, v] of Object.entries(n.data)) {
      const rendered = renderDataChild(k, v, '        ');
      if (rendered) dataChildren.push(rendered);
    }
    const attrs: string[] = [
      `id="${xmlEscape(n.id)}"`,
      `kind="${xmlEscape(n.kind)}"`,
      `x="${Math.round(n.x)}"`,
      `y="${Math.round(n.y)}"`,
    ];
    const size = readNodeSize(n);
    attrs.push(`width="${size.width}"`, `height="${size.height}"`);
    lines.push(`    <node ${attrs.join(' ')}>`);
    if (dataChildren.length > 0) {
      lines.push('      <data>');
      for (const c of dataChildren) lines.push(c);
      lines.push('      </data>');
    } else {
      lines.push('      <data />');
    }
    if (n.output) {
      const outAttrs: string[] = [`kind="${xmlEscape(n.output.kind)}"`];
      if (n.output.generatedAt) outAttrs.push(`generatedAt="${n.output.generatedAt}"`);
      if (n.output.mime) outAttrs.push(`mime="${xmlEscape(n.output.mime)}"`);
      // Inline text output but never inline image/video data URLs.
      if (n.output.kind === 'text' && typeof n.output.text === 'string' && n.output.text.length <= 4096) {
        lines.push(`      <output ${outAttrs.join(' ')}>${xmlEscape(n.output.text)}</output>`);
      } else {
        lines.push(`      <output ${outAttrs.join(' ')} />`);
      }
    }
    lines.push('    </node>');
  }
  lines.push('  </nodes>');
  lines.push('  <edges>');
  for (const e of g.edges) {
    lines.push(
      `    <edge id="${xmlEscape(e.id)}" ` +
        `from-node="${xmlEscape(e.from.nodeId)}" ` +
        `from-port="${xmlEscape(e.from.portId)}" ` +
        `to-node="${xmlEscape(e.to.nodeId)}" ` +
        `to-port="${xmlEscape(e.to.portId)}" />`,
    );
  }
  lines.push('  </edges>');
  lines.push('</boardfish-graph>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Bulk operations added for FiCal-parity UX (multi-select move/delete, paste,
// wire-insert). All immutable — return a fresh NodeGraph. Individual helpers
// above are kept intact so single-node reducer actions don't need to change.
// ---------------------------------------------------------------------------

/** Insert a new node at the given canvas coord. */
export function addNode(g: NodeGraph, kind: NodeKind, at: { x: number; y: number }): NodeGraph {
  const data = defaultDataFor(kind);
  const node: BaseNode = {
    id: newId('n'),
    kind,
    x: at.x,
    y: at.y,
    ports: defaultPortsFor(kind, data),
    data,
  };
  return { ...g, nodes: [...g.nodes, node] };
}

/** Remove a node and any incident edges. */
export function removeNode(g: NodeGraph, id: NodeId): NodeGraph {
  return {
    ...g,
    nodes: g.nodes.filter((n) => n.id !== id),
    edges: g.edges.filter((e) => e.from.nodeId !== id && e.to.nodeId !== id),
  };
}

/**
 * Update a node's data blob and (if the kind has data-driven ports) refresh
 * its port list. Also drops any edges that reference ports that no longer
 * exist after the refresh (e.g. shrinking a switch's `count`).
 */
export function updateNodeData(
  g: NodeGraph,
  id: NodeId,
  patch: Record<string, unknown>,
): NodeGraph {
  let droppedPortIds: Set<PortId> | null = null;
  const nodes = g.nodes.map((n) => {
    if (n.id !== id) return n;
    const nextData = { ...n.data, ...patch };
    const nextPorts = defaultPortsFor(n.kind, nextData);
    // Detect any ports that existed before but are gone now, so we can prune
    // edges below.
    const nextIds = new Set(nextPorts.map((p) => p.id));
    const gone = n.ports.filter((p) => !nextIds.has(p.id));
    if (gone.length > 0) {
      droppedPortIds = new Set(gone.map((p) => p.id));
    }
    return { ...n, data: nextData, ports: nextPorts };
  });

  let edges = g.edges;
  if (droppedPortIds) {
    edges = edges.filter(
      (e) =>
        !(
          (e.from.nodeId === id && droppedPortIds!.has(e.from.portId)) ||
          (e.to.nodeId === id && droppedPortIds!.has(e.to.portId))
        ),
    );
  }
  return { ...g, nodes, edges };
}

/** Move a node to a new canvas coord. */
export function moveNode(g: NodeGraph, id: NodeId, x: number, y: number): NodeGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
  };
}

/** Attach an output snapshot to a node. Used by the executor. */
export function setNodeOutput(g: NodeGraph, id: NodeId, output: BaseNode['output']): NodeGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === id ? { ...n, output } : n)),
  };
}

/**
 * Create an edge from `from`→`to`. Assumes `canConnect` was already checked;
 * also drops any existing edge that would double-connect the same input port
 * (input ports are single-in by convention).
 */
export function addEdge(g: NodeGraph, from: Edge['from'], to: Edge['to']): NodeGraph {
  const edges = g.edges.filter(
    (e) => !(e.to.nodeId === to.nodeId && e.to.portId === to.portId),
  );
  const edge: Edge = { id: newId('e'), from, to };
  return { ...g, edges: [...edges, edge] };
}

export function removeEdge(g: NodeGraph, edgeId: string): NodeGraph {
  return { ...g, edges: g.edges.filter((e) => e.id !== edgeId) };
}

/** Remove every edge touching the given node. */
export function disconnectNode(g: NodeGraph, id: NodeId): NodeGraph {
  return {
    ...g,
    edges: g.edges.filter((e) => e.from.nodeId !== id && e.to.nodeId !== id),
  };
}

/**
 * Move multiple nodes by a shared delta. Used when dragging a multi-selection
 * so we don't reduce N times per pointer-move frame.
 */
export function moveNodesBy(
  g: NodeGraph,
  ids: Set<NodeId> | NodeId[],
  dx: number,
  dy: number,
): NodeGraph {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  if (idSet.size === 0 || (dx === 0 && dy === 0)) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      idSet.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    ),
  };
}

/**
 * Move multiple nodes to absolute positions (id -> {x,y}). Used when we know
 * the starting positions and can compute final coords directly (avoids drift
 * from repeated delta application in React reducer batching).
 */
export function moveNodesTo(
  g: NodeGraph,
  positions: Map<NodeId, { x: number; y: number }>,
): NodeGraph {
  if (positions.size === 0) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
  };
}

/** Bulk remove nodes and any edges touching them. */
export function removeNodes(g: NodeGraph, ids: Set<NodeId> | NodeId[]): NodeGraph {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  if (idSet.size === 0) return g;
  return {
    ...g,
    nodes: g.nodes.filter((n) => !idSet.has(n.id)),
    edges: g.edges.filter(
      (e) => !idSet.has(e.from.nodeId) && !idSet.has(e.to.nodeId),
    ),
  };
}

export type NodeClipboard = {
  nodes: BaseNode[];
  // Edges are stored with the original (pre-remap) node ids; paste remaps.
  edges: Edge[];
};

/**
 * Build a clipboard snapshot from the current selection: deep copies of the
 * selected nodes plus any edges whose BOTH endpoints are inside the selection.
 * Outputs are dropped from the copies (they belong to the original run).
 */
export function copyNodesToClipboard(
  g: NodeGraph,
  selection: Set<NodeId> | NodeId[],
): NodeClipboard {
  const idSet = selection instanceof Set ? selection : new Set(selection);
  const nodes = g.nodes
    .filter((n) => idSet.has(n.id))
    .map((n) => ({
      ...n,
      data: { ...n.data },
      ports: n.ports.map((p) => ({ ...p })),
      output: undefined,
    }));
  const edges = g.edges
    .filter((e) => idSet.has(e.from.nodeId) && idSet.has(e.to.nodeId))
    .map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }));
  return { nodes, edges };
}

/**
 * Paste clipboard contents into the graph. Every node gets a fresh id and is
 * offset by (dx, dy). Only edges fully inside the clipboard survive, remapped
 * to the new ids. Returns { graph, newIds } so the caller can set selection
 * to the freshly-pasted set.
 */
export function pasteClipboard(
  g: NodeGraph,
  clip: NodeClipboard,
  dx: number,
  dy: number,
): { graph: NodeGraph; newIds: NodeId[] } {
  if (!clip || clip.nodes.length === 0) return { graph: g, newIds: [] };
  const idMap = new Map<NodeId, NodeId>();
  const pastedNodes: BaseNode[] = clip.nodes.map((src) => {
    const nid = newId('n');
    idMap.set(src.id, nid);
    return {
      ...src,
      id: nid,
      x: src.x + dx,
      y: src.y + dy,
      data: { ...src.data },
      ports: src.ports.map((p) => ({ ...p })),
      output: undefined,
    };
  });
  const pastedEdges: Edge[] = [];
  for (const e of clip.edges) {
    const fromId = idMap.get(e.from.nodeId);
    const toId = idMap.get(e.to.nodeId);
    if (!fromId || !toId) continue;
    pastedEdges.push({
      id: newId('e'),
      from: { nodeId: fromId, portId: e.from.portId },
      to: { nodeId: toId, portId: e.to.portId },
    });
  }
  return {
    graph: {
      ...g,
      nodes: [...g.nodes, ...pastedNodes],
      edges: [...g.edges, ...pastedEdges],
    },
    newIds: [...idMap.values()],
  };
}

/**
 * Insert `nodeId` inline on `edgeId`, splitting the wire into two. The node
 * needs one compatible input and one compatible output port matching the
 * source edge's dataTypes.
 *
 * Returns the mutated graph, or the original graph if the split isn't valid.
 */
export function insertNodeOnEdge(
  g: NodeGraph,
  edgeId: string,
  nodeId: NodeId,
): NodeGraph {
  const edge = g.edges.find((e) => e.id === edgeId);
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!edge || !node) return g;
  const fromNode = g.nodes.find((n) => n.id === edge.from.nodeId);
  const toNode = g.nodes.find((n) => n.id === edge.to.nodeId);
  if (!fromNode || !toNode) return g;
  const outPort = fromNode.ports.find((p) => p.id === edge.from.portId);
  const inPort = toNode.ports.find((p) => p.id === edge.to.portId);
  if (!outPort || !inPort) return g;

  // Find compatible in/out ports on the target node.
  const nodeIn = node.ports.find(
    (p) => p.side === 'in' && typesCompatible(outPort, p),
  );
  const nodeOut = node.ports.find(
    (p) => p.side === 'out' && typesCompatible(p, inPort),
  );
  if (!nodeIn || !nodeOut) return g;

  // Refuse if the node is one of the endpoints already.
  if (edge.from.nodeId === nodeId || edge.to.nodeId === nodeId) return g;
  // Cycle checks against the graph WITHOUT the split edge (since we'll
  // remove it during the swap):
  //   * from -> node would loop if `node` reaches `from`
  //   * node -> to would loop if `to`   reaches `node`
  const withoutSplit: NodeGraph = { ...g, edges: g.edges.filter((e) => e.id !== edgeId) };
  if (reaches(withoutSplit, nodeId, edge.from.nodeId)) return g;
  if (reaches(withoutSplit, edge.to.nodeId, nodeId)) return g;

  const withoutEdge = { ...g, edges: g.edges.filter((e) => e.id !== edgeId) };
  const withFirst: Edge = {
    id: newId('e'),
    from: { nodeId: edge.from.nodeId, portId: edge.from.portId },
    to: { nodeId: nodeId, portId: nodeIn.id },
  };
  const withSecond: Edge = {
    id: newId('e'),
    from: { nodeId: nodeId, portId: nodeOut.id },
    to: { nodeId: edge.to.nodeId, portId: edge.to.portId },
  };
  // Also strip any pre-existing edge on the target input port of `nodeIn`
  // and on the input port that the second edge lands on. addEdge normally
  // handles that; do the same here to keep single-in invariants.
  const cleaned = withoutEdge.edges.filter(
    (e) =>
      !(e.to.nodeId === nodeId && e.to.portId === nodeIn.id) &&
      !(e.to.nodeId === edge.to.nodeId && e.to.portId === edge.to.portId),
  );
  return { ...withoutEdge, edges: [...cleaned, withFirst, withSecond] };
}

/**
 * Does the given node have at least one input port and one output port with
 * compatible dataTypes? Used to decide whether a node is a candidate for
 * inline drop-on-wire insertion.
 */
export function canInsertInline(node: BaseNode): boolean {
  const hasIn = node.ports.some((p) => p.side === 'in');
  const hasOut = node.ports.some((p) => p.side === 'out');
  return hasIn && hasOut;
}

/**
 * Return the set of edges connected to the given (nodeId, portId). Used by
 * the endpoint-drag (rewire) logic to figure out if a port already has
 * exactly one wire we can pick up.
 */
export function edgesOnPort(
  g: NodeGraph,
  nodeId: NodeId,
  portId: PortId,
): Edge[] {
  return g.edges.filter(
    (e) =>
      (e.from.nodeId === nodeId && e.from.portId === portId) ||
      (e.to.nodeId === nodeId && e.to.portId === portId),
  );
}

/** Duplicate a node with a small offset; no edges copied. */
export function duplicateNode(g: NodeGraph, id: NodeId): NodeGraph {
  const src = g.nodes.find((n) => n.id === id);
  if (!src) return g;
  const copy: BaseNode = {
    ...src,
    id: newId('n'),
    x: src.x + 40,
    y: src.y + 40,
    // Copy data + ports by value so subsequent edits don't mutate the source.
    data: { ...src.data },
    ports: src.ports.map((p) => ({ ...p })),
    // Don't carry over the output — the copy hasn't been executed.
    output: undefined,
  };
  return { ...g, nodes: [...g.nodes, copy] };
}

/** Is a specific port already used by any edge? */
export function isPortConnected(g: NodeGraph, nodeId: NodeId, portId: PortId): boolean {
  return g.edges.some(
    (e) =>
      (e.from.nodeId === nodeId && e.from.portId === portId) ||
      (e.to.nodeId === nodeId && e.to.portId === portId),
  );
}

/**
 * Type + topology check for a proposed edge:
 *   - both endpoints exist and are the right side (out→in)
 *   - dataType compatible (either side may be 'any')
 *   - no self-connection
 *   - the target input isn't already used (we auto-replace on addEdge, but
 *     canConnect returning true means "the drag will drop cleanly"; the
 *     UI can decide whether to warn about replacement)
 *   - no cycle would be introduced
 */
export function canConnect(
  g: NodeGraph,
  from: Edge['from'],
  to: Edge['to'],
): boolean {
  if (from.nodeId === to.nodeId) return false;
  const fromNode = g.nodes.find((n) => n.id === from.nodeId);
  const toNode = g.nodes.find((n) => n.id === to.nodeId);
  if (!fromNode || !toNode) return false;
  const fromPort = fromNode.ports.find((p) => p.id === from.portId);
  const toPort = toNode.ports.find((p) => p.id === to.portId);
  if (!fromPort || !toPort) return false;
  if (fromPort.side !== 'out' || toPort.side !== 'in') return false;
  if (!typesCompatible(fromPort, toPort)) return false;
  // Cycle check: adding from→to means to should not already reach from.
  if (reaches(g, to.nodeId, from.nodeId)) return false;
  return true;
}

function typesCompatible(a: NodePort, b: NodePort): boolean {
  if (a.dataType === 'any' || b.dataType === 'any') return true;
  return a.dataType === b.dataType;
}

/** DFS: does `startId` reach `targetId` via existing edges? */
function reaches(g: NodeGraph, startId: NodeId, targetId: NodeId): boolean {
  if (startId === targetId) return true;
  const adj = new Map<NodeId, NodeId[]>();
  for (const e of g.edges) {
    const list = adj.get(e.from.nodeId) ?? [];
    list.push(e.to.nodeId);
    adj.set(e.from.nodeId, list);
  }
  const seen = new Set<NodeId>();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const next = adj.get(cur);
    if (next) stack.push(...next);
  }
  return false;
}

/**
 * Return the topo-sorted list of ancestor nodes leading to (and including)
 * `nodeId`. Order: ancestors first, target last. Used by the executor to
 * evaluate upstream dependencies before running the requested node.
 *
 * If the graph is acyclic (canConnect enforces that), Kahn's algorithm on
 * the induced subgraph gives a stable ordering.
 */
export function upstream(g: NodeGraph, nodeId: NodeId): BaseNode[] {
  // Reverse adjacency: node -> list of predecessor node ids.
  const preds = new Map<NodeId, Set<NodeId>>();
  for (const n of g.nodes) preds.set(n.id, new Set());
  for (const e of g.edges) {
    preds.get(e.to.nodeId)?.add(e.from.nodeId);
  }
  // Collect the induced subgraph: everything reachable BACKWARDS from nodeId.
  const included = new Set<NodeId>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (included.has(cur)) continue;
    included.add(cur);
    for (const p of preds.get(cur) ?? []) stack.push(p);
  }
  // Topo-sort the induced subgraph. Edges we care about: only among included.
  const inDegree = new Map<NodeId, number>();
  for (const id of included) inDegree.set(id, 0);
  for (const e of g.edges) {
    if (included.has(e.from.nodeId) && included.has(e.to.nodeId)) {
      inDegree.set(e.to.nodeId, (inDegree.get(e.to.nodeId) ?? 0) + 1);
    }
  }
  const queue: NodeId[] = [];
  for (const [id, d] of inDegree) if (d === 0) queue.push(id);
  const out: BaseNode[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const cur = queue.shift()!;
    const node = byId.get(cur);
    if (node) out.push(node);
    for (const e of g.edges) {
      if (e.from.nodeId !== cur) continue;
      if (!included.has(e.to.nodeId)) continue;
      const nd = (inDegree.get(e.to.nodeId) ?? 0) - 1;
      inDegree.set(e.to.nodeId, nd);
      if (nd === 0) queue.push(e.to.nodeId);
    }
  }
  return out;
}

/**
 * Convenience: find the current graph's "out" node. NodeEditor uses this at
 * save time to hand back the panel image if one is attached.
 */
export function findOutNode(g: NodeGraph): BaseNode | undefined {
  return g.nodes.find((n) => n.kind === 'out');
}
