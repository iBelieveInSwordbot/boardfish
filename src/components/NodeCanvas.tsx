// Boardfish 5 — NodeView + ContextMenu.
//
// Extracted from NodeEditor.tsx to keep the main file under the size budget.
// Nothing here owns state; the parent NodeEditor drives everything via props.

import { useMemo, useRef, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, ReactElement } from 'react';
import type { BaseNode, NodeGraph, NodeId, NodeKind, PortId } from '../nodes/types';
import {
  isPortConnected,
  readNodeSize,
  NODE_MIN_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MAX_HEIGHT,
} from '../nodes/graph-utils';
import { NODE_KINDS } from '../nodes/registry';
import { NODE_KINDS_META } from '../nodes/registry-meta';

// ---------------------------------------------------------------------------
// NodeView — one node in the world layer
// ---------------------------------------------------------------------------

export type NodeViewProps = {
  node: BaseNode;
  selected: boolean;
  inFlight: boolean;
  graph: NodeGraph;
  /**
   * Reciprocal callback that lets the Preview mutate the node's `data`.
   * Wire this to the same UPDATE_NODE_DATA dispatch the Inspector uses \u2014
   * NodeView will hand it to the kind's Preview component so kinds like
   * text-prompt can offer inline editing.
   *
   * Also used by the resize handle to persist the new size via
   * `data.__size`.
   */
  onChangeData?: (patch: Record<string, unknown>) => void;
  /** See PreviewProps.onRun — forwarded to the kind's Preview so nodes like
   *  Out can offer an inline "Refresh from upstream" button. */
  onRun?: () => void;
  /** See PreviewProps.onPromoteFrame — forwarded so previews can wire the
   *  ‹/› history arrows on the thumbnail. */
  onPromoteFrame?: (historyIndex: number) => void;
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPortPointerDown: (e: ReactPointerEvent<HTMLDivElement>, node: BaseNode, portId: PortId) => void;
  /** Ctrl-click / right-click on a port dot — open the "add + wire" menu. */
  onPortContextMenu?: (e: React.MouseEvent, node: BaseNode, portId: PortId) => void;
};

