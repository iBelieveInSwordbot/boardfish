// Boardfish 5 — Node Editor overlay
//
// Weavy.ai-style graph editor built as a self-contained React overlay. Modeled
// on the FiCal retirement-calculator canvas (raw-DOM, single-file) but
// react-ified and split into a reducer + one component.
//
// Coord model (matches FiCal):
//   screen -> canvas: (clientX - rect.left - panOffset.x) / zoom
//   canvas -> screen: canvasX * zoom + panOffset.x + rect.left
//
// The world layer is transformed as one big `translate + scale` container; all
// nodes are positioned in canvas coords inside it. Edges are drawn as a single
// SVG that sits inside the world layer, so they auto-transform with everything
// else.
//
// FiCal-parity interactions (see task boardfish-5-nodeeditor-fical-ux):
//   * Cut / Copy / Paste of node selections with internal edges (⌘X/⌘C/⌘V).
//   * Multi-select: shift-click toggle, drag-select marquee on empty canvas.
//   * Multi-node drag: dragging any selected node moves the whole set.
//   * Wire re-routing: pointerdown on a port with an existing wire "rips" it
//     into a rubber band anchored at the OTHER endpoint. Drop on any valid
//     target to re-route; drop on empty canvas to delete.
//   * Drop-node-on-wire: while dragging a node, if its center is close to a
//     wire and the node has compatible in+out ports, the wire highlights green
//     and, on release, is split into two edges through the node.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { BaseNode, Edge, NodeGraph, NodeId, NodeKind, PortId } from '../nodes/types';
import { emptyGraph, seedDefaultGraph } from '../nodes/types';
import {
  addEdge,
  addNode,
  canConnect,
  canInsertInline,
  copyNodesToClipboard,
  disconnectNode,
  duplicateNode,
  edgesOnPort,
  findOutNode,
  insertNodeOnEdge,
  moveNode,
  moveNodesTo,
  pasteClipboard,
  promoteFrameToCurrent,
  readNodeHistory,
  removeEdge,
  removeNode,
  removeNodes,
  setNodeOutput,
  updateNodeData,
  type NodeClipboard,
} from '../nodes/graph-utils';
import { executeGraph } from '../ai/dag-executor';
import { NODE_KINDS } from '../nodes/registry';
import { PanelRefContext, type PanelRefOption } from '../nodes/registry';
import { NodeView, ContextMenu, type ContextMenuState } from './NodeCanvas';
import { InspectorPane } from './NodeInspector';
import { FalCreditsPill } from './FalCreditsPill';
import './NodeEditor.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type NodeEditorProps = {
  initialGraph: NodeGraph;
  /** Seeds a default TextPrompt when initialGraph is empty. */
  panelPrompt: string;
  /** Seeds the ImageGen aspect on new default graphs. Free-form label. */
  panelAspect: string;
  /** Options fed into the Panel Ref node's picker (id + label + imageDataUrl). */
  availablePanels?: PanelRefOption[];
  /** Persist the graph + Out media to the panel. Does NOT unmount the editor;
   *  App-side lifecycle is controlled by onClose / onDetachedFinish so keep-
   *  alive detachment can be respected. */
  onSave: (
    graph: NodeGraph,
    outMedia:
      | { kind: 'image'; dataUrl: string; mime: string }
      | { kind: 'video'; dataUrl: string; mime: string; posterDataUrl: string | null }
      | null,
  ) => void;
  onClose: () => void;
  /** When true, render as visually hidden but keep the component mounted so
   *  in-flight FAL jobs still deliver results into the store. Used by the
   *  keep-alive stack when the user closes an editor while gens are running. */
  hidden?: boolean;
  /** Fires when a hidden/detached editor's last in-flight gen finishes so the
   *  App can auto-save and unmount it. Never fires while `hidden` is false. */
  onDetachedFinish?: (
    graph: NodeGraph,
    outMedia:
      | { kind: 'image'; dataUrl: string; mime: string }
      | { kind: 'video'; dataUrl: string; mime: string; posterDataUrl: string | null }
      | null,
  ) => void;
  /** Fires when the user hits Close while in-flight gens exist. The App is
   *  expected to hide this editor (set hidden=true) rather than unmount it.
   *  Return true to let the editor also flip to hidden internally; return
   *  false to keep the current visibility. */
  onCloseWhileBusy?: () => boolean;
  /** Fires whenever this editor's in-flight count transitions between
   *  zero and non-zero, so the App can show/hide a spinner on the panel
   *  tile in the storyboard while background gens are cooking. */
  onBusyChange?: (isBusy: boolean) => void;
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

type State = {
  graph: NodeGraph;
  dirty: boolean;
};

