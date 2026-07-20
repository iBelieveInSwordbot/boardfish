// Boardfish 5 — Inspector drawer.
//
// Renders the right-side drawer for the currently selected node. Delegates
// the form itself to the per-kind Inspector component in NODE_KINDS.

import type { BaseNode } from '../nodes/types';
import { NODE_KINDS } from '../nodes/registry';

export type InspectorPaneProps = {
  node: BaseNode;
  inFlight: boolean;
  /** When true, multiple gen-capable nodes are selected; the Inspector's
   *  per-node Generate button is a no-op (use top-bar "Generate all"). */
  multiGenSelected?: boolean;
  onChangeData: (patch: Record<string, unknown>) => void;
  onGenerate: () => void;
};

export function InspectorPane({ node, inFlight, multiGenSelected, onChangeData, onGenerate }: InspectorPaneProps) {
  const def = NODE_KINDS[node.kind];
  const Inspector = def.Inspector;
  return (
    <div className="ne-inspector" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ne-inspector-head">
        <div>
          <div className="ne-inspector-head-title">{def.label}</div>
          <div className="ne-inspector-head-sub">{def.category} · id {node.id.slice(0, 10)}</div>
        </div>
      </div>
      {multiGenSelected && (
        <div
          className="ne-inspector-multi-note"
          style={{
            padding: '8px 12px',
            background: '#33272e',
            color: '#ffb4c8',
            fontSize: '11px',
            borderBottom: '1px solid #402a35',
          }}
        >
          Multiple gen nodes selected — use “Generate all” in the top bar.
        </div>
      )}
      <div className="ne-inspector-scroll">
        <Inspector
          node={node}
          onChangeData={onChangeData}
          onGenerate={onGenerate}
          inFlight={inFlight}
          multiGenSelected={multiGenSelected}
        />
      </div>
    </div>
  );
}