export function NodeView(p: NodeViewProps) {
  const {
    node, selected, inFlight, graph, onChangeData, onRun, onPromoteFrame,
    onHeaderPointerDown, onClick, onContextMenu, onPortPointerDown, onPortContextMenu,
  } = p;
  const def = NODE_KINDS[node.kind];
  const { width: w, height: h } = readNodeSize(node);
  const Preview = def.Preview;

  const inputs = node.ports.filter((port) => port.side === 'in');
  const outputs = node.ports.filter((port) => port.side === 'out');

  // --- Resize handle drag ---------------------------------------------------
  // Tracks a live resize gesture. We update `data.__size` on pointermove so
  // the node re-renders at the new dims immediately; on pointerup we simply
  // release the pointer capture (the last __size patch is already persisted).
  const resizeStartRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (!onChangeData) return;
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      resizeStartRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startW: w,
        startH: h,
      };
    },
    [onChangeData, w, h],
  );

  // Vertical chrome inside a media node: header + footer + typical caption
  // strip + preview padding. Used to convert a media aspect ratio into a node
  // aspect ratio when a media node is resized.
  const NODE_CHROME_V = 32 /* header */ + 26 /* footer */ + 32 /* caption + padding */;

  /**
   * If this node hosts a fixed-aspect media (image-gen, movie-gen, out, or
   * panel-ref), return the media's aspect ratio (w / h). Prefers the node's
   * declared `aspect_ratio` field (e.g. "16:9") because it's exact; falls back
   * to the naturally-loaded media element dimensions if we can find one.
   */
  const mediaAspect: number | null = (() => {
    if (!['image-gen', 'movie-gen', 'out', 'panel-ref'].includes(node.kind)) return null;
    const raw = (node.data as Record<string, unknown>).aspect_ratio;
    if (typeof raw === 'string' && raw.includes(':')) {
      const [a, b] = raw.split(':').map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return a / b;
    }
    // Fallback: try to measure the currently rendered media element inside
    // this node's DOM. Safe to read imperatively — we only need it during a
    // resize gesture where a fresh render already happened.
    const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
    if (nodeEl) {
      const img = nodeEl.querySelector<HTMLImageElement>('img.ne-node-preview-thumb');
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        return img.naturalWidth / img.naturalHeight;
      }
      const vid = nodeEl.querySelector<HTMLVideoElement>('video.ne-node-preview-thumb');
      if (vid && vid.videoWidth > 0 && vid.videoHeight > 0) {
        return vid.videoWidth / vid.videoHeight;
      }
    }
    return null;
  })();

  const onResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeStartRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      if (!onChangeData) return;
      // Note: pointer deltas are in SCREEN pixels but our world is scaled by
      // `zoom`. Reading zoom from the graph object keeps the resize gesture
      // 1:1 with what the user sees.
      const zoom = graph.zoom || 1;
      const dx = (e.clientX - state.startClientX) / zoom;
      const dy = (e.clientY - state.startClientY) / zoom;
      // Per-kind minimums win over the global floor (e.g. null-node = 40x40).
      const kindMeta = NODE_KINDS_META[node.kind];
      const minW = kindMeta?.minWidth ?? NODE_MIN_WIDTH;
      const minH = kindMeta?.minHeight ?? NODE_MIN_HEIGHT;
      let nextW = Math.max(
        minW,
        Math.min(NODE_MAX_WIDTH, Math.round(state.startW + dx)),
      );
      let nextH = Math.max(
        minH,
        Math.min(NODE_MAX_HEIGHT, Math.round(state.startH + dy)),
      );
      // Media nodes (image-gen / movie-gen / out / panel-ref) lock the media
      // rectangle's aspect ratio while resizing. We drive off whichever axis
      // moved most (in absolute pixels) so the user can widen OR heighten the
      // node and the other axis snaps to preserve the aspect.
      if (mediaAspect && mediaAspect > 0) {
        const wideDrive = Math.abs(dx) >= Math.abs(dy);
        if (wideDrive) {
          // Width is authoritative; height follows.
          nextH = Math.max(
            minH,
            Math.min(NODE_MAX_HEIGHT, Math.round(nextW / mediaAspect) + NODE_CHROME_V),
          );
        } else {
          // Height is authoritative; width follows.
          const mediaH = Math.max(1, nextH - NODE_CHROME_V);
          nextW = Math.max(
            minW,
            Math.min(NODE_MAX_WIDTH, Math.round(mediaH * mediaAspect)),
          );
        }
      }
      onChangeData({ __size: { width: nextW, height: nextH } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.zoom, onChangeData, mediaAspect, node.kind],
  );

  const onResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeStartRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch { /* pointer already released */ }
      resizeStartRef.current = null;
    },
    [],
  );

  // For nodes with no visible header (e.g. null-node), the whole body
  // acts as the drag handle. Ports still stop propagation so port drags
  // aren't hijacked into a node move.
  const isHeaderless = node.kind === 'null-node';
  return (
    <div
      className={`ne-node ne-node--${node.kind} ${selected ? 'is-selected' : ''}`}
      style={{ left: node.x, top: node.y, width: w, height: h }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={isHeaderless ? onHeaderPointerDown : undefined}
      data-node-id={node.id}
    >
      <div className="ne-node-header" onPointerDown={onHeaderPointerDown}>
        <span>{
          // Once a gen node has produced output, its Preview stamps
          // `data.__headerLabel` with the model's friendly name (e.g.
          // "Nano Banana Pro"). Prefer that so the canvas header shows
          // which model each node is locked to.
          String(
            (node.data as Record<string, unknown>).__headerLabel ?? def.label,
          )
        }</span>
        <span className="ne-node-header-cat">{def.category}</span>
      </div>
      <div className="ne-node-body">
        <Preview
          node={node}
          graph={graph}
          onChangeData={onChangeData}
          onRun={onRun}
          onPromoteFrame={onPromoteFrame}
        />
        {inFlight && <div className="ne-node-spinner" />}
      </div>
      {/* Input ports */}
      <div className="ne-ports-in">
        {inputs.map((port) => (
          <div key={port.id} className="ne-port">
            <div
              className={`ne-port-dot dt-${port.dataType} ${
                isPortConnected(graph, node.id, port.id) ? 'is-connected' : ''
              }`}
              data-port-node={node.id}
              data-port-id={port.id}
              data-port-side={port.side}
              onPointerDown={(e) => onPortPointerDown(e, node, port.id)}
              onContextMenu={(e) => {
                if (onPortContextMenu) {
                  e.preventDefault();
                  e.stopPropagation();
                  onPortContextMenu(e, node, port.id);
                }
              }}
              title={`${port.label} (${port.dataType}) — ctrl-click / right-click for menu`}
            />
            <span className="ne-port-label">{port.label}</span>
          </div>
        ))}
      </div>
      {/* Output ports */}
      <div className="ne-ports-out">
        {outputs.map((port) => (
          <div key={port.id} className="ne-port">
            <div
              className={`ne-port-dot dt-${port.dataType} ${
                isPortConnected(graph, node.id, port.id) ? 'is-connected' : ''
              }`}
              data-port-node={node.id}
              data-port-id={port.id}
              data-port-side={port.side}
              onPointerDown={(e) => onPortPointerDown(e, node, port.id)}
              onContextMenu={(e) => {
                if (onPortContextMenu) {
                  e.preventDefault();
                  e.stopPropagation();
                  onPortContextMenu(e, node, port.id);
                }
              }}
              title={`${port.label} (${port.dataType}) — ctrl-click / right-click for menu`}
            />
            <span className="ne-port-label">{port.label}</span>
          </div>
        ))}
      </div>
      {/* Resize handle (bottom-right corner). Only rendered if we have an
          onChangeData callback \u2014 without it we can't persist the resize. */}
      {onChangeData && (
        <div
          className="ne-node-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          title="Drag to resize"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContextMenu — floating menu for canvas right-click / node right-click
// ---------------------------------------------------------------------------

export type ContextMenuState =
  | { kind: 'node'; nodeId: NodeId; x: number; y: number }
  | { kind: 'canvas'; canvasX: number; canvasY: number; x: number; y: number }
  // Alt-drag from a port: dropped on empty canvas. Menu shows all
  // kinds and (when the user picks one) the new node is auto-wired
  // from the dragged port to a compatible port on the new node.
  | {
      kind: 'wire-from-port';
      canvasX: number;
      canvasY: number;
      x: number;
      y: number;
      sourceNodeId: NodeId;
      sourcePortId: string;
      sourceSide: 'in' | 'out';
    };

export type ContextMenuProps = {
  menu: ContextMenuState;
  onClose: () => void;
  onAddNode: (kind: NodeKind, at: { x: number; y: number }) => void;
  onNodeAction: (action: 'delete' | 'duplicate' | 'disconnect') => void;
  /** Called by wire-from-port variant when the user picks a kind.
   *  Parent creates the node AND wires the source port to the new node. */
  onAddWiredNode?: (
    kind: NodeKind,
    at: { x: number; y: number },
    source: { nodeId: NodeId; portId: string; side: 'in' | 'out' },
  ) => void;
};

export function ContextMenu({ menu, onClose, onAddNode, onNodeAction, onAddWiredNode }: ContextMenuProps) {
  // Explicit menu order per Matt's 2026-07-20 spec. Sections separated by
  // null (renders as a gap between items). Any kind not listed here won't
  // appear in the menu — update this list when adding a new node kind.
  const MENU_LAYOUT: (NodeKind | null)[] = [
    'text-prompt',
    'image-gen',
    'movie-gen',
    'null-node',
    null, // ────────────────────────
    'panel-ref',
    'extract-frame',
    'import',
    'export',
    null, // ────────────────────────
    'crop',
    'resize',
    'blur',
    'invert',
    null, // ────────────────────────
    'prompt-enhancer',
    'prompt-concat',
    'llm-run',
    'image-describer',
    'video-describer',
    'switch',
    'custom-fal',
    'frame-fix',
  ];

  // Resolve labels for the listed kinds against the live NODE_KINDS table.
  // Skip any that don't exist or are hidden from the palette.
  const layoutItems = useMemo(() => {
    return MENU_LAYOUT.map((k) => {
      if (k === null) return null;
      const def = NODE_KINDS[k];
      if (!def || def.hiddenFromPalette) return undefined;
      return { kind: def.kind, label: def.label };
    }).filter((x) => x !== undefined) as (null | { kind: NodeKind; label: string })[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render helper for a single item click — shared by both menu kinds.
  const renderItem = (
    item: { kind: NodeKind; label: string },
    onPick: (kind: NodeKind) => void,
  ) => (
    <div
      key={item.kind}
      className="ne-context-item"
      onClick={() => { onPick(item.kind); onClose(); }}
    >
      {item.label}
    </div>
  );

  const renderLayout = (onPick: (kind: NodeKind) => void) => {
    // Collapse consecutive/leading/trailing nulls so we don't render
    // double or leading gaps when a section is empty.
    const out: ReactNode[] = [];
    let lastWasGap = true; // suppress a leading gap
    layoutItems.forEach((it, i) => {
      if (it === null) {
        if (!lastWasGap) {
          out.push(<div key={`gap-${i}`} className="ne-context-gap" />);
          lastWasGap = true;
        }
      } else {
        out.push(renderItem(it, onPick));
        lastWasGap = false;
      }
    });
    // Trim trailing gap if any (rare — MENU_LAYOUT ends on an item today).
    if (out.length && (out[out.length - 1] as ReactElement<{ className?: string }>).props?.className === 'ne-context-gap') {
      out.pop();
    }
    return out;
  };

  return (
    <div
      className="ne-context"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === 'node' && (
        <>
          <div className="ne-context-item" onClick={() => { onNodeAction('duplicate'); onClose(); }}>Duplicate</div>
          <div className="ne-context-item" onClick={() => { onNodeAction('disconnect'); onClose(); }}>Disconnect all</div>
          <div className="ne-context-sep" />
          <div className="ne-context-item is-danger" onClick={() => { onNodeAction('delete'); onClose(); }}>Delete</div>
        </>
      )}
      {menu.kind === 'canvas' && (
        <>
          {renderLayout((kind) => {
            onAddNode(kind, { x: menu.canvasX, y: menu.canvasY });
          })}
        </>
      )}
      {menu.kind === 'wire-from-port' && (
        <>
          {renderLayout((kind) => {
            if (onAddWiredNode) {
              onAddWiredNode(
                kind,
                { x: menu.canvasX, y: menu.canvasY },
                { nodeId: menu.sourceNodeId, portId: menu.sourcePortId, side: menu.sourceSide },
              );
            } else {
              onAddNode(kind, { x: menu.canvasX, y: menu.canvasY });
            }
          })}
        </>
      )}
    </div>
  );
}
