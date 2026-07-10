// Boardfish 5 — NodeView + ContextMenu.
//
// Extracted from NodeEditor.tsx to keep the main file under the size budget.
// Nothing here owns state; the parent NodeEditor drives everything via props.

import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BaseNode, NodeGraph, NodeId, NodeKind, PortId } from '../nodes/types';
import { isPortConnected } from '../nodes/graph-utils';
import { NODE_KINDS } from '../nodes/registry';

// ---------------------------------------------------------------------------
// NodeView — one node in the world layer
// ---------------------------------------------------------------------------

export type NodeViewProps = {
  node: BaseNode;
  selected: boolean;
  inFlight: boolean;
  graph: NodeGraph;
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPortPointerDown: (e: ReactPointerEvent<HTMLDivElement>, node: BaseNode, portId: PortId) => void;
};

export function NodeView(p: NodeViewProps) {
  const {
    node, selected, inFlight, graph,
    onHeaderPointerDown, onClick, onContextMenu, onPortPointerDown,
  } = p;
  const def = NODE_KINDS[node.kind];
  const w = node.width ?? def.defaultWidth;
  const h = node.height ?? def.defaultHeight;
  const Preview = def.Preview;

  const inputs = node.ports.filter((port) => port.side === 'in');
  const outputs = node.ports.filter((port) => port.side === 'out');

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
        <Preview node={node} />
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
