// Boardfish 5 — NodeView + ContextMenu.
//
// Extracted from NodeEditor.tsx to keep the main file under the size budget.
// Nothing here owns state; the parent NodeEditor drives everything via props.

import { useMemo, useRef, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
};

export function NodeView(p: NodeViewProps) {
  const {
    node, selected, inFlight, graph, onChangeData, onRun, onPromoteFrame,
    onHeaderPointerDown, onClick, onContextMenu, onPortPointerDown,
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
      const nextW = Math.max(
        NODE_MIN_WIDTH,
        Math.min(NODE_MAX_WIDTH, Math.round(state.startW + dx)),
      );
      const nextH = Math.max(
        NODE_MIN_HEIGHT,
        Math.min(NODE_MAX_HEIGHT, Math.round(state.startH + dy)),
      );
      onChangeData({ __size: { width: nextW, height: nextH } });
    },
    [graph.zoom, onChangeData],
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

  return (
    <div
      className={`ne-node ${selected ? 'is-selected' : ''}`}
      style={{ left: node.x, top: node.y, width: w, height: h }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="ne-node-header" onPointerDown={onHeaderPointerDown}>
        <span>{def.label}</span>
        <span className="ne-node-header-cat">{def.category}</span>
      </div>
      <div className="ne-node-body">
        <Preview
          node={node}
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
              title={`${port.label} (${port.dataType})`}
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
              title={`${port.label} (${port.dataType})`}
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
  | { kind: 'canvas'; canvasX: number; canvasY: number; x: number; y: number };

export type ContextMenuProps = {
  menu: ContextMenuState;
  onClose: () => void;
  onAddNode: (kind: NodeKind, at: { x: number; y: number }) => void;
  onNodeAction: (action: 'delete' | 'duplicate' | 'disconnect') => void;
};

export function ContextMenu({ menu, onClose, onAddNode, onNodeAction }: ContextMenuProps) {
  const grouped = useMemo(() => {
    const g: Record<string, { kind: NodeKind; label: string }[]> = {
      input: [], gen: [], utility: [], output: [],
    };
    for (const def of Object.values(NODE_KINDS)) {
      if (def.hiddenFromPalette) continue;
      g[def.category].push({ kind: def.kind, label: def.label });
    }
    return g;
  }, []);

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
          {(['input', 'gen', 'utility', 'output'] as const).map((cat) => (
            <div key={cat}>
              <div className="ne-context-sub-label">Add {cat}</div>
              {grouped[cat].map((item) => (
                <div
                  key={item.kind}
                  className="ne-context-item"
                  onClick={() => {
                    onAddNode(item.kind, { x: menu.canvasX, y: menu.canvasY });
                    onClose();
                  }}
                >
                  {item.label}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
