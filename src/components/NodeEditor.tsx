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
  graphToXml,
  insertNodeOnEdge,
  moveNode,
  moveNodesTo,
  pasteClipboard,
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
import { NodeView, ContextMenu, type ContextMenuState } from './NodeCanvas';
import { InspectorPane } from './NodeInspector';
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
  onSave: (graph: NodeGraph, outImage: { dataUrl: string; mime: string } | null) => void;
  onClose: () => void;
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
  | { type: 'SET_GRAPH'; graph: NodeGraph; dirty?: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'MOVE_NODE':
      return { graph: moveNode(state.graph, action.id, action.x, action.y), dirty: true };
    case 'MOVE_NODES':
      return { graph: moveNodesTo(state.graph, action.positions), dirty: true };
    case 'ADD_NODE':
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
const PORT_ROW_H = 18;
/** Max distance (canvas px) from a node center to an edge midpoint to trigger the drop-on-wire highlight. */
const DROP_ON_WIRE_RADIUS = 40;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NodeEditor(props: NodeEditorProps) {
  const { initialGraph, panelPrompt, panelAspect, onSave, onClose } = props;

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
  //  - metaDown: ⌘ (mac) / Ctrl (win/linux) — hold to pan the canvas by dragging.
  //  - Option/Alt-drag on a node duplicates it (FiCal-style) — checked at
  //    pointer time via e.altKey, no persistent state needed.
  //  - Spacebar opens fullscreen preview of the selected node (see below).
  const [metaDown, setMetaDown] = useState(false);

  // Fullscreen preview of the currently-selected node's output.
  const [fullscreenNodeId, setFullscreenNodeId] = useState<NodeId | null>(null);
  // Index within the [current, ...history] frames array shown in fullscreen.
  // 0 = current live output, 1+ = older frames (most recent first).
  const [fullscreenIndex, setFullscreenIndex] = useState(0);

  // Refs for DOM / interaction state that shouldn't cause re-renders.
  const canvasRef = useRef<HTMLDivElement | null>(null);
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

  /** Port center in CANVAS coords (matches the SVG world). */
  const portCanvasPos = useCallback(
    (node: BaseNode, portId: PortId): { x: number; y: number } | null => {
      const port = node.ports.find((p) => p.id === portId);
      if (!port) return null;
      const def = NODE_KINDS[node.kind];
      const w = node.width ?? def.defaultWidth;
      // Distribute ports along the vertical center of the node body, starting
      // below the header. This matches the CSS layout in the header/body pair.
      const sideList = node.ports.filter((p) => p.side === port.side);
      const idx = sideList.findIndex((p) => p.id === portId);
      const y = node.y + NODE_HEADER_H + PORT_ROW_H * (idx + 1) - 6;
      const x = port.side === 'in' ? node.x : node.x + w;
      return { x, y };
    },
    [],
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
  // Save / close
  // -------------------------------------------------------------------------

  const triggerSave = useCallback(() => {
    const out = findOutNode(graph);
    const outImage =
      out && out.output && out.output.kind === 'image' && out.output.dataUrl
        ? { dataUrl: out.output.dataUrl, mime: out.output.mime ?? 'image/png' }
        : null;
    onSave(graph, outImage);
  }, [graph, onSave]);

  const triggerClose = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  }, [onClose]);

  // -------------------------------------------------------------------------
  // Export helpers (Save Image / XML)
  // -------------------------------------------------------------------------

  /** Trigger a browser download for a data URL. */
  function downloadDataUrl(dataUrl: string, filename: string) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Trigger a browser download for text content. */
  function downloadText(text: string, filename: string, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    downloadDataUrl(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Find every image-bearing node output. Prefers the OutNode, then any other image outputs. */
  const savableImages = useMemo(() => {
    const results: { nodeId: string; label: string; dataUrl: string; mime: string }[] = [];
    const outNode = graph.nodes.find((n) => n.kind === 'out');
    if (outNode && outNode.output && outNode.output.kind === 'image' && outNode.output.dataUrl) {
      results.push({
        nodeId: outNode.id,
        label: 'storyboard-out',
        dataUrl: outNode.output.dataUrl,
        mime: outNode.output.mime ?? 'image/png',
      });
    }
    for (const n of graph.nodes) {
      if (n === outNode) continue;
      if (n.output && n.output.kind === 'image' && n.output.dataUrl) {
        results.push({
          nodeId: n.id,
          label: n.kind,
          dataUrl: n.output.dataUrl,
          mime: n.output.mime ?? 'image/png',
        });
      }
    }
    return results;
  }, [graph.nodes]);

  const triggerSaveImage = useCallback(() => {
    if (savableImages.length === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    for (const [i, img] of savableImages.entries()) {
      const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/webp' ? 'webp' : 'png';
      const safe = img.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'node';
      const filename = `boardfish-${ts}-${i + 1}-${safe}.${ext}`;
      downloadDataUrl(img.dataUrl, filename);
    }
  }, [savableImages]);

  const triggerExportXml = useCallback(() => {
    const xml = graphToXml(graphRef.current);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadText(xml, `boardfish-graph-${ts}.xml`, 'application/xml');
  }, []);

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
        if (fullscreenNodeId) { e.preventDefault(); setFullscreenNodeId(null); return; }
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
        // Spacebar toggles fullscreen preview of the primary selected node.
        // If nothing is selected, do nothing.
        e.preventDefault();
        const pid = primaryIdRef.current;
        if (fullscreenNodeId) {
          setFullscreenNodeId(null);
        } else if (pid) {
          setFullscreenIndex(0);
          setFullscreenNodeId(pid);
        }
        return;
      }

      // Arrow keys in fullscreen: navigate through this node's frames
      // (current output + history, newest first).
      if (fullscreenNodeId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
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
    }
    function onKeyUp(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) setMetaDown(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [
    triggerSave, triggerClose, selectedEdgeId, contextMenu, doCopy, doCut,
    doPaste, doSelectAll, setSelection, fullscreenNodeId,
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

    // Middle-button or ⌘/Ctrl-drag on empty canvas starts pan.
    // (Switched from Space-drag to ⌘-drag so Space is free for fullscreen preview.)
    const wantsPan = e.button === 1 || (e.button === 0 && metaDown);
    if (wantsPan) {
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
      const nextGraph = await executeGraph(graphRef.current, {
        startAt: node.id,
        onEvent: (e) => {
          if (e.kind === 'started') {
            setInFlight((prev) => {
              const next = new Set(prev);
              next.add(e.nodeId);
              return next;
            });
          } else if (e.kind === 'output') {
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
      dispatch({ type: 'SET_GRAPH', graph: nextGraph, dirty: true });
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
    <div className="ne-root" onClick={() => setContextMenu(null)}>
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
        <button
          className="ne-topbar-btn ghost"
          onClick={triggerSaveImage}
          disabled={savableImages.length === 0}
          title={
            savableImages.length === 0
              ? 'No generated images to save yet'
              : `Download ${savableImages.length} image${savableImages.length === 1 ? '' : 's'} (PNG)`
          }
        >
          Save Image{savableImages.length > 1 ? `s (${savableImages.length})` : ''}
        </button>
        <button
          className="ne-topbar-btn ghost"
          onClick={triggerExportXml}
          title="Export node graph as XML"
        >
          Export XML
        </button>
        <button className="ne-topbar-btn ghost" onClick={triggerClose} title="Close (Esc)">
          Close<span className="ne-topbar-kbd">Esc</span>
        </button>
        <button className="ne-topbar-btn primary" onClick={triggerSave} title="Save (⌘S)">
          Save<span className="ne-topbar-kbd">⌘S</span>
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
          className={`ne-canvas ${panningRef.current ? 'is-panning' : metaDown ? 'is-space' : ''}`}
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
                onHeaderPointerDown={(e) => onNodeHeaderPointerDown(e, node)}
                onClick={(e) => onNodeClick(e, node.id)}
                onContextMenu={(e) => onNodeContextMenu(e, node.id)}
                onPortPointerDown={onPortPointerDown}
              />
            ))}
          </div>

          <div className="ne-hint">
            Drag empty canvas to select · Shift-click to add · ⌘X/⌘C/⌘V · Opt-drag to duplicate · Space to preview selected · ⌘-drag to pan · ⌘S to save
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
              <button className="ne-topbar-btn" onClick={() => { setConfirmClose(false); onClose(); }}>Discard</button>
              <button className="ne-topbar-btn primary" onClick={() => { setConfirmClose(false); triggerSave(); onClose(); }}>Save & close</button>
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
            onClick={() => setFullscreenNodeId(null)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="ne-fullscreen-inner" onClick={(e) => e.stopPropagation()}>
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
                      setFullscreenIndex((i) => (i - 1 + frames.length) % frames.length)
                    }
                    title="Previous frame (←)"
                    aria-label="Previous frame"
                  >
                    ‹
                  </button>
                  <button
                    className="ne-fullscreen-nav ne-fullscreen-nav--next"
                    onClick={() =>
                      setFullscreenIndex((i) => (i + 1) % frames.length)
                    }
                    title="Next frame (→)"
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
              <button
                className="ne-fullscreen-close"
                onClick={() => setFullscreenNodeId(null)}
                title="Close (Space / Esc)"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
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
        const kinds = Object.values(NODE_KINDS).filter((k) => k.category === g.category);
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
