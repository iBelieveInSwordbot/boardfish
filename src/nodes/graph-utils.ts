// Boardfish 5 — pure graph mutation + query helpers.
//
// All functions are immutable: they return a new NodeGraph rather than
// mutating in place. `useReducer` in NodeEditor.tsx composes them into
// actions.

import type { BaseNode, Edge, NodeGraph, NodeId, NodeKind, NodePort, PortId } from './types';
import { defaultDataFor, defaultPortsFor, newId } from './types';

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
