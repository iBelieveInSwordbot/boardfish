// Boardfish 5 — Node Editor overlay
//
// Weavy.ai-style graph editor built as a self-contained React overlay. Modeled
// on the FiCal retirement-calculator canvas (raw-DOM, single-file) but
// react-ified and split into a reducer + one component. Kept intentionally
// under ~700 lines — if it needs to grow, split into NodeCanvas/NodeInspector.
//
// Coord model (matches FiCal):
//   screen -> canvas: (clientX - rect.left - panOffset.x) / zoom
//   canvas -> screen: canvasX * zoom + panOffset.x + rect.left
//
// The world layer is transformed as one big `translate + scale` container; all
// nodes are positioned in canvas coords inside it. Edges are drawn as a single
// SVG that sits inside the world layer, so they auto-transform with everything
// else.

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
  disconnectNode,
  duplicateNode,
  findOutNode,
  moveNode,
  removeEdge,
  removeNode,
  setNodeOutput,
  updateNodeData,
} from '../nodes/graph-utils';
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
  | { type: 'ADD_NODE'; kind: NodeKind; at: { x: number; y: number } }
  | { type: 'REMOVE_NODE'; id: NodeId }
  | { type: 'DUPLICATE_NODE'; id: NodeId }
  | { type: 'DISCONNECT_NODE'; id: NodeId }
  | { type: 'UPDATE_NODE_DATA'; id: NodeId; patch: Record<string, unknown> }
  | { type: 'ADD_EDGE'; from: Edge['from']; to: Edge['to'] }
  | { type: 'REMOVE_EDGE'; edgeId: string }
  | { type: 'SET_VIEWPORT'; panOffset: { x: number; y: number }; zoom: number }
  | { type: 'SET_NODE_OUTPUT'; id: NodeId; output: BaseNode['output'] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'MOVE_NODE':
      return { graph: moveNode(state.graph, action.id, action.x, action.y), dirty: true };
    case 'ADD_NODE':
      return { graph: addNode(state.graph, action.kind, action.at), dirty: true };
    case 'REMOVE_NODE':
      return { graph: removeNode(state.graph, action.id), dirty: true };
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
    case 'SET_VIEWPORT':
      // Viewport is not "user work"; don't flip dirty for pan/zoom.
      return {
        ...state,
        graph: { ...state.graph, panOffset: action.panOffset, zoom: action.zoom },
      };
    case 'SET_NODE_OUTPUT':
      return { graph: setNodeOutput(state.graph, action.id, action.output), dirty: true };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3.0;
const NODE_HEADER_H = 32;
const PORT_ROW_H = 18;

// Simulated in-flight duration for the stub Generate action.
const SIM_GENERATE_MS = 2000;

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
      if (imgGen) imgGen.data = { ...imgGen.data, aspect: panelAspect };
    }
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [state, dispatch] = useReducer(reducer, { graph: seeded, dirty: false });
  const graph = state.graph;

  // Selection + inspector state.
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // In-flight simulation set — nodes currently "executing" (spinner overlay).
  const [inFlight, setInFlight] = useState<Set<NodeId>>(new Set());

  // Context menu state.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Space-key pan mode.
  const [spaceDown, setSpaceDown] = useState(false);

  // Refs for DOM / interaction state that shouldn't cause re-renders.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panningRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const draggingRef = useRef<{ nodeId: NodeId; offsetX: number; offsetY: number } | null>(null);
  const connectRef = useRef<{
    from: { nodeId: NodeId; portId: PortId };
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);
  // Force a re-render during rubber-band drag without spamming reducer state.
  const [connectTick, setConnectTick] = useState(0);

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
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // Global (fire even in fields):
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        triggerSave();
        return;
      }

      if (e.key === 'Escape') {
        // Prefer dismissing overlays first.
        if (contextMenu) { setContextMenu(null); return; }
        if (!inField) {
          e.preventDefault();
          triggerClose();
        }
        return;
      }

      if (inField) return; // don't hijack typing

      if (e.key === ' ') {
        setSpaceDown(true);
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        if (selectedNodeId) {
          e.preventDefault();
          dispatch({ type: 'REMOVE_NODE', id: selectedNodeId });
          setSelectedNodeId(null);
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
      if (e.key === ' ') setSpaceDown(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [triggerSave, triggerClose, selectedNodeId, selectedEdgeId, contextMenu]);

  // -------------------------------------------------------------------------
  // Pan / zoom
  // -------------------------------------------------------------------------

  function onCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Only start pan when clicking on empty canvas (not on a node/port/edge).
    const target = e.target as HTMLElement;
    const onEmpty =
      target === canvasRef.current ||
      target.classList.contains('ne-world') ||
      target.classList.contains('ne-grid') ||
      target.classList.contains('ne-edges');
    if (!onEmpty) return;

    // Middle-button or space+drag or right-button starts pan. Left-click on
    // empty canvas deselects.
    const wantsPan = e.button === 1 || (e.button === 0 && spaceDown);
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
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setContextMenu(null);
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
    // Node drag.
    if (draggingRef.current) {
      const cur = screenToCanvas(e.clientX, e.clientY);
      const nx = cur.x - draggingRef.current.offsetX;
      const ny = cur.y - draggingRef.current.offsetY;
      dispatch({ type: 'MOVE_NODE', id: draggingRef.current.nodeId, x: nx, y: ny });
      return;
    }
    // Rubber-band connection drag.
    if (connectRef.current) {
      const cur = screenToCanvas(e.clientX, e.clientY);
      connectRef.current.curX = cur.x;
      connectRef.current.curY = cur.y;
      setConnectTick((t) => t + 1);
    }
  }

  function onCanvasPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panningRef.current) {
      panningRef.current = null;
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    if (draggingRef.current) {
      draggingRef.current = null;
    }
    if (connectRef.current) {
      // Hit-test whatever's under the cursor: is it a port dot?
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const portEl = el && (el as HTMLElement).closest('[data-port-node][data-port-id]');
      if (portEl) {
        const targetNodeId = (portEl as HTMLElement).dataset.portNode!;
        const targetPortId = (portEl as HTMLElement).dataset.portId!;
        const targetSide = (portEl as HTMLElement).dataset.portSide as 'in' | 'out';
        if (targetSide === 'in') {
          dispatch({
            type: 'ADD_EDGE',
            from: connectRef.current.from,
            to: { nodeId: targetNodeId, portId: targetPortId },
          });
        }
      }
      connectRef.current = null;
      setConnectTick((t) => t + 1);
    }
  }

  function onCanvasWheel(e: ReactWheelEvent<HTMLDivElement>) {
    // Zoom centered on the cursor.
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = 1 + (-e.deltaY / 500);
    const nextZoom = clamp(graph.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Anchor so the canvas point under the cursor stays put.
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const worldX = (cx - graph.panOffset.x) / graph.zoom;
    const worldY = (cy - graph.panOffset.y) / graph.zoom;
    const nextPan = {
      x: cx - worldX * nextZoom,
      y: cy - worldY * nextZoom,
    };
    dispatch({ type: 'SET_VIEWPORT', panOffset: nextPan, zoom: nextZoom });
  }

  // -------------------------------------------------------------------------
  // Node drag / selection
  // -------------------------------------------------------------------------

  function onNodeHeaderPointerDown(e: ReactPointerEvent<HTMLDivElement>, node: BaseNode) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    const cur = screenToCanvas(e.clientX, e.clientY);
    draggingRef.current = {
      nodeId: node.id,
      offsetX: cur.x - node.x,
      offsetY: cur.y - node.y,
    };
    // Capture pointer on the canvas so move/up keep flowing there.
    canvasRef.current?.setPointerCapture(e.pointerId);
  }

  function onNodeClick(e: React.MouseEvent, nodeId: NodeId) {
    e.stopPropagation();
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
  }

  function onNodeContextMenu(e: React.MouseEvent, nodeId: NodeId) {
    e.preventDefault();
    e.stopPropagation();
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
  // Ports / connection drag
  // -------------------------------------------------------------------------

  function onPortPointerDown(e: ReactPointerEvent<HTMLDivElement>, node: BaseNode, portId: PortId) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const port = node.ports.find((p) => p.id === portId);
    if (!port) return;
    // Only allow initiating a drag from OUTPUT ports (spec: click-drag from
    // output → drop on input). Input ports still get connected via drop.
    if (port.side !== 'out') return;
    const pos = portCanvasPos(node, portId);
    if (!pos) return;
    connectRef.current = {
      from: { nodeId: node.id, portId },
      startX: pos.x,
      startY: pos.y,
      curX: pos.x,
      curY: pos.y,
    };
    canvasRef.current?.setPointerCapture(e.pointerId);
    setConnectTick((t) => t + 1);
  }

  // -------------------------------------------------------------------------
  // Edge selection
  // -------------------------------------------------------------------------

  function onEdgeClick(e: React.MouseEvent, edgeId: string) {
    e.stopPropagation();
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
  }

  // -------------------------------------------------------------------------
  // Generate (stub — sets inFlight for 2s, no actual FAL call)
  // -------------------------------------------------------------------------

  const onGenerate = useCallback((node: BaseNode) => {
    console.log('[NodeEditor] would execute node', node.id, node.kind);
    setInFlight((prev) => {
      const next = new Set(prev);
      next.add(node.id);
      return next;
    });
    window.setTimeout(() => {
      setInFlight((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }, SIM_GENERATE_MS);
  }, []);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const selectedNode = selectedNodeId
    ? graph.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

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
          {state.dirty ? ' · unsaved' : ''}
        </div>
        <div className="ne-topbar-spacer" />
        <button className="ne-topbar-btn ghost" onClick={triggerClose} title="Close (Esc)">
          Close<span className="ne-topbar-kbd">Esc</span>
        </button>
        <button className="ne-topbar-btn primary" onClick={triggerSave} title="Save (⌘S)">
          Save<span className="ne-topbar-kbd">⌘S</span>
        </button>
      </div>

      {/* Body */}
      <div className={`ne-body ${selectedNode ? 'has-inspector' : ''}`}>
        <div
          ref={canvasRef}
          className={`ne-canvas ${panningRef.current ? 'is-panning' : spaceDown ? 'is-space' : ''}`}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onWheel={onCanvasWheel}
          onContextMenu={onCanvasContextMenu}
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
                return (
                  <path
                    key={edge.id}
                    className={`ne-edge ${selectedEdgeId === edge.id ? 'is-selected' : ''}`}
                    d={d}
                    onClick={(e) => onEdgeClick(e, edge.id)}
                  />
                );
              })}
              {/* Temp rubber-band */}
              {connectRef.current
                ? (() => {
                    const c = connectRef.current!;
                    void connectTick; // ensure re-render dependency
                    return (
                      <path
                        className="ne-edge is-temp"
                        d={bezierPath(c.startX, c.startY, c.curX, c.curY)}
                      />
                    );
                  })()
                : null}
            </svg>

            {/* Nodes */}
            {graph.nodes.map((node) => (
              <NodeView
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                inFlight={inFlight.has(node.id)}
                graph={graph}
                onHeaderPointerDown={(e) => onNodeHeaderPointerDown(e, node)}
                onClick={(e) => onNodeClick(e, node.id)}
                onContextMenu={(e) => onNodeContextMenu(e, node.id)}
                onPortPointerDown={onPortPointerDown}
              />
            ))}
          </div>

          <div className="ne-hint">
            Space+drag or middle-drag to pan · Scroll to zoom · Right-click canvas to add nodes · ⌘S to save
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
              dispatch({ type: 'REMOVE_NODE', id: nid });
              if (selectedNodeId === nid) setSelectedNodeId(null);
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Horizontal cubic bezier connecting two points. FiCal-style tangents. */
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1);
  const cp = Math.min(Math.max(dx * 0.5, 50), 200);
  return `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
}

// Export helpers so external code can seed a graph without importing types.ts.
export { emptyGraph, seedDefaultGraph };