type Action =
  | { type: 'MOVE_NODE'; id: NodeId; x: number; y: number }
  | { type: 'MOVE_NODES'; positions: Map<NodeId, { x: number; y: number }> }
  | { type: 'ADD_NODE'; kind: NodeKind; at: { x: number; y: number } }
  | { type: 'REMOVE_NODE'; id: NodeId }
  | { type: 'REMOVE_NODES'; ids: Set<NodeId> }
  | { type: 'DUPLICATE_NODE'; id: NodeId }
  | { type: 'DISCONNECT_NODE'; id: NodeId }
  | { type: 'UPDATE_NODE_DATA'; id: NodeId; patch: Record<string, unknown> }
  | { type: 'ADD_EDGE'; from: Edge['from']; to: Edge['to'] }
  | { type: 'REMOVE_EDGE'; edgeId: string }
  | { type: 'INSERT_ON_EDGE'; edgeId: string; nodeId: NodeId }
  | { type: 'PASTE_GRAPH'; graph: NodeGraph }
  | { type: 'SET_VIEWPORT'; panOffset: { x: number; y: number }; zoom: number }
  | { type: 'SET_NODE_OUTPUT'; id: NodeId; output: BaseNode['output'] }
  | { type: 'PROMOTE_FRAME'; id: NodeId; historyIndex: number }
  | { type: 'SET_GRAPH'; graph: NodeGraph; dirty?: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'MOVE_NODE':
      return { graph: moveNode(state.graph, action.id, action.x, action.y), dirty: true };
    case 'MOVE_NODES':
      return { graph: moveNodesTo(state.graph, action.positions), dirty: true };
    case 'ADD_NODE':
      // Enforce a single Out node per graph — it represents the storyboard
      // panel, so extras would just be dead weight. Any other kind is fine.
      if (action.kind === 'out' && state.graph.nodes.some((n) => n.kind === 'out')) {
        return state;
      }
      return { graph: addNode(state.graph, action.kind, action.at), dirty: true };
    case 'REMOVE_NODE':
      return { graph: removeNode(state.graph, action.id), dirty: true };
    case 'REMOVE_NODES':
      return { graph: removeNodes(state.graph, action.ids), dirty: true };
    case 'DUPLICATE_NODE':
      return { graph: duplicateNode(state.graph, action.id), dirty: true };
    case 'DISCONNECT_NODE':
      return { graph: disconnectNode(state.graph, action.id), dirty: true };
    case 'UPDATE_NODE_DATA':
      return { graph: updateNodeData(state.graph, action.id, action.patch), dirty: true };
    case 'ADD_EDGE': {
      if (!canConnect(state.graph, action.from, action.to)) return state;
      return { graph: addEdge(state.graph, action.from, action.to), dirty: true };
    }
    case 'REMOVE_EDGE':
      return { graph: removeEdge(state.graph, action.edgeId), dirty: true };
    case 'INSERT_ON_EDGE': {
      const next = insertNodeOnEdge(state.graph, action.edgeId, action.nodeId);
      // insertNodeOnEdge returns the same graph if the split isn't valid.
      if (next === state.graph) return state;
      return { graph: next, dirty: true };
    }
    case 'PASTE_GRAPH':
      return { graph: action.graph, dirty: true };
    case 'SET_VIEWPORT':
      // Viewport is not "user work"; don't flip dirty for pan/zoom.
      return {
        ...state,
        graph: { ...state.graph, panOffset: action.panOffset, zoom: action.zoom },
      };
    case 'SET_NODE_OUTPUT':
      return { graph: setNodeOutput(state.graph, action.id, action.output), dirty: true };
    case 'PROMOTE_FRAME':
      return { graph: promoteFrameToCurrent(state.graph, action.id, action.historyIndex), dirty: true };
    case 'SET_GRAPH':
      return { graph: action.graph, dirty: action.dirty ?? true };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3.0;
const NODE_HEADER_H = 32;
const NODE_FOOTER_H = 26; // matches ne-ports bottom offset (leaves room for resize handle)
const PORT_ROW_H = 18;
/** Max distance (canvas px) from a node center to an edge midpoint to trigger the drop-on-wire highlight. */
const DROP_ON_WIRE_RADIUS = 40;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeEditor(props: NodeEditorProps) {
  const { initialGraph, panelPrompt, panelAspect, availablePanels, onSave, onClose, hidden, onDetachedFinish, onCloseWhileBusy, onBusyChange } = props;

  // Seed default 3-node chain if the incoming graph is empty. Applied once.
  const seeded = useMemo<NodeGraph>(() => {
    if (initialGraph.nodes.length > 0) return initialGraph;
    const g = seedDefaultGraph(panelPrompt || '');
    // Also seed the image-gen aspect from panelAspect if provided.
    if (panelAspect) {
      const imgGen = g.nodes.find((n) => n.kind === 'image-gen');
      if (imgGen) imgGen.data = { ...imgGen.data, aspect_ratio: panelAspect };
    }
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, dispatch] = useReducer(reducer, { graph: seeded, dirty: false });
  const graph = state.graph;

  // Signature of every node's position + size. Anything that could shift a
  // port dot in screen space ends up in this string. useLayoutEffect below
  // watches it and bumps `wireTick` post-layout so the SVG re-measures dots.
  const nodeGeometrySig = graph.nodes
    .map((n) => {
      const size = (n.data as Record<string, unknown>).__size as
        | { width?: number; height?: number }
        | undefined;
      return `${n.id}:${n.x},${n.y},${n.width ?? 0}x${n.height ?? 0},${size?.width ?? 0}x${size?.height ?? 0}`;
    })
    .join('|');
  const edgeSig = graph.edges.map((e) => `${e.from.nodeId}.${e.from.portId}>${e.to.nodeId}.${e.to.portId}`).join('|');

  // Selection state. `selectedIds` is the multi-selection set; `primaryId` is
  // whichever node currently drives the inspector (last-selected). Kept in
  // parallel so we don't have to peek into the Set for the inspector.
  const [selectedIds, setSelectedIds] = useState<Set<NodeId>>(new Set());
  const [primaryId, setPrimaryId] = useState<NodeId | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const setSelection = useCallback((ids: Iterable<NodeId>) => {
    const next = new Set(ids);
    setSelectedIds(next);
    if (next.size === 0) setPrimaryId(null);
    else if (next.size === 1) setPrimaryId(next.values().next().value ?? null);
    // If the previous primary is still in the set, keep it.
    else {
      setPrimaryId((prev) => (prev && next.has(prev) ? prev : next.values().next().value ?? null));
    }
  }, []);

  // Refs mirror the latest selection so callbacks that shouldn't re-bind (like
  // window-level keyboard handlers) can read the current value.
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const primaryIdRef = useRef(primaryId);
  useEffect(() => { primaryIdRef.current = primaryId; }, [primaryId]);

  // Clipboard (a normal ref — no need to re-render when it changes).
  const clipboardRef = useRef<NodeClipboard | null>(null);

  // In-flight simulation set — nodes currently "executing" (spinner overlay).
  const [inFlight, setInFlight] = useState<Set<NodeId>>(new Set());

  // Context menu state.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Space-key pan mode.
  // Modifier-key states.
  //  - spaceDown : Space held — pan the canvas by dragging on empty area.
  //                Tapping Space (no drag) opens the fullscreen preview of
  //                the primary selected node, or the big prompt editor if
  //                the selected node is a Text Prompt.
  //  - metaDown  : ⌘/Ctrl held — legacy pan fallback (kept for muscle memory
  //                and for anyone who has a trackpad that eats Space).
  //  - Option/Alt-drag on a node duplicates it (FiCal-style) — checked at
  //    pointer time via e.altKey, no persistent state needed.
  const [spaceDown, setSpaceDown] = useState(false);
  const [metaDown, setMetaDown] = useState(false);
  // Distinguishes a plain Space tap (→ fullscreen) from a Space+drag pan.
  // Flipped true the moment a pan starts while Space is held.
  const spacePannedRef = useRef(false);

  // Fullscreen preview of the currently-selected node's output.
  const [fullscreenNodeId, setFullscreenNodeId] = useState<NodeId | null>(null);
  // Index within the [current, ...history] frames array shown in fullscreen.
  // 0 = current live output, 1+ = older frames (most recent first).
  const [fullscreenIndex, setFullscreenIndex] = useState(0);
  // View mode inside fullscreen: single (default), grid (thumbnails), or
  // compare (side-by-side of a picked subset).
  const [fullscreenMode, setFullscreenMode] = useState<'single' | 'grid' | 'compare'>('single');
  // Grid tile size (px). Slider adjusts it 100–420.
  const [fullscreenGridSize, setFullscreenGridSize] = useState(220);
  // Compare-mode selection: set of frame indices into the frames array.
  const [fullscreenPicks, setFullscreenPicks] = useState<Set<number>>(new Set());
  // Node id whose Text Prompt is open in the large-editor modal.
  const [promptEditorNodeId, setPromptEditorNodeId] = useState<NodeId | null>(null);

  // Listen for the Preview's expand-icon custom event so text-prompt nodes
  // can open the fullscreen editor via mouse without going through the
  // tap-Space codepath (which now no-ops when focus is inside a textarea).
  useEffect(() => {
    function onOpenPromptEditor(e: Event) {
      const detail = (e as CustomEvent).detail as { nodeId?: string } | undefined;
      if (detail?.nodeId) setPromptEditorNodeId(detail.nodeId);
    }
    window.addEventListener('boardfish:open-prompt-editor', onOpenPromptEditor);
    return () => window.removeEventListener('boardfish:open-prompt-editor', onOpenPromptEditor);
  }, []);

  /**
   * Close the fullscreen overlay. If the user navigated to a history frame
   * (index > 0), promote it to be the node's current output so what they
   * left it on is what the node shows.
   */
  const closeFullscreen = useCallback(() => {
    const nid = fullscreenNodeId;
    if (!nid) return;
    const n = graphRef.current.nodes.find((x) => x.id === nid);
    if (n) {
      const frames = getFullscreenFrames(n);
      if (frames.length > 1 && fullscreenIndex > 0) {
        // frames array is [current, ...historyNewestFirst]. History index in
        // the ORIGINAL (oldest-first) array = history.length - fullscreenIndex.
        const hist = readNodeHistory(n);
        const historyIndex = hist.length - fullscreenIndex;
        if (historyIndex >= 0 && historyIndex < hist.length) {
          dispatch({ type: 'PROMOTE_FRAME', id: nid, historyIndex });
        }
      }
    }
    setFullscreenNodeId(null);
    setFullscreenIndex(0);
    setFullscreenMode('single');
    setFullscreenPicks(new Set());
  }, [fullscreenNodeId, fullscreenIndex]);

  // Refs for DOM / interaction state that shouldn't cause re-renders.
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Bumper that forces the edge SVG to re-render after DOM layout so
  // portCanvasPos()'s DOM-measurement path picks up real dot positions on
  // the frame AFTER any graph change (add node, move, resize).
  const [, setWireTick] = useState(0);
  useLayoutEffect(() => {
    // Two rAFs so the browser has actually laid nodes out before we
    // re-measure. React commits the DOM synchronously here, but the layout
    // pass happens before paint; two rAFs is a robust hedge across engines.
    const r1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => setWireTick((t) => t + 1));
    });
    return () => cancelAnimationFrame(r1);
  }, [nodeGeometrySig, edgeSig, graph.zoom, graph.panOffset.x, graph.panOffset.y]);
  const panningRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const draggingRef = useRef<{
    /** The node that received the pointerdown (drag anchor). */
    anchorId: NodeId;
    /** Offset from pointerdown point to anchor node's (x,y) in canvas coords. */
    offsetX: number;
    offsetY: number;
    /** Original positions for every node in the drag set. */
    startPositions: Map<NodeId, { x: number; y: number }>;
    /** Anchor's current center (for drop-on-wire hit-test). */
    anchorCenter: { x: number; y: number };
    /** Bounding size of the anchor node (so center is correct). */
    anchorSize: { w: number; h: number };
    /** Whether we've moved past the drag threshold; below it we treat as click. */
    started: boolean;
    /** Screen coord of pointerdown; used to detect "started". */
    downClient: { x: number; y: number };
    /** True if the shift/meta was held on pointerdown (so a click "toggles" instead of "replaces"). */
    additive: boolean;
  } | null>(null);
  const connectRef = useRef<{
    /** Where the rubber band is anchored (the port that STAYS). */
    from: { nodeId: NodeId; portId: PortId; side: 'in' | 'out' };
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    /** If truthy, this drag started by ripping an existing edge; drop-on-empty deletes it. */
    ripEdgeId: string | null;
  } | null>(null);
  // Force a re-render during rubber-band / marquee drag without spamming reducer state.
  const [interactionTick, setInteractionTick] = useState(0);
  const bumpTick = useCallback(() => setInteractionTick((t) => t + 1), []);

  // Marquee selection state (drag-select rectangle).
  const marqueeRef = useRef<{ startX: number; startY: number; curX: number; curY: number; additive: boolean } | null>(null);

  // After a header pointerdown/pointerup pair, the browser also fires a click.
  // We already handled the selection change in pointerdown, so tell the click
  // handler to skip. Cleared on the next pointerdown so subsequent clicks work.
  const suppressNextClickRef = useRef<NodeId | null>(null);

  // Drop-on-wire candidate — the edge that will be replaced with two if the
  // current drag releases now. Kept in state so the wire re-colors.
  const [insertCandidateEdgeId, setInsertCandidateEdgeId] = useState<string | null>(null);

  // Confirm-close dialog.
  const [confirmClose, setConfirmClose] = useState(false);

  // Keep dirtyRef in sync so keyboard handlers see the latest value.
  const dirtyRef = useRef(state.dirty);
  useEffect(() => { dirtyRef.current = state.dirty; }, [state.dirty]);

  // -------------------------------------------------------------------------
  // Coord helpers
  // -------------------------------------------------------------------------

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - graph.panOffset.x) / graph.zoom,
        y: (clientY - rect.top - graph.panOffset.y) / graph.zoom,
      };
    },
    [graph.panOffset.x, graph.panOffset.y, graph.zoom],
  );

  /**
   * Port center in CANVAS coords (matches the SVG world layer).
   *
   * Strategy: measure the actual port dot's bounding rect in screen space,
   * then convert to canvas coords via the current pan/zoom transform. This
   * makes wires literally parented to the dots — no more JS<->CSS geometry
   * math to keep in sync, and no more drift when nodes are resized.
   *
   * Fallback: if the dot isn't in the DOM yet (initial paint before refs
   * mount, or a node just added by the reducer), compute an approximate
   * position from the node's data using the header/footer/pitch constants.
   * That approximation is only used for one frame; the next render will find
   * the DOM element and switch to the exact measurement.
   */
  const portCanvasPos = useCallback(
    (node: BaseNode, portId: PortId): { x: number; y: number } | null => {
      const port = node.ports.find((p) => p.id === portId);
      if (!port) return null;

      // Preferred path: read the exact center of the rendered dot.
      const dot = document.querySelector<HTMLElement>(
        `[data-port-node="${node.id}"][data-port-id="${portId}"]`,
      );
      const canvasEl = canvasRef.current;
      if (dot && canvasEl) {
        const dotRect = dot.getBoundingClientRect();
        // Zero-sized rect => dot hasn't laid out yet (initial paint). Fall
        // through to the approximate math and let a subsequent render pick
        // up the real measurement.
        if (dotRect.width > 0 && dotRect.height > 0) {
          const canvasRect = canvasEl.getBoundingClientRect();
          const zoom = graph.zoom || 1;
          const panX = graph.panOffset.x;
          const panY = graph.panOffset.y;
          // Convert screen-space dot center to canvas coords.
          //   screenX = canvasX * zoom + panX + canvasRect.left
          //   canvasX = (screenX - canvasRect.left - panX) / zoom
          const cxScreen = dotRect.left + dotRect.width / 2;
          const cyScreen = dotRect.top + dotRect.height / 2;
          const x = (cxScreen - canvasRect.left - panX) / zoom;
          const y = (cyScreen - canvasRect.top - panY) / zoom;
          return { x, y };
        }
      }

      // Fallback approximation (used on the very first render before the dot
      // element mounts). Same math as the previous JS-only path.
      const def = NODE_KINDS[node.kind];
      const w = node.width ?? def.defaultWidth;
      const h = node.height ?? def.defaultHeight;
      const sideList = node.ports.filter((p) => p.side === port.side);
      const idx = sideList.findIndex((p) => p.id === portId);
      const availTop = node.y + NODE_HEADER_H;
      const availBot = node.y + h - NODE_FOOTER_H;
      const availMid = (availTop + availBot) / 2;
      const gap = PORT_ROW_H;
      const total = sideList.length;
      const y = availMid + (idx - (total - 1) / 2) * gap;
      const x = port.side === 'in' ? node.x : node.x + w;
      return { x, y };
    },
    [graph.zoom, graph.panOffset.x, graph.panOffset.y],
  );

  const nodeCenter = useCallback((node: BaseNode) => {
    const def = NODE_KINDS[node.kind];
    const w = node.width ?? def.defaultWidth;
    const h = node.height ?? def.defaultHeight;
    return { x: node.x + w / 2, y: node.y + h / 2, w, h };
  }, []);

  // Latest graph in a ref so callbacks can read fresh values without re-binding.
  const graphRef = useRef<NodeGraph>(state.graph);
  useEffect(() => { graphRef.current = state.graph; }, [state.graph]);

  // -------------------------------------------------------------------------
  // Auto-refresh Out node whenever its upstream chain changes.
  // Signature = set of edges feeding Out + the output-dataUrl fingerprint of
  // each upstream node reachable from Out. When either changes we re-run
  // Out (which is a cheap gather step — no model calls). Skips when nothing
  // upstream has produced media yet, and while any node is in-flight.
  // -------------------------------------------------------------------------
  const inFlightRef = useRef<Set<NodeId>>(new Set());
  useEffect(() => {
    const prevBusy = inFlightRef.current.size > 0;
    inFlightRef.current = inFlight;
    const nowBusy = inFlight.size > 0;
    if (prevBusy !== nowBusy && onBusyChange) onBusyChange(nowBusy);
  }, [inFlight, onBusyChange]);
  const lastOutSigRef = useRef<string>('');
  const outRefreshTimerRef = useRef<number | null>(null);

  const outSignature = useMemo(() => {
    const out = graph.nodes.find((n) => n.kind === 'out');
    if (!out) return '';
    // BFS upstream from Out through incoming edges.
    const incoming = new Map<NodeId, Edge[]>();
    for (const e of graph.edges) {
      const arr = incoming.get(e.to.nodeId) ?? [];
      arr.push(e);
      incoming.set(e.to.nodeId, arr);
    }
    const upstream = new Set<NodeId>();
    const stack: NodeId[] = [out.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of incoming.get(cur) ?? []) {
        if (!upstream.has(e.from.nodeId)) {
          upstream.add(e.from.nodeId);
          stack.push(e.from.nodeId);
        }
      }
    }
    // Edge signature: which edges terminate on Out (sorted for stability).
    const outEdges = graph.edges
      .filter((e) => e.to.nodeId === out.id)
      .map((e) => `${e.from.nodeId}:${e.from.portId}->${e.to.portId}`)
      .sort()
      .join('|');
    // Upstream media signature: which upstream nodes have output and what.
    // With PROMOTE_FRAME-based heart, the current output changes when a user
    // hearts a variant, so the dataUrl fingerprint captures the change.
    const media = graph.nodes
      .filter((n) => upstream.has(n.id))
      .map((n) => {
        const o = n.output;
        if (!o) return `${n.id}:_`;
        const url = (o as { dataUrl?: string }).dataUrl ?? '';
        const fp = url ? `${url.slice(0, 24)}…${url.slice(-24)}` : '_';
        return `${n.id}:${o.kind}:${fp}`;
      })
      .sort()
      .join('|');
    return `edges=${outEdges}||media=${media}`;
  }, [graph]);

  useEffect(() => {
    if (!outSignature) return;
    if (outSignature === lastOutSigRef.current) return;
    // Skip auto-refresh while anything is in-flight — the in-flight run will
    // deliver an output event that triggers the next signature change.
    if (inFlightRef.current.size > 0) return;
    // Skip when the current Out output already matches what upstream produced
    // (i.e., signature seeded from a save/manual refresh).
    if (lastOutSigRef.current === '') {
      lastOutSigRef.current = outSignature;
      return;
    }
    // Debounce so rapid edits (dragging a slider, typing prompt) don't fire
    // a refresh on every keystroke. 200ms is plenty.
    if (outRefreshTimerRef.current != null) {
      window.clearTimeout(outRefreshTimerRef.current);
    }
    outRefreshTimerRef.current = window.setTimeout(async () => {
      outRefreshTimerRef.current = null;
      const outNode = findOutNode(graphRef.current);
      if (!outNode) return;
      const hasUpstream = graphRef.current.edges.some((e) => e.to.nodeId === outNode.id);
      const upstreamHasMedia = hasUpstream && graphRef.current.nodes.some((n) =>
        graphRef.current.edges.some((e) => e.to.nodeId === outNode.id && e.from.nodeId === n.id) &&
        n.output && (n.output.kind === 'image' || n.output.kind === 'video') &&
        Boolean(n.output.dataUrl),
      );
      if (!hasUpstream || !upstreamHasMedia) {
        // No upstream media — clear Out.
        if (outNode.output) {
          dispatch({ type: 'SET_NODE_OUTPUT', id: outNode.id, output: undefined });
        }
        lastOutSigRef.current = outSignature;
        return;
      }
      try {
        await executeGraph(graphRef.current, {
          startAt: outNode.id,
          onEvent: (e) => {
            if (e.kind === 'output') {
              if (e.dataPatch) {
                dispatch({ type: 'UPDATE_NODE_DATA', id: e.nodeId, patch: e.dataPatch });
              }
              dispatch({ type: 'SET_NODE_OUTPUT', id: e.nodeId, output: e.output });
            }
          },
        });
      } catch (err) {
        console.warn('[NodeEditor] Out auto-refresh failed:', err);
      } finally {
        lastOutSigRef.current = outSignature;
      }
    }, 200);
    return () => {
      if (outRefreshTimerRef.current != null) {
        window.clearTimeout(outRefreshTimerRef.current);
        outRefreshTimerRef.current = null;
      }
    };
    // dispatch is stable from useReducer
  }, [outSignature, dispatch]);

  // -------------------------------------------------------------------------
  // Save / close
  // -------------------------------------------------------------------------

  /** Build the outMedia object for the current Out node output (or null if
   *  Out has no media). Shared between triggerSave and the detached-finish
   *  auto-save path. Does not run the graph — caller should refresh first if
   *  they need latest outputs. */
  const outMediaFromGraph = useCallback(async (g: NodeGraph) => {
    const out = findOutNode(g);
    if (!out || !out.output || !out.output.dataUrl) return null;
    if (out.output.kind === 'image') {
      return {
        kind: 'image' as const,
        dataUrl: out.output.dataUrl,
        mime: out.output.mime ?? 'image/png',
      };
    }
    if (out.output.kind === 'video') {
      let poster: string | null = null;
      try {
        poster = await extractVideoPoster(out.output.dataUrl);
      } catch {
        poster = null;
      }
      return {
        kind: 'video' as const,
        dataUrl: out.output.dataUrl,
        mime: out.output.mime ?? 'video/mp4',
        posterDataUrl: poster,
      };
    }
    return null;
  }, []);

  // Detached-finish: when hidden AND inFlight drops to 0, refresh the Out
  // node (so it captures the latest gen), then auto-save via onDetachedFinish
  // so the App can unmount us. Requires that at least one gen actually ran
  // while hidden (otherwise the very act of setting hidden would fire finish
  // before anything happens).
  const hadInFlightWhileHiddenRef = useRef(false);
  useEffect(() => {
    if (!hidden) {
      hadInFlightWhileHiddenRef.current = false;
      return;
    }
    if (inFlight.size > 0) {
      hadInFlightWhileHiddenRef.current = true;
      return;
    }
    if (!hadInFlightWhileHiddenRef.current || !onDetachedFinish) return;
    hadInFlightWhileHiddenRef.current = false;
    (async () => {
      // Force Out to refresh with the just-landed producer outputs BEFORE
      // we extract outMedia. Otherwise the panel receives stale Out output
      // from the pre-gen state.
      const outNodeNow = findOutNode(graphRef.current);
      if (outNodeNow) {
        const hasUpstream = graphRef.current.edges.some((e) => e.to.nodeId === outNodeNow.id);
        if (hasUpstream) {
          try {
            await executeGraph(graphRef.current, {
              startAt: outNodeNow.id,
              onEvent: (ev) => {
                if (ev.kind === 'output') {
                  if (ev.dataPatch) {
                    dispatch({ type: 'UPDATE_NODE_DATA', id: ev.nodeId, patch: ev.dataPatch });
                  }
                  dispatch({ type: 'SET_NODE_OUTPUT', id: ev.nodeId, output: ev.output });
                  // Manually update graphRef so the subsequent read sees
                  // the fresh Out output without waiting for React commit.
                  graphRef.current = {
                    ...graphRef.current,
                    nodes: graphRef.current.nodes.map((nn) =>
                      nn.id === ev.nodeId ? { ...nn, output: ev.output } : nn,
                    ),
                  };
                }
              },
            });
          } catch (err) {
            console.warn('[NodeEditor] Detached Out refresh failed:', err);
          }
        }
      }
      const media = await outMediaFromGraph(graphRef.current);
      onDetachedFinish(graphRef.current, media);
    })();
  }, [hidden, inFlight, onDetachedFinish, outMediaFromGraph]);

  const triggerSave = useCallback(async () => {
    // Matt's rule: on save, always refresh the Out node from upstream so the
    // storyboard panel picks up whatever the current graph would produce
    // (rather than stale cached Out output from the last manual generate).
    // We only re-run when the Out node has upstream edges AND the upstream
    // chain has produced at least one media output somewhere (otherwise the
    // save-just-to-close case would kick off a wasted generation).
    let workingGraph = graphRef.current;
    const outNodeForRefresh = findOutNode(workingGraph);
    if (outNodeForRefresh) {
      const hasUpstream = workingGraph.edges.some((e) => e.to.nodeId === outNodeForRefresh.id);
      // Only bother if there's an upstream node with real media output already.
      // (Skips the "save immediately after open, nothing generated yet" case.)
      const upstreamHasMedia = hasUpstream && workingGraph.nodes.some((n) =>
        workingGraph.edges.some((e) => e.to.nodeId === outNodeForRefresh.id && e.from.nodeId === n.id) &&
        n.output && (n.output.kind === 'image' || n.output.kind === 'video') &&
        Boolean(n.output.dataUrl),
      );
      if (upstreamHasMedia) {
        try {
          workingGraph = await executeGraph(workingGraph, {
            startAt: outNodeForRefresh.id,
            onEvent: (e) => {
              if (e.kind === 'output') {
                if (e.dataPatch) {
                  dispatch({ type: 'UPDATE_NODE_DATA', id: e.nodeId, patch: e.dataPatch });
                }
                dispatch({ type: 'SET_NODE_OUTPUT', id: e.nodeId, output: e.output });
              }
            },
          });
          // Keep graphRef in lockstep so the rest of this function reads the
          // freshly-refreshed working graph.
          graphRef.current = workingGraph;
        } catch (err) {
          // Never block save on a refresh failure — fall back to the last
          // known Out output and surface the error to the console.
          console.warn('[NodeEditor] Out refresh failed, saving stale output:', err);
        }
      }
    }

    const out = findOutNode(workingGraph);
    if (!out || !out.output || !out.output.dataUrl) {
      onSave(workingGraph, null);
      return;
    }
    if (out.output.kind === 'image') {
      onSave(workingGraph, {
        kind: 'image',
        dataUrl: out.output.dataUrl,
        mime: out.output.mime ?? 'image/png',
      });
      return;
    }
    if (out.output.kind === 'video') {
      // Extract the first frame as a still so the storyboard panel + PDF
      // export have something to render even when the underlying media is
      // a video. Fall back to null poster on failure.
      let poster: string | null = null;
      try {
        poster = await extractVideoPoster(out.output.dataUrl);
      } catch {
        poster = null;
      }
      onSave(workingGraph, {
        kind: 'video',
        dataUrl: out.output.dataUrl,
        mime: out.output.mime ?? 'video/mp4',
        posterDataUrl: poster,
      });
      return;
    }
    onSave(workingGraph, null);
  }, [onSave, dispatch]);

  /** Unmount OR detach the editor, whichever preserves in-flight gens.
   *  Called from every close pathway (top-bar X, Escape, confirm-dialog
   *  buttons) so no code path can accidentally kill a running FAL job. */
  const finishClose = useCallback(() => {
    if (inFlightRef.current.size > 0 && onCloseWhileBusy) {
      onCloseWhileBusy();
      return;
    }
    onClose();
  }, [onClose, onCloseWhileBusy]);

  const triggerClose = useCallback(() => {
    // If any gens are still running, prefer keep-alive over unmount so
    // Matt can bounce back to the storyboard while things finish. The App
    // hides us via `hidden` prop; we keep receiving FAL results and, when
    // the last one lands, dispatch onDetachedFinish so the App can save
    // and unmount us. This SUPERSEDES the dirty-check so the user never
    // has to click through a dialog while things are cooking.
    if (inFlightRef.current.size > 0 && onCloseWhileBusy) {
      onCloseWhileBusy();
      return;
    }
    if (dirtyRef.current) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  }, [onClose, onCloseWhileBusy]);

  // Save-Image and Export-XML top-bar buttons were removed 2026-07-15 per
  // Matt's spec. Per-node media download (⬇ icon in the media toolbar) covers
  // one-off saves; project-wide save goes through the storyboard export flow.

  // -------------------------------------------------------------------------
  // Clipboard actions (⌘X / ⌘C / ⌘V)
  // -------------------------------------------------------------------------

  const doCopy = useCallback(() => {
    const ids = selectedIdsRef.current;
    if (ids.size === 0) return;
    clipboardRef.current = copyNodesToClipboard(graphRef.current, ids);
  }, []);

  const doCut = useCallback(() => {
    const ids = selectedIdsRef.current;
    if (ids.size === 0) return;
    clipboardRef.current = copyNodesToClipboard(graphRef.current, ids);
    dispatch({ type: 'REMOVE_NODES', ids: new Set(ids) });
    setSelection([]);
  }, [setSelection]);

  const doPaste = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    const { graph: next, newIds } = pasteClipboard(graphRef.current, clip, 20, 20);
    dispatch({ type: 'PASTE_GRAPH', graph: next });
    setSelection(newIds);
  }, [setSelection]);

  const doSelectAll = useCallback(() => {
    setSelection(graphRef.current.nodes.map((n) => n.id));
  }, [setSelection]);

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  useEffect(() => {
    // When keep-alive-hidden, don't hijack global keys — the storyboard
    // owns them again so Matt can navigate panels while gens run.
    if (hidden) return undefined;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Global (fire even in fields):
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        triggerSave();
        return;
      }

      if (e.key === 'Escape') {
        if (contextMenu) { setContextMenu(null); return; }
        if (fullscreenNodeId) { e.preventDefault(); closeFullscreen(); return; }
        if (promptEditorNodeId) { e.preventDefault(); setPromptEditorNodeId(null); return; }
        if (!inField) {
          e.preventDefault();
          // If we have a multi-selection, clear it first; else close the editor.
          if (selectedIdsRef.current.size > 0 || selectedEdgeId) {
            setSelection([]);
            setSelectedEdgeId(null);
            return;
          }
          triggerClose();
        }
        return;
      }

      if (inField) return; // don't hijack typing

      // Track ⌘/Ctrl state so pointer handlers can react (⌘-drag = pan).
      if (e.metaKey || e.ctrlKey) setMetaDown(true);

      // Clipboard shortcuts.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') { e.preventDefault(); doCopy();  return; }
        if (k === 'x') { e.preventDefault(); doCut();   return; }
        if (k === 'v') { e.preventDefault(); doPaste(); return; }
        if (k === 'a') { e.preventDefault(); doSelectAll(); return; }
      }

      if (e.key === ' ') {
        // Space: while held, drag on empty canvas pans. Tapping Space (no
        // drag) is decided on keyup — if we didn't pan, treat it as
        // "preview the selected node" or "open the big prompt editor" for
        // text-prompt nodes.
        if (!spaceDown) {
          spacePannedRef.current = false;
          setSpaceDown(true);
        }
        e.preventDefault();
        return;
      }

      // Arrow keys in fullscreen: navigate through this node's frames
      // (current output + history, newest first).
      if (fullscreenNodeId && fullscreenMode === 'single' &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const fn = graphRef.current.nodes.find((x) => x.id === fullscreenNodeId);
        if (!fn) return;
        const frames = getFullscreenFrames(fn);
        if (frames.length <= 1) return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        setFullscreenIndex((i) => (i + dir + frames.length) % frames.length);
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedIdsRef.current.size > 0) {
          e.preventDefault();
          dispatch({ type: 'REMOVE_NODES', ids: new Set(selectedIdsRef.current) });
          setSelection([]);
          return;
        }
        if (selectedEdgeId) {
          e.preventDefault();
          dispatch({ type: 'REMOVE_EDGE', edgeId: selectedEdgeId });
          setSelectedEdgeId(null);
          return;
        }
      }

      // F  = fit all nodes to canvas. Computes the bounding box of every node,
      // adds a small margin, and picks a pan/zoom that centers everything.
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        const g = graphRef.current;
        if (!g.nodes.length) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of g.nodes) {
          const def = NODE_KINDS[n.kind];
          const w = n.width ?? def.defaultWidth;
          const h = n.height ?? def.defaultHeight;
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x + w > maxX) maxX = n.x + w;
          if (n.y + h > maxY) maxY = n.y + h;
        }
        const margin = 60;
        const bw = (maxX - minX) + margin * 2;
        const bh = (maxY - minY) + margin * 2;
        const zx = rect.width / bw;
        const zy = rect.height / bh;
        const zoom = clamp(Math.min(zx, zy), MIN_ZOOM, MAX_ZOOM);
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const panOffset = {
          x: rect.width / 2 - centerX * zoom,
          y: rect.height / 2 - centerY * zoom,
        };
        dispatch({ type: 'SET_VIEWPORT', panOffset, zoom });
        return;
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) setMetaDown(false);
      if (e.key === ' ') {
        // If focus is in an editable field the Space keydown was NOT tracked
        // (spaceDown stayed false) — don't fire the tap action here either,
        // otherwise typing a space in the Text Prompt inline textarea would
        // pop the fullscreen editor as soon as the space key is released.
        const target = e.target as HTMLElement | null;
        const inField =
          target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (inField) {
          // Reset any stale pan flag but don't fire the tap action.
          spacePannedRef.current = false;
          setSpaceDown(false);
          return;
        }
        // Only fire the tap action if we didn't actually pan.
        if (!spacePannedRef.current) {
          const pid = primaryIdRef.current;
          if (fullscreenNodeId) {
            closeFullscreen();
          } else if (promptEditorNodeId) {
            setPromptEditorNodeId(null);
          } else if (pid) {
            const n = graphRef.current.nodes.find((x) => x.id === pid);
            if (n?.kind === 'text-prompt') {
              setPromptEditorNodeId(pid);
            } else if (n) {
              setFullscreenIndex(0);
              setFullscreenMode('single');
              setFullscreenPicks(new Set());
              setFullscreenNodeId(pid);
            }
          }
        }
        spacePannedRef.current = false;
        setSpaceDown(false);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    triggerSave, triggerClose, selectedEdgeId, contextMenu, doCopy, doCut,
    doPaste, doSelectAll, setSelection, fullscreenNodeId, promptEditorNodeId, spaceDown,
    closeFullscreen, fullscreenMode, hidden,
  ]);

  // -------------------------------------------------------------------------
  // Pan / zoom / marquee
  // -------------------------------------------------------------------------

  function onCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const onEmpty =
      target === canvasRef.current ||
      target.classList.contains('ne-world') ||
      target.classList.contains('ne-grid') ||
      target.classList.contains('ne-edges');
    if (!onEmpty) return;

    // Pull keyboard focus off any inspector/text-prompt textarea so keyboard
    // shortcuts (⌘X to cut selection, Space to preview, etc.) work again.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      active.blur();
    }

    // Pan on: middle-button drag, or space-drag, or ⌘/Ctrl-drag as legacy fallback.
    const wantsPan =
      e.button === 1 ||
      (e.button === 0 && (spaceDown || metaDown));
    if (wantsPan) {
      // Remember that this Space press produced a pan, so the keyup handler
      // doesn't treat it as a "tap Space to fullscreen" gesture.
      if (spaceDown) spacePannedRef.current = true;
      panningRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panX: graph.panOffset.x,
        panY: graph.panOffset.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 0) {
      // Start a marquee. If the user isn't holding shift, clear existing
      // selection right away — feels more responsive than waiting for release.
      const additive = e.shiftKey || e.metaKey;
      if (!additive) {
        setSelection([]);
        setSelectedEdgeId(null);
      }
      setContextMenu(null);
      const c = screenToCanvas(e.clientX, e.clientY);
      marqueeRef.current = { startX: c.x, startY: c.y, curX: c.x, curY: c.y, additive };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      bumpTick();
    }
  }

  function onCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    // Pan.
    if (panningRef.current) {
      const dx = e.clientX - panningRef.current.startX;
      const dy = e.clientY - panningRef.current.startY;
      dispatch({
        type: 'SET_VIEWPORT',
        panOffset: { x: panningRef.current.panX + dx, y: panningRef.current.panY + dy },
        zoom: graph.zoom,
      });
      return;
    }
    // Marquee update.
    if (marqueeRef.current) {
      const c = screenToCanvas(e.clientX, e.clientY);
      marqueeRef.current.curX = c.x;
      marqueeRef.current.curY = c.y;
      bumpTick();
      return;
    }
    // Node drag.
    if (draggingRef.current) {
      const dr = draggingRef.current;
      // Consider the drag "started" after a small threshold so a plain click
      // doesn't move the node by a subpixel.
      if (!dr.started) {
        const dx = e.clientX - dr.downClient.x;
        const dy = e.clientY - dr.downClient.y;
        if (dx * dx + dy * dy < 9) return; // 3px threshold
        dr.started = true;
      }
      const cur = screenToCanvas(e.clientX, e.clientY);
      const anchorStart = dr.startPositions.get(dr.anchorId);
      if (!anchorStart) return;
      const targetAnchorX = cur.x - dr.offsetX;
      const targetAnchorY = cur.y - dr.offsetY;
      const dx = targetAnchorX - anchorStart.x;
      const dy = targetAnchorY - anchorStart.y;
      const positions = new Map<NodeId, { x: number; y: number }>();
      for (const [id, p] of dr.startPositions) {
        positions.set(id, { x: p.x + dx, y: p.y + dy });
      }
      dr.anchorCenter = {
        x: targetAnchorX + dr.anchorSize.w / 2,
        y: targetAnchorY + dr.anchorSize.h / 2,
      };
      dispatch({ type: 'MOVE_NODES', positions });

      // Drop-on-wire hit test: only when dragging a single node that can be
      // inserted inline (both in-port and out-port exist).
      if (dr.startPositions.size === 1) {
        const anchor = graphRef.current.nodes.find((n) => n.id === dr.anchorId);
        if (anchor && canInsertInline(anchor)) {
          const cand = pickWireForInsert(anchor, dr.anchorCenter);
          setInsertCandidateEdgeId(cand);
        } else if (insertCandidateEdgeId) {
          setInsertCandidateEdgeId(null);
        }
      }
      return;
    }
    // Rubber-band connection drag.
    if (connectRef.current) {
      const cur = screenToCanvas(e.clientX, e.clientY);
      connectRef.current.curX = cur.x;
      connectRef.current.curY = cur.y;
      bumpTick();
    }
  }

  function onCanvasPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panningRef.current) {
      panningRef.current = null;
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      const x1 = Math.min(m.startX, m.curX);
      const y1 = Math.min(m.startY, m.curY);
      const x2 = Math.max(m.startX, m.curX);
      const y2 = Math.max(m.startY, m.curY);
      // Empty (or near-empty) drag: treat as click on empty canvas, don't select anything.
      if ((x2 - x1) > 3 || (y2 - y1) > 3) {
        const hits: NodeId[] = [];
        for (const n of graphRef.current.nodes) {
          const c = nodeCenter(n);
          const nx1 = n.x, ny1 = n.y, nx2 = n.x + c.w, ny2 = n.y + c.h;
          const intersects = !(nx2 < x1 || nx1 > x2 || ny2 < y1 || ny1 > y2);
          if (intersects) hits.push(n.id);
        }
        if (m.additive) {
          const merged = new Set(selectedIdsRef.current);
          for (const id of hits) merged.add(id);
          setSelection(merged);
        } else {
          setSelection(hits);
        }
      }
      marqueeRef.current = null;
      bumpTick();
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    if (draggingRef.current) {
      const dr = draggingRef.current;
      draggingRef.current = null;
      // If we didn't move past threshold, treat this pointerup as a click.
      if (!dr.started) {
        // Handled by the header click handler already; nothing to do here.
      } else if (insertCandidateEdgeId && dr.startPositions.size === 1) {
        // Commit the drop-on-wire insert.
        dispatch({ type: 'INSERT_ON_EDGE', edgeId: insertCandidateEdgeId, nodeId: dr.anchorId });
      }
      setInsertCandidateEdgeId(null);
    }
    if (connectRef.current) {
      const cr = connectRef.current;
      connectRef.current = null;
      // Hit-test whatever's under the cursor: is it a port dot?
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const portEl = el && (el as HTMLElement).closest('[data-port-node][data-port-id]');
      if (portEl) {
        const targetNodeId = (portEl as HTMLElement).dataset.portNode!;
        const targetPortId = (portEl as HTMLElement).dataset.portId!;
        const targetSide = (portEl as HTMLElement).dataset.portSide as 'in' | 'out';
        // The rubber band is anchored at `cr.from`. Which end lands on the
        // dropped port depends on the anchor's side.
        //   anchor is 'out'  -> new/re-routed edge from anchor -> target (must be 'in')
        //   anchor is 'in'   -> new/re-routed edge from target (must be 'out') -> anchor
        let addedOrKept = false;
        if (cr.from.side === 'out' && targetSide === 'in') {
          // First, if we ripped an edge, remove it so the cycle check doesn't fail against it.
          const workingGraph = cr.ripEdgeId
            ? { ...graphRef.current, edges: graphRef.current.edges.filter((ed) => ed.id !== cr.ripEdgeId) }
            : graphRef.current;
          const ok = canConnect(workingGraph, cr.from, { nodeId: targetNodeId, portId: targetPortId });
          if (ok) {
            if (cr.ripEdgeId) dispatch({ type: 'REMOVE_EDGE', edgeId: cr.ripEdgeId });
            dispatch({
              type: 'ADD_EDGE',
              from: cr.from,
              to: { nodeId: targetNodeId, portId: targetPortId },
            });
            addedOrKept = true;
          }
        } else if (cr.from.side === 'in' && targetSide === 'out') {
          const workingGraph = cr.ripEdgeId
            ? { ...graphRef.current, edges: graphRef.current.edges.filter((ed) => ed.id !== cr.ripEdgeId) }
            : graphRef.current;
          const proposed = {
            from: { nodeId: targetNodeId, portId: targetPortId },
            to: { nodeId: cr.from.nodeId, portId: cr.from.portId },
          };
          const ok = canConnect(workingGraph, proposed.from, proposed.to);
          if (ok) {
            if (cr.ripEdgeId) dispatch({ type: 'REMOVE_EDGE', edgeId: cr.ripEdgeId });
            dispatch({ type: 'ADD_EDGE', from: proposed.from, to: proposed.to });
            addedOrKept = true;
          }
        }
        // If we were ripping and didn't successfully attach, delete the wire.
        // (Rip + drop on invalid target == delete, matching the wire-drag feel
        // where letting go over empty space discards the connection.)
        if (!addedOrKept && cr.ripEdgeId) {
          dispatch({ type: 'REMOVE_EDGE', edgeId: cr.ripEdgeId });
        }
      } else if (cr.ripEdgeId) {
        // Dropped on empty canvas while ripping -> delete the edge.
        dispatch({ type: 'REMOVE_EDGE', edgeId: cr.ripEdgeId });
      }
      bumpTick();
    }
  }

  // Non-passive wheel listener: React attaches onWheel as passive by default,
  // which means our preventDefault() there would be a no-op (browser still
  // scrolls the page). We attach a native non-passive listener on the canvas
  // element and delegate to the same handler logic.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      // Only preventDefault for wheels over the canvas. The event listener is
      // already scoped to the canvas element, so this is always safe.
      ev.preventDefault();
      // Call the React handler synchronously with a shim that carries the
      // fields we actually read.
      onCanvasWheel({
        deltaX: ev.deltaX,
        deltaY: ev.deltaY,
        clientX: ev.clientX,
        clientY: ev.clientY,
        metaKey: ev.metaKey,
        ctrlKey: ev.ctrlKey,
        preventDefault: () => ev.preventDefault(),
      } as unknown as ReactWheelEvent<HTMLDivElement>);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.panOffset.x, graph.panOffset.y, graph.zoom]);

  function onCanvasWheel(e: ReactWheelEvent<HTMLDivElement>) {
    // Wheel behavior mirrors Figma / Weavy:
    //   - plain wheel / 2-finger trackpad scroll → PAN
    //   - ⌘ (macOS) or Ctrl (elsewhere) + wheel → ZOOM centered on cursor
    //   - pinch-zoom (deltaY with ctrlKey=true synthesized by macOS) → ZOOM
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Note: macOS trackpad pinch fires wheel events with ctrlKey=true even
    // though no key is pressed. Treat metaKey OR ctrlKey as zoom.
    if (e.metaKey || e.ctrlKey) {
      const factor = 1 + (-e.deltaY / 200);
      const nextZoom = clamp(graph.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const worldX = (cx - graph.panOffset.x) / graph.zoom;
      const worldY = (cy - graph.panOffset.y) / graph.zoom;
      const nextPan = {
        x: cx - worldX * nextZoom,
        y: cy - worldY * nextZoom,
      };
      dispatch({ type: 'SET_VIEWPORT', panOffset: nextPan, zoom: nextZoom });
      return;
    }

    // Plain scroll: pan the canvas. Positive deltaY moves content up.
    const nextPan = {
      x: graph.panOffset.x - e.deltaX,
      y: graph.panOffset.y - e.deltaY,
    };
    dispatch({ type: 'SET_VIEWPORT', panOffset: nextPan, zoom: graph.zoom });
  }

  // -------------------------------------------------------------------------
  // Drop-on-wire hit test — closest bezier midpoint within a fixed radius.
  // -------------------------------------------------------------------------

  /** Return the edge id that would be split if `anchor` released now, or null. */
  const pickWireForInsert = useCallback(
    (anchor: BaseNode, anchorCenter: { x: number; y: number }): string | null => {
      const g = graphRef.current;
      let best: { id: string; d2: number } | null = null;
      for (const edge of g.edges) {
        // Never target an edge that already touches this node.
        if (edge.from.nodeId === anchor.id || edge.to.nodeId === anchor.id) continue;
        const fromNode = g.nodes.find((n) => n.id === edge.from.nodeId);
        const toNode = g.nodes.find((n) => n.id === edge.to.nodeId);
        if (!fromNode || !toNode) continue;
        const a = portCanvasPos(fromNode, edge.from.portId);
        const b = portCanvasPos(toNode, edge.to.portId);
        if (!a || !b) continue;
        // Midpoint of the cubic — for the wire style we use, this is close
        // enough to the visual midpoint for hit-testing purposes.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const dxp = anchorCenter.x - mx;
        const dyp = anchorCenter.y - my;
        const d2 = dxp * dxp + dyp * dyp;
        if (d2 > DROP_ON_WIRE_RADIUS * DROP_ON_WIRE_RADIUS) continue;
        // Type-compat quick reject: does `anchor` have compatible in and out?
        const outPort = fromNode.ports.find((p) => p.id === edge.from.portId);
        const inPort = toNode.ports.find((p) => p.id === edge.to.portId);
        if (!outPort || !inPort) continue;
        const hasInCompat = anchor.ports.some(
          (p) => p.side === 'in' && (p.dataType === 'any' || outPort.dataType === 'any' || p.dataType === outPort.dataType),
        );
        const hasOutCompat = anchor.ports.some(
          (p) => p.side === 'out' && (p.dataType === 'any' || inPort.dataType === 'any' || p.dataType === inPort.dataType),
        );
        if (!hasInCompat || !hasOutCompat) continue;
        if (!best || d2 < best.d2) best = { id: edge.id, d2 };
      }
      return best?.id ?? null;
    },
    [portCanvasPos],
  );

  // -------------------------------------------------------------------------
  // Node drag / selection
  // -------------------------------------------------------------------------

  function onNodeHeaderPointerDown(e: ReactPointerEvent<HTMLDivElement>, node: BaseNode) {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Steal focus back from any textarea so keyboard shortcuts work.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      active.blur();
    }

    const additive = e.shiftKey || e.metaKey;
    const wantsDuplicate = e.altKey;

    // Option-drag duplicates the current selection (FiCal-style). We clone
    // the selected set in place (dx=dy=0), swap `node` for its new twin, and
    // let the normal drag path move the copies. Original nodes stay put.
    if (wantsDuplicate) {
      const cur = selectedIdsRef.current;
      // If the pointer-down node isn't in the current selection, dup just it.
      const sourceIds = cur.has(node.id) && cur.size > 0
        ? new Set<NodeId>(cur)
        : new Set<NodeId>([node.id]);
      const clip = copyNodesToClipboard(graphRef.current, sourceIds);
      const { graph: nextGraph, newIds } = pasteClipboard(graphRef.current, clip, 0, 0);
      // Find the paste-mapped id for the pointer-down node so we anchor drag
      // on the correct copy. `pasteClipboard` doesn't expose the id map, so
      // we recover it by matching order: `newIds` is in the same order as
      // `clip.nodes`, which is in the same order as `g.nodes.filter(sel)`.
      const orderedSourceIds = graphRef.current.nodes
        .filter((n) => sourceIds.has(n.id))
        .map((n) => n.id);
      const idxOfAnchor = orderedSourceIds.indexOf(node.id);
      const anchorNewId = idxOfAnchor >= 0 ? newIds[idxOfAnchor] : newIds[0];
      dispatch({ type: 'PASTE_GRAPH', graph: nextGraph });
      setSelection(newIds);
      // Re-target the drag onto the new anchor copy. It shares (x,y) with
      // the original, so screen coordinates line up.
      const anchorCopy = nextGraph.nodes.find((n) => n.id === anchorNewId);
      if (!anchorCopy) return;
      const startPositions = new Map<NodeId, { x: number; y: number }>();
      for (const id of newIds) {
        const n = nextGraph.nodes.find((nn) => nn.id === id);
        if (n) startPositions.set(id, { x: n.x, y: n.y });
      }
      const c = screenToCanvas(e.clientX, e.clientY);
      const nc = nodeCenter(anchorCopy);
      draggingRef.current = {
        anchorId: anchorCopy.id,
        offsetX: c.x - anchorCopy.x,
        offsetY: c.y - anchorCopy.y,
        startPositions,
        anchorCenter: { x: nc.x, y: nc.y },
        anchorSize: { w: nc.w, h: nc.h },
        started: false,
        downClient: { x: e.clientX, y: e.clientY },
        additive: false,
      };
      suppressNextClickRef.current = anchorCopy.id;
      canvasRef.current?.setPointerCapture(e.pointerId);
      setSelectedEdgeId(null);
      return;
    }

    // Selection semantics:
    //   - plain click on unselected: replace selection with [node]
    //   - plain click on already-selected: keep selection (allows group drag)
    //   - shift-click on unselected: add to selection
    //   - shift-click on already-selected: defer to click handler (may toggle off
    //     unless a drag started, in which case the toggle-off is suppressed).
    const cur = selectedIdsRef.current;
    let deferSelection = false;
    let nextSelection: Set<NodeId>;
    if (additive) {
      if (cur.has(node.id)) {
        // Toggle-off decision deferred to click handler.
        nextSelection = cur;
        deferSelection = true;
      } else {
        const merged = new Set(cur);
        merged.add(node.id);
        nextSelection = merged;
      }
    } else if (cur.has(node.id) && cur.size > 1) {
      nextSelection = new Set(cur);
    } else {
      nextSelection = new Set([node.id]);
    }
    if (!deferSelection) {
      let changed = nextSelection.size !== cur.size;
      if (!changed) {
        for (const id of nextSelection) if (!cur.has(id)) { changed = true; break; }
      }
      if (changed) setSelection(nextSelection);
      else setPrimaryId(node.id);
    }
    setSelectedEdgeId(null);

    // Prep drag with start positions for every node currently in the selection.
    const dragIds = nextSelection.has(node.id) ? nextSelection : new Set([node.id]);
    const startPositions = new Map<NodeId, { x: number; y: number }>();
    for (const id of dragIds) {
      const n = graphRef.current.nodes.find((nn) => nn.id === id);
      if (n) startPositions.set(id, { x: n.x, y: n.y });
    }
    const c = screenToCanvas(e.clientX, e.clientY);
    const nc = nodeCenter(node);
    draggingRef.current = {
      anchorId: node.id,
      offsetX: c.x - node.x,
      offsetY: c.y - node.y,
      startPositions,
      anchorCenter: { x: nc.x, y: nc.y },
      anchorSize: { w: nc.w, h: nc.h },
      started: false,
      downClient: { x: e.clientX, y: e.clientY },
      additive,
    };
    // Suppress the follow-up click's selection change UNLESS we deferred (in
    // which case we WANT the click handler to run for the shift-toggle-off).
    suppressNextClickRef.current = deferSelection ? null : node.id;
    canvasRef.current?.setPointerCapture(e.pointerId);
  }

  function onNodeClick(e: React.MouseEvent, nodeId: NodeId) {
    e.stopPropagation();
    // If we JUST completed a real drag on this node, don't treat the click as
    // a selection change — the drag was the interaction.
    // (draggingRef is nulled in pointerup so we lean on suppressNextClickRef.)
    if (suppressNextClickRef.current === nodeId) {
      suppressNextClickRef.current = null;
      return;
    }
    if (draggingRef.current) return;
    const additive = (e.shiftKey || e.metaKey);
    if (additive) {
      const merged = new Set(selectedIdsRef.current);
      if (merged.has(nodeId)) merged.delete(nodeId);
      else merged.add(nodeId);
      setSelection(merged);
    } else if (!selectedIdsRef.current.has(nodeId) || selectedIdsRef.current.size > 1) {
      setSelection([nodeId]);
    }
    setSelectedEdgeId(null);
  }

  function onNodeContextMenu(e: React.MouseEvent, nodeId: NodeId) {
    e.preventDefault();
    e.stopPropagation();
    // Right-clicking a node: ensure it's in the selection so context actions
    // operate on the expected set.
    if (!selectedIdsRef.current.has(nodeId)) setSelection([nodeId]);
    setContextMenu({ kind: 'node', nodeId, x: e.clientX, y: e.clientY });
  }

  function onCanvasContextMenu(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    const onEmpty =
      target === canvasRef.current ||
      target.classList.contains('ne-world') ||
      target.classList.contains('ne-grid') ||
      target.classList.contains('ne-edges');
    if (!onEmpty) return;
    e.preventDefault();
    const c = screenToCanvas(e.clientX, e.clientY);
    setContextMenu({ kind: 'canvas', canvasX: c.x, canvasY: c.y, x: e.clientX, y: e.clientY });
  }

  // -------------------------------------------------------------------------
  // Ports / connection + endpoint drag (rewire)
  // -------------------------------------------------------------------------

  function onPortPointerDown(e: ReactPointerEvent<HTMLDivElement>, node: BaseNode, portId: PortId) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const port = node.ports.find((p) => p.id === portId);
    if (!port) return;

    // Endpoint rewire: if this is an INPUT port with exactly one connected
    // edge, rip it and start a rubber-band drag from the OTHER end (the
    // upstream output). We don't rip from outputs, because outputs can fan
    // out to many inputs — dragging from a used output should start a NEW
    // wire, not steal the existing one. Matches FiCal/Weavy convention.
    const attached = edgesOnPort(graphRef.current, node.id, portId);
    if (attached.length === 1 && port.side === 'in') {
      const edge = attached[0];
      const thisIsFrom = edge.from.nodeId === node.id && edge.from.portId === portId;
      // Compute the OTHER endpoint (that becomes the rubber-band anchor).
      const otherEnd = thisIsFrom ? edge.to : edge.from;
      const otherNode = graphRef.current.nodes.find((n) => n.id === otherEnd.nodeId);
      if (!otherNode) return;
      const otherPort = otherNode.ports.find((p) => p.id === otherEnd.portId);
      if (!otherPort) return;
      const pos = portCanvasPos(otherNode, otherEnd.portId);
      if (!pos) return;
      const cur = screenToCanvas(e.clientX, e.clientY);
      connectRef.current = {
        from: { nodeId: otherNode.id, portId: otherEnd.portId, side: otherPort.side },
        startX: pos.x,
        startY: pos.y,
        curX: cur.x,
        curY: cur.y,
        ripEdgeId: edge.id,
      };
      canvasRef.current?.setPointerCapture(e.pointerId);
      bumpTick();
      return;
    }

    // Fresh drag: only allow initiating from OUTPUT ports (spec).
    if (port.side !== 'out') return;
    const pos = portCanvasPos(node, portId);
    if (!pos) return;
    const cur = screenToCanvas(e.clientX, e.clientY);
    connectRef.current = {
      from: { nodeId: node.id, portId, side: 'out' },
      startX: pos.x,
      startY: pos.y,
      curX: cur.x,
      curY: cur.y,
      ripEdgeId: null,
    };
    canvasRef.current?.setPointerCapture(e.pointerId);
    bumpTick();
  }

  // -------------------------------------------------------------------------
  // Edge selection
  // -------------------------------------------------------------------------

  function onEdgeClick(e: React.MouseEvent, edgeId: string) {
    e.stopPropagation();
    setSelectedEdgeId(edgeId);
    setSelection([]);
  }

  // -------------------------------------------------------------------------
  // Generate — execute the graph starting at this node via the FAL DAG executor
  // -------------------------------------------------------------------------

  const [execError, setExecError] = useState<string | null>(null);

  const onGenerate = useCallback(async (node: BaseNode) => {
    setExecError(null);
    setInFlight((prev) => {
      const next = new Set(prev);
      next.add(node.id);
      return next;
    });
    try {
      // NOTE: intentionally do NOT dispatch SET_GRAPH after executeGraph
      // finishes. executeGraph works on a snapshot of graphRef.current at the
      // start of the run; if the user adds/moves/edits nodes while the model
      // call is in flight, replacing the live graph with the snapshot clobbers
      // those edits ("my new node disappeared when the render finished").
      // The per-node SET_NODE_OUTPUT events already deliver every output back
      // into the live graph.
      await executeGraph(graphRef.current, {
        startAt: node.id,
        onEvent: (e) => {
          if (e.kind === 'started') {
            setInFlight((prev) => {
              const next = new Set(prev);
              next.add(e.nodeId);
              return next;
            });
          } else if (e.kind === 'output') {
            // If the executor also mutated node.data (multi-image extras onto
            // __history), land that in the live graph BEFORE the output
            // dispatch so useHistoryMirror's comparison sees the correct
            // updated history tail.
            if (e.dataPatch) {
              dispatch({ type: 'UPDATE_NODE_DATA', id: e.nodeId, patch: e.dataPatch });
            }
            dispatch({ type: 'SET_NODE_OUTPUT', id: e.nodeId, output: e.output });
            setInFlight((prev) => {
              const next = new Set(prev);
              next.delete(e.nodeId);
              return next;
            });
          } else if (e.kind === 'failed') {
            setInFlight((prev) => {
              const next = new Set(prev);
              next.delete(e.nodeId);
              return next;
            });
            setExecError(`${e.nodeId}: ${e.error}`);
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecError(msg);
      console.error('[NodeEditor] executeGraph failed', err);
    } finally {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  }, []);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const selectedNode = primaryId ? graph.nodes.find((n) => n.id === primaryId) ?? null : null;

  // Marquee rectangle in canvas coords (for rendering).
  const marqueeRect = (() => {
    const m = marqueeRef.current;
    if (!m) return null;
    void interactionTick;
    const x = Math.min(m.startX, m.curX);
    const y = Math.min(m.startY, m.curY);
    const w = Math.abs(m.curX - m.startX);
    const h = Math.abs(m.curY - m.startY);
    if (w < 2 && h < 2) return null;
    return { x, y, w, h };
  })();

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  return (
    <PanelRefContext.Provider value={{ panels: availablePanels ?? [] }}>
    <div
      className="ne-root"
      onClick={() => setContextMenu(null)}
      // When keep-alive-hidden, stay in the DOM tree but visually gone and
      // non-interactive. FAL results still flow through dispatch → store.
      style={hidden ? { display: 'none', pointerEvents: 'none' } : undefined}
      aria-hidden={hidden ? 'true' : undefined}
    >
      {/* Top bar */}
      <div className="ne-topbar">
        <div className="ne-topbar-title">Node Editor</div>
        <div className="ne-topbar-sub">
          {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'} · {graph.edges.length} edge{graph.edges.length === 1 ? '' : 's'}
          {selectedIds.size > 1 ? ` · ${selectedIds.size} selected` : ''}
          {state.dirty ? ' · unsaved' : ''}
          {execError && (
            <span className="ne-topbar-err" title={execError} onClick={() => setExecError(null)}>
              ⚠ execution error — click to dismiss
            </span>
          )}
        </div>
        <div className="ne-topbar-spacer" />
        <FalCreditsPill />
        {/* 2026-07-15: Per Matt, blue Save button and Export XML removed from
            the top bar. Per-node media download (⬇ icon in the media toolbar)
            and cmd-S auto-save on close cover the save-image cases. */}
        <button className="ne-topbar-btn ghost" onClick={triggerClose} title="Close (Esc)">
          Close<span className="ne-topbar-kbd">Esc</span>
        </button>
      </div>

      {/* Body */}
      <div className={`ne-body ${selectedNode ? 'has-inspector' : ''}`}>
        {/* Left palette: click a chip to drop the node at canvas center, or
            drag a chip onto the canvas to drop at the pointer. */}
        <NodePalette
          onAdd={(kind) => {
            const rect = canvasRef.current?.getBoundingClientRect();
            const zoom = state.graph.zoom;
            const pan = state.graph.panOffset;
            const cx = rect ? (rect.width / 2 - pan.x) / zoom : 400;
            const cy = rect ? (rect.height / 2 - pan.y) / zoom : 200;
            dispatch({ type: 'ADD_NODE', kind, at: { x: cx, y: cy } });
          }}
        />
        <div
          ref={canvasRef}
          className={`ne-canvas ${panningRef.current ? 'is-panning' : (spaceDown || metaDown) ? 'is-space' : ''}`}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onContextMenu={onCanvasContextMenu}
          onDragOver={(e) => {
            // Accept drops from the palette or the OS.
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const zoom = state.graph.zoom;
            const pan = state.graph.panOffset;
            const cx = (e.clientX - rect.left - pan.x) / zoom;
            const cy = (e.clientY - rect.top - pan.y) / zoom;
            // (a) Palette drop → add a node of the given kind.
            const paletteKind = e.dataTransfer.getData('application/x-boardfish-node');
            if (paletteKind) {
              dispatch({ type: 'ADD_NODE', kind: paletteKind as NodeKind, at: { x: cx, y: cy } });
              return;
            }
            // (b) OS file drop → image/video files become a null-node source
            // with the file's data URL baked into its output. Wire it into
            // an ImageGen's ref port to do image-to-image, or straight into
            // the Out node.
            const files = Array.from(e.dataTransfer.files ?? []).filter(
              (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
            );
            if (files.length === 0) return;
            let dx = 0;
            for (const file of files) {
              const reader = new FileReader();
              const at = { x: cx + dx, y: cy + dx };
              dx += 40;
              reader.onload = () => {
                const dataUrl = String(reader.result);
                const isVideo = file.type.startsWith('video/');
                dispatch({ type: 'ADD_NODE', kind: 'null-node', at });
                queueMicrotask(() => {
                  const g = graphRef.current;
                  const newest = g.nodes[g.nodes.length - 1];
                  if (!newest) return;
                  dispatch({
                    type: 'SET_NODE_OUTPUT',
                    id: newest.id,
                    output: {
                      kind: isVideo ? 'video' : 'image',
                      dataUrl,
                      mime: file.type || (isVideo ? 'video/mp4' : 'image/png'),
                      generatedAt: Date.now(),
                    },
                  });
                });
              };
              reader.readAsDataURL(file);
            }
          }}
        >
          <div
            className="ne-grid"
            style={{
              backgroundPosition: `${graph.panOffset.x}px ${graph.panOffset.y}px`,
              backgroundSize: `${20 * graph.zoom}px ${20 * graph.zoom}px`,
            }}
          />
          <div
            className="ne-world"
            style={{
              transform: `translate(${graph.panOffset.x}px, ${graph.panOffset.y}px) scale(${graph.zoom})`,
            }}
          >
            {/* Edges */}
            <svg
              className="ne-edges"
              xmlns="http://www.w3.org/2000/svg"
              onContextMenu={(e) => e.preventDefault()}
            >
              {graph.edges.map((edge) => {
                const fromNode = graph.nodes.find((n) => n.id === edge.from.nodeId);
                const toNode = graph.nodes.find((n) => n.id === edge.to.nodeId);
                if (!fromNode || !toNode) return null;
                const a = portCanvasPos(fromNode, edge.from.portId);
                const b = portCanvasPos(toNode, edge.to.portId);
                if (!a || !b) return null;
                const d = bezierPath(a.x, a.y, b.x, b.y);
                const isSelected = selectedEdgeId === edge.id;
                const isInsertCand = insertCandidateEdgeId === edge.id;
                return (
                  <path
                    key={edge.id}
                    className={`ne-edge ${isSelected ? 'is-selected' : ''} ${isInsertCand ? 'is-insert-candidate' : ''}`}
                    d={d}
                    onClick={(e) => onEdgeClick(e, edge.id)}
                  />
                );
              })}
              {/* Temp rubber-band */}
              {connectRef.current
                ? (() => {
                    const c = connectRef.current!;
                    void interactionTick;
                    return (
                      <path
                        className="ne-edge is-temp"
                        d={bezierPath(c.startX, c.startY, c.curX, c.curY)}
                      />
                    );
                  })()
                : null}
              {/* Marquee rect */}
              {marqueeRect && (
                <rect
                  className="ne-marquee"
                  x={marqueeRect.x}
                  y={marqueeRect.y}
                  width={marqueeRect.w}
                  height={marqueeRect.h}
                />
              )}
            </svg>

            {/* Nodes */}
            {graph.nodes.map((node) => (
              <NodeView
                key={node.id}
                node={node}
                selected={selectedIds.has(node.id)}
                inFlight={inFlight.has(node.id)}
                graph={graph}
                onChangeData={(patch) =>
                  dispatch({ type: 'UPDATE_NODE_DATA', id: node.id, patch })
                }
                onRun={() => onGenerate(node)}
                onPromoteFrame={(historyIndex) =>
                  dispatch({ type: 'PROMOTE_FRAME', id: node.id, historyIndex })
                }
                onHeaderPointerDown={(e) => onNodeHeaderPointerDown(e, node)}
                onClick={(e) => onNodeClick(e, node.id)}
                onContextMenu={(e) => onNodeContextMenu(e, node.id)}
                onPortPointerDown={onPortPointerDown}
              />
            ))}
          </div>

          <div className="ne-hint">
Drag empty canvas to select · Shift-click to add · ⌘X/⌘C/⌘V · Opt-drag to duplicate · Space-drag to pan · tap Space to preview · F to fit all · ⌘S to save
          </div>
        </div>

        {/* Inspector */}
        {selectedNode && (
          <InspectorPane
            node={selectedNode}
            inFlight={inFlight.has(selectedNode.id)}
            onChangeData={(patch) =>
              dispatch({ type: 'UPDATE_NODE_DATA', id: selectedNode.id, patch })
            }
            onGenerate={() => onGenerate(selectedNode)}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onAddNode={(kind, at) => {
            dispatch({ type: 'ADD_NODE', kind, at });
          }}
          onNodeAction={(action) => {
            if (contextMenu.kind !== 'node') return;
            const nid = contextMenu.nodeId;
            if (action === 'delete') {
              // If the menu-targeted node is in a multi-selection, act on the whole set.
              const ids = selectedIdsRef.current.has(nid) && selectedIdsRef.current.size > 1
                ? new Set(selectedIdsRef.current)
                : new Set([nid]);
              dispatch({ type: 'REMOVE_NODES', ids });
              setSelection([]);
            } else if (action === 'duplicate') {
              dispatch({ type: 'DUPLICATE_NODE', id: nid });
            } else if (action === 'disconnect') {
              dispatch({ type: 'DISCONNECT_NODE', id: nid });
            }
          }}
        />
      )}

      {/* Confirm close */}
      {confirmClose && (
        <div className="ne-confirm-backdrop" onClick={() => setConfirmClose(false)}>
          <div className="ne-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="ne-confirm-title">Discard unsaved changes?</div>
            <div className="ne-confirm-body">
              You have edits that haven't been saved. Close anyway?
            </div>
            <div className="ne-confirm-actions">
              <button className="ne-topbar-btn ghost" onClick={() => setConfirmClose(false)}>Keep editing</button>
              <button className="ne-topbar-btn" onClick={() => { setConfirmClose(false); finishClose(); }}>Discard</button>
              <button
                className="ne-topbar-btn primary"
                onClick={async () => {
                  setConfirmClose(false);
                  // Await save so the Out refresh finishes before we
                  // unmount — otherwise Save + close races the refresh.
                  await triggerSave();
                  finishClose();
                }}
              >Save & close</button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen preview of the selected node's output (Space toggles). */}
      {fullscreenNodeId && (() => {
        const n = graph.nodes.find((x) => x.id === fullscreenNodeId);
        if (!n) return null;
        const frames = getFullscreenFrames(n);
        const idx = frames.length > 0 ? ((fullscreenIndex % frames.length) + frames.length) % frames.length : 0;
        const frame = frames[idx];
        const url = frame?.url;
        const kind = frame?.kind;
        const nav = frames.length > 1;
        const timeStr = frame?.when
          ? new Date(frame.when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : '';
        return (
          <div
            className="ne-fullscreen-backdrop"
            onClick={() => closeFullscreen()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <FullscreenBody
              frames={frames}
              idx={idx}
              // With the in-place-swap PROMOTE_FRAME approach, the current
              // frame is always at display slot 0. The heart on slot 0 is
              // rendered filled to signal "this is what downstream sees";
              // all others are outline / clickable.
              pinnedIdx={0}
              mode={fullscreenMode}
              gridSize={fullscreenGridSize}
              picks={fullscreenPicks}
              currentFrame={frame}
              currentUrl={url}
              currentKind={kind}
              nav={nav}
              timeStr={timeStr}
              onSetIndex={setFullscreenIndex}
              onSetMode={setFullscreenMode}
              onSetGridSize={setFullscreenGridSize}
              onSetPicks={setFullscreenPicks}
              onClose={closeFullscreen}
              onFavorite={(frameIdx: number) => {
                // Heart = "make this the current output for the node".
                // Semantics match Matt's mental model (2026-07-12):
                //  - The hearted frame becomes node.output, so downstream
                //    consumers immediately see it (same as double-click on
                //    a variant with the arrow-scroll workflow).
                //  - The OLD current takes the hearted frame's slot in
                //    history (in-place swap). All other frames keep their
                //    original slots — no reorder.
                //  - Fullscreen cursor snaps to slot 0 (the new current)
                //    since that's where the hearted frame now lives.
                //
                // frames[0] = current, frames[k>=1] = history[hist.length-k].
                // No-op when hearting the already-current frame.
                if (frameIdx <= 0) return;
                const nn = graphRef.current.nodes.find((x) => x.id === fullscreenNodeId);
                if (!nn) return;
                const hist = readNodeHistory(nn);
                const historyIndex = hist.length - frameIdx;
                if (historyIndex < 0 || historyIndex >= hist.length) return;
                dispatch({ type: 'PROMOTE_FRAME', id: nn.id, historyIndex });
                setFullscreenIndex(0);
                // Kick a fresh Out execution so downstream picks up the
                // new current on the next tick (the auto-refresh signature
                // debounces 200ms; be explicit for immediacy).
                setTimeout(() => {
                  const outNodeNow = graphRef.current.nodes.find((x) => x.kind === 'out');
                  if (!outNodeNow) return;
                  const hasUpstream = graphRef.current.edges.some((e) => e.to.nodeId === outNodeNow.id);
                  if (!hasUpstream) return;
                  executeGraph(graphRef.current, {
                    startAt: outNodeNow.id,
                    onEvent: (ev) => {
                      if (ev.kind === 'output') {
                        if (ev.dataPatch) {
                          dispatch({ type: 'UPDATE_NODE_DATA', id: ev.nodeId, patch: ev.dataPatch });
                        }
                        dispatch({ type: 'SET_NODE_OUTPUT', id: ev.nodeId, output: ev.output });
                      }
                    },
                  }).catch((err) => {
                    console.warn('[NodeEditor] Out refresh after heart failed:', err);
                  });
                }, 0);
              }}
            />
          </div>
        );
      })()}

      {/* Big prompt editor — Space-tap while a Text Prompt node is selected. */}
      {promptEditorNodeId && (() => {
        const n = graph.nodes.find((x) => x.id === promptEditorNodeId);
        if (!n) return null;
        const value = String(n.data.text ?? '');
        return (
          <div
            className="ne-prompt-editor-backdrop"
            onClick={() => setPromptEditorNodeId(null)}
          >
            <div className="ne-prompt-editor" onClick={(e) => e.stopPropagation()}>
              <div className="ne-prompt-editor-head">
                <span>Text Prompt</span>
                <button
                  className="ne-prompt-editor-close"
                  onClick={() => setPromptEditorNodeId(null)}
                  title="Close (Space / Esc)"
                >
                  ✕
                </button>
              </div>
              <textarea
                className="ne-prompt-editor-textarea"
                autoFocus
                spellCheck
                value={value}
                placeholder="Describe the shot in as much detail as you want. Space or Esc to close."
                onChange={(e) =>
                  dispatch({
                    type: 'UPDATE_NODE_DATA',
                    id: n.id,
                    patch: { text: e.target.value },
                  })
                }
                onKeyDown={(e) => {
                  // Let normal typing pass through (including Space). Close on Esc.
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setPromptEditorNodeId(null);
                  }
                  // Prevent our global keydown from hijacking ⌘X/⌘C/⌘V inside
                  // the editor.
                  e.stopPropagation();
                }}
              />
              <div className="ne-prompt-editor-hint">
                {value.length.toLocaleString()} chars · Esc to close
              </div>
            </div>
          </div>
        );
      })()}
    </div>
    </PanelRefContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Extract the first frame of a video (data URL) as a JPEG data URL. Loads
 * the video off-DOM, seeks to a tiny offset (frame 0 is often black), and
 * draws it onto an offscreen canvas.
 */
async function extractVideoPoster(videoUrl: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.src = videoUrl;
    let done = false;
    const cleanup = () => {
      v.remove();
    };
    v.addEventListener('loadeddata', () => {
      // Seek slightly in so we don't grab a black pre-roll frame.
      const t = Math.min(0.05, (v.duration || 1) * 0.02);
      try { v.currentTime = t; } catch { /* seek not supported */ }
    });
    v.addEventListener('seeked', () => {
      if (done) return;
      done = true;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth || 1280;
        canvas.height = v.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', 0.92);
        cleanup();
        resolve(url);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
    v.addEventListener('error', () => { cleanup(); reject(new Error('video load failed')); });
  });
}

// Collect the frames shown in the fullscreen preview. Order: current live
// output first, then history newest→oldest. Only frames with a dataUrl and
// a kind of image/video are kept — text frames aren't renderable full-page.
function getFullscreenFrames(
  node: BaseNode,
): Array<{ url: string; kind: 'image' | 'video'; label?: string; when?: number }> {
  const frames: Array<{ url: string; kind: 'image' | 'video'; label?: string; when?: number }> = [];
  const cur = node.output;
  if (cur && (cur.kind === 'image' || cur.kind === 'video') && cur.dataUrl) {
    frames.push({ url: cur.dataUrl, kind: cur.kind, label: 'current', when: cur.generatedAt });
  }
  const hist = readNodeHistory(node).slice().reverse(); // newest first
  for (const h of hist) {
    if ((h.kind === 'image' || h.kind === 'video') && h.dataUrl) {
      frames.push({ url: h.dataUrl, kind: h.kind, when: h.generatedAt });
    }
  }
  return frames;
}

type FullscreenFrame = { url: string; kind: 'image' | 'video'; label?: string; when?: number };

/** Best-fit column count for the compare grid so cells stay large.
 *  1→1col, 2→2col, 3–4→2col, 5–6→3col, 7–9→3col, 10+→4col. */
function compareColsFor(n: number): number {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** Zoomable/pannable frame used in compare cells.
 *  Scroll-wheel = zoom to cursor. Drag = pan when zoomed. Double-click = reset. */
function ZoomableFrame({ frame }: { frame: FullscreenFrame }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  // Native wheel listener (React onWheel is passive; we need preventDefault).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setScale((s) => {
        const next = Math.min(8, Math.max(1, s * factor));
        if (next === s) return s;
        // Zoom-to-cursor: keep the point under the cursor stationary.
        const ratio = next / s;
        setTx((t) => (t + (cx - t) * (1 - ratio)));
        setTy((t) => (t + (cy - t) * (1 - ratio)));
        // When we return to 1x, snap the pan back to origin.
        if (next <= 1.0001) { setTx(0); setTy(0); }
        return next;
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (scale <= 1.0001) return; // no panning at 1x
    if (e.button !== 0) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    panStart.current = { x: e.clientX, y: e.clientY, tx, ty };
    setPanning(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!panning || !panStart.current) return;
    setTx(panStart.current.tx + (e.clientX - panStart.current.x));
    setTy(panStart.current.ty + (e.clientY - panStart.current.y));
  }
  function endPan(e: React.PointerEvent<HTMLDivElement>) {
    if (!panning) return;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setPanning(false);
    panStart.current = null;
  }
  function onDoubleClick() {
    setScale(1); setTx(0); setTy(0);
  }

  const zoomed = scale > 1.0001;
  return (
    <div
      ref={wrapRef}
      className={`ne-fs-compare-frame ${zoomed ? 'is-zoomed' : ''} ${panning ? 'is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={onDoubleClick}
    >
      {frame.kind === 'video' ? (
        <video
          src={frame.url}
          controls={!zoomed}
          loop
          playsInline
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      ) : (
        <img
          src={frame.url}
          alt=""
          draggable={false}
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      )}
      <div className="ne-fs-compare-zoom-hud">{Math.round(scale * 100)}%{zoomed ? ' · drag to pan · dbl-click to reset' : ' · scroll to zoom'}</div>
    </div>
  );
}

/** Heart icons for the "pin as selected" action. Filled = this frame is
 *  currently pinned; outline = clickable to pin. Both share size and stroke
 *  so button size is identical whether pinned or not. */
const HEART_FILLED_SVG = (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path
      d="M12 21s-7.5-4.35-9.75-9C.6 8.25 2.85 4.5 6.75 4.5c2.1 0 3.75 1.05 5.25 3 1.5-1.95 3.15-3 5.25-3 3.9 0 6.15 3.75 4.5 7.5C19.5 16.65 12 21 12 21z"
      fill="currentColor"
    />
  </svg>
);
const HEART_OUTLINE_SVG = (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path
      d="M12 21s-7.5-4.35-9.75-9C.6 8.25 2.85 4.5 6.75 4.5c2.1 0 3.75 1.05 5.25 3 1.5-1.95 3.15-3 5.25-3 3.9 0 6.15 3.75 4.5 7.5C19.5 16.65 12 21 12 21z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  </svg>
);

/** Fullscreen preview UI: single-view, grid, and side-by-side compare. */
function FullscreenBody(props: {
  frames: FullscreenFrame[];
  idx: number;
  pinnedIdx: number;
  mode: 'single' | 'grid' | 'compare';
  gridSize: number;
  picks: Set<number>;
  currentFrame: FullscreenFrame | undefined;
  currentUrl: string | undefined;
  currentKind: 'image' | 'video' | undefined;
  nav: boolean;
  timeStr: string;
  onSetIndex: (fn: (i: number) => number) => void;
  onSetMode: (m: 'single' | 'grid' | 'compare') => void;
  onSetGridSize: (n: number) => void;
  onSetPicks: (s: Set<number>) => void;
  onClose: () => void;
  onFavorite: (frameIdx: number) => void;
}) {
  const {
    frames, idx, pinnedIdx, mode, gridSize, picks,
    currentFrame: frame, currentUrl: url, currentKind: kind,
    nav, timeStr,
    onSetIndex, onSetMode, onSetGridSize, onSetPicks, onClose,
    onFavorite,
  } = props;

  function togglePick(i: number) {
    const next = new Set(picks);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onSetPicks(next);
  }

  const canCompare = frames.length >= 2;
  const compareList = mode === 'compare'
    ? Array.from(picks).sort((a, b) => a - b).map((i) => ({ i, f: frames[i] })).filter((x) => x.f)
    : [];

  return (
    <div
      className={`ne-fullscreen-inner ne-fullscreen-inner--${mode}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toolbar */}
      <div className="ne-fs-toolbar">
        <div className="ne-fs-toolbar-group">
          <button
            className={`ne-fs-tab ${mode === 'single' ? 'is-active' : ''}`}
            onClick={() => onSetMode('single')}
            title="Single view"
          >
            View
          </button>
          <button
            className={`ne-fs-tab ${mode === 'grid' ? 'is-active' : ''}`}
            onClick={() => onSetMode('grid')}
            title="Grid of all versions"
            disabled={!nav}
          >
            ▦ Grid
          </button>
          <button
            className={`ne-fs-tab ${mode === 'compare' ? 'is-active' : ''}`}
            onClick={() => {
              if (!canCompare) return;
              // If no picks yet, seed with the current viewed index + the first
              // history frame so compare has something to show immediately.
              if (picks.size === 0) {
                const seed = new Set<number>([idx, idx === 0 ? 1 : 0]);
                onSetPicks(seed);
              }
              onSetMode('compare');
            }}
            title="Compare selected side-by-side"
            disabled={!canCompare}
          >
            ⇔ Compare
            {picks.size > 0 ? <span className="ne-fs-tab-badge">{picks.size}</span> : null}
          </button>
        </div>

        {mode === 'grid' && (
          <div className="ne-fs-toolbar-group">
            <span className="ne-fs-tool-label">Tile size</span>
            <input
              className="ne-fs-slider"
              type="range"
              min={100}
              max={480}
              step={10}
              value={gridSize}
              onChange={(e) => onSetGridSize(Number(e.target.value))}
            />
            <span className="ne-fs-tool-value">{gridSize}px</span>
            {picks.size > 0 && (
              <button
                className="ne-fs-tab"
                onClick={() => onSetMode('compare')}
                title="Compare picked frames"
              >
                Compare {picks.size}
              </button>
            )}
          </div>
        )}

        {mode === 'compare' && (
          <div className="ne-fs-toolbar-group">
            <span className="ne-fs-tool-label">{compareList.length} selected</span>
            <button
              className="ne-fs-tab"
              onClick={() => { onSetPicks(new Set()); onSetMode('grid'); }}
              title="Back to grid to change selection"
            >
              Change picks
            </button>
          </div>
        )}

        {/* Heart: mark the currently-viewed frame as the node's pinned
            selection (what downstream nodes read). Does NOT reorder history
            — the frame stays at its position, the counter stays where it is.
            Filled when this frame is the pinned one, outline otherwise. */}
        {mode === 'single' && frames.length > 0 && (
          <button
            className={`ne-fs-favorite ne-fs-toolbar-heart ${idx === pinnedIdx ? 'is-pinned' : ''}`}
            onClick={() => onFavorite(idx)}
            title={idx === pinnedIdx
              ? 'This is the currently pinned selection'
              : 'Pin this version as the node\'s selection'}
            aria-label="Pin as selection"
          >
            {idx === pinnedIdx ? HEART_FILLED_SVG : HEART_OUTLINE_SVG}
          </button>
        )}
        <button
          className="ne-fullscreen-close"
          onClick={onClose}
          title="Close (Space / Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      {mode === 'single' && (
        <div className="ne-fs-single">
          <div className="ne-fs-single-frame">
            {url ? (
              kind === 'video' ? (
                <video src={url} controls autoPlay loop playsInline />
              ) : (
                <img src={url} alt="" draggable={false} />
              )
            ) : (
              <div className="ne-fullscreen-empty">
                This node has no output yet. Run the graph, then press Space again.
              </div>
            )}
            {nav && (
              <>
                <button
                  className="ne-fullscreen-nav ne-fullscreen-nav--prev"
                  onClick={() =>
                    onSetIndex((i) => (i - 1 + frames.length) % frames.length)
                  }
                  title="Previous version (←)"
                  aria-label="Previous frame"
                >
                  ‹
                </button>
                <button
                  className="ne-fullscreen-nav ne-fullscreen-nav--next"
                  onClick={() =>
                    onSetIndex((i) => (i + 1) % frames.length)
                  }
                  title="Next version (→)"
                  aria-label="Next frame"
                >
                  ›
                </button>
                <div className="ne-fullscreen-counter">
                  {idx + 1} / {frames.length}
                  {frame?.label ? ` · ${frame.label}` : ''}
                  {timeStr ? ` · ${timeStr}` : ''}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {mode === 'grid' && (
        <div className="ne-fs-grid-scroll">
          <div
            className="ne-fs-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}
          >
            {frames.map((f, i) => {
              const picked = picks.has(i);
              const isCurrent = i === 0;
              return (
                <div
                  key={i}
                  className={`ne-fs-grid-tile ${picked ? 'is-picked' : ''} ${i === idx ? 'is-current' : ''}`}
                  onClick={() => togglePick(i)}
                  onDoubleClick={() => { onSetIndex(() => i); onSetMode('single'); }}
                  title={`${f.label ?? `v${frames.length - i}`}${f.when ? ' · ' + new Date(f.when).toLocaleTimeString() : ''} — click to pick, double-click to view`}
                >
                  {f.kind === 'video'
                    ? <video src={f.url} muted playsInline preload="metadata" />
                    : <img src={f.url} alt="" draggable={false} />}
                  <div className="ne-fs-grid-tile-badges">
                    <span className="ne-fs-grid-tile-num">{isCurrent ? '● current' : `v${frames.length - i}`}</span>
                  </div>
                  {/* Heart: pin this version as the node's selection. Filled
                      when it's the pinned one; outline otherwise. Always
                      visible on the pinned tile so users know which is
                      selected. */}
                  <button
                    className={`ne-fs-favorite ne-fs-grid-tile-fav ${i === pinnedIdx ? 'is-pinned always-visible' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onFavorite(i); }}
                    title={i === pinnedIdx
                      ? 'This is the currently pinned selection'
                      : 'Pin this version as the node\'s selection'}
                    aria-label="Pin as selection"
                  >
                    {i === pinnedIdx ? HEART_FILLED_SVG : HEART_OUTLINE_SVG}
                  </button>
                  <div className="ne-fs-grid-tile-check">{picked ? '✓' : ''}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {mode === 'compare' && (
        <div className="ne-fs-compare-scroll">
          <div
            className="ne-fs-compare"
            style={{
              gridTemplateColumns: `repeat(${compareColsFor(compareList.length)}, minmax(0, 1fr))`,
              gridAutoRows: '1fr',
            }}
          >
            {compareList.map(({ i, f }) => {
              const isCurrent = i === 0;
              return (
                <div key={i} className="ne-fs-compare-cell">
                  <ZoomableFrame frame={f} />
                  <div className="ne-fs-compare-caption">
                    <span>{isCurrent ? '● current' : `v${frames.length - i}`}</span>
                    {f.when ? <span className="ne-fs-compare-time">{new Date(f.when).toLocaleTimeString()}</span> : null}
                    <button
                      className={`ne-fs-favorite ne-fs-compare-fav ${i === pinnedIdx ? 'is-pinned' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onFavorite(i); }}
                      title={i === pinnedIdx
                        ? 'This is the currently pinned selection'
                        : 'Pin this version as the node\'s selection'}
                      aria-label="Pin as selection"
                    >
                      {i === pinnedIdx ? HEART_FILLED_SVG : HEART_OUTLINE_SVG}
                    </button>
                    <button
                      className="ne-fs-compare-remove"
                      title="Remove from compare"
                      onClick={(e) => { e.stopPropagation(); const nx = new Set(picks); nx.delete(i); onSetPicks(nx); }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
            {compareList.length === 0 && (
              <div className="ne-fullscreen-empty">
                Pick frames in Grid, then come back here to compare.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Horizontal cubic bezier connecting two points. FiCal-style tangents. */
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1);
  const cp = Math.min(Math.max(dx * 0.5, 50), 200);
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
}

// Export helpers so external code can seed a graph without importing types.ts.
export { emptyGraph, seedDefaultGraph };

// ---------------------------------------------------------------------------
// Node palette — sidebar of draggable node chips grouped by category
// ---------------------------------------------------------------------------

function NodePalette({ onAdd }: { onAdd: (kind: NodeKind) => void }) {
  const groups: { category: string; label: string }[] = [
    { category: 'input', label: 'Input' },
    { category: 'gen', label: 'Generate' },
    { category: 'utility', label: 'Utility' },
    { category: 'output', label: 'Output' },
  ];
  return (
    <div className="ne-palette">
      <div className="ne-palette-head">Nodes</div>
      {groups.map((g) => {
        const kinds = Object.values(NODE_KINDS)
          .filter((k) => k.category === g.category)
          .filter((k) => !k.hiddenFromPalette);
        if (kinds.length === 0) return null;
        return (
          <div key={g.category} className="ne-palette-group">
            <div className="ne-palette-group-label">{g.label}</div>
            {kinds.map((k) => (
              <div
                key={k.kind}
                className="ne-palette-chip"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('application/x-boardfish-node', k.kind);
                }}
                onClick={() => onAdd(k.kind)}
                title={`Drag onto canvas, or click to add ${k.label} at center`}
              >
                {k.label}
              </div>
            ))}
          </div>
        );
      })}
      <div className="ne-palette-foot">Drag onto canvas, or drop image / video files anywhere.</div>
    </div>
  );
}
