// Boardfish 6 — helper that seeds a NodeGraph for a final storyboard panel.
//
// Each final storyboard panel gets a saved nodeGraph containing:
//   [TextPrompt]     ┐
//   [PanelRef A]     ├─→ [ImageGen: Nano Banana Pro] → [Out]
//   [PanelRef B]     │
//   …up to 6 refs…   ┘
//
// Opening the panel in the node editor shows the wiring already in place, so
// the user can swap prompts, edit refs, or rewire without starting from a
// blank canvas. The ImageGen node's ref ports auto-scale via `refCount`.

import type { BaseNode, Edge, NodeGraph } from '../nodes/types';
import { defaultDataFor, defaultPortsFor, newId } from '../nodes/types';

export type SeededRef = {
  panelId: string;
  imageDataUrl: string;
  label?: string; // human label — used as the PanelRef node's cornerNote-ish tag
};

/**
 * Build the seeded graph. `refs` may be empty, in which case we produce the
 * plain 3-node chain (TextPrompt → ImageGen → Out).
 */
export function seedFinalStoryboardGraph(opts: {
  prompt: string;
  aspectRatio: string;
  refs: SeededRef[];
}): NodeGraph {
  const { prompt, aspectRatio, refs } = opts;
  const cappedRefs = refs.slice(0, 6);

  const nodes: BaseNode[] = [];
  const edges: Edge[] = [];

  // Layout: text prompt top-left, panel refs down the left column, image gen
  // in the middle, out on the right. Y positions stagger so the wires read
  // cleanly.
  const promptNode: BaseNode = {
    id: newId('n'),
    kind: 'text-prompt',
    x: 80,
    y: 80,
    ports: defaultPortsFor('text-prompt'),
    data: { ...defaultDataFor('text-prompt'), text: prompt },
  };
  nodes.push(promptNode);

  // Panel-ref nodes down the left column, one per referenced asset.
  const refNodes: BaseNode[] = cappedRefs.map((r, i) => {
    const rn: BaseNode = {
      id: newId('n'),
      kind: 'panel-ref',
      x: 80,
      y: 260 + i * 200,
      ports: defaultPortsFor('panel-ref'),
      data: {
        ...defaultDataFor('panel-ref'),
        panelId: r.panelId,
        panelLabel: r.label || '',
        imageDataUrl: r.imageDataUrl,
      },
      // Cache the ref image on the node's output so it renders in-preview
      // even before the graph is run.
      output: {
        kind: 'image',
        dataUrl: r.imageDataUrl,
        mime: 'image/png',
        generatedAt: Date.now(),
      },
    };
    return rn;
  });
  nodes.push(...refNodes);

  // Image-gen node. refCount controls how many ref ports render.
  const genData: Record<string, unknown> = {
    ...defaultDataFor('image-gen'),
    aspect_ratio: aspectRatio,
  };
  if (cappedRefs.length > 0) {
    genData.refCount = cappedRefs.length;
  }
  const genNode: BaseNode = {
    id: newId('n'),
    kind: 'image-gen',
    x: 480,
    y: 200,
    ports: defaultPortsFor('image-gen', genData),
    data: genData,
  };
  nodes.push(genNode);

  const outNode: BaseNode = {
    id: newId('n'),
    kind: 'out',
    x: 820,
    y: 200,
    ports: defaultPortsFor('out'),
    data: defaultDataFor('out'),
  };
  nodes.push(outNode);

  // Wire prompt → gen.prompt
  edges.push({
    id: newId('e'),
    from: { nodeId: promptNode.id, portId: 'out' },
    to: { nodeId: genNode.id, portId: 'prompt' },
  });
  // Wire each panel-ref → gen.ref / ref1 / ref2 …
  refNodes.forEach((rn, i) => {
    const portId = i === 0 ? 'ref' : `ref${i}`;
    edges.push({
      id: newId('e'),
      from: { nodeId: rn.id, portId: 'out' },
      to: { nodeId: genNode.id, portId },
    });
  });
  // Wire gen.out → out.in
  edges.push({
    id: newId('e'),
    from: { nodeId: genNode.id, portId: 'out' },
    to: { nodeId: outNode.id, portId: 'in' },
  });

  return {
    nodes,
    edges,
    panOffset: { x: 0, y: 0 },
    zoom: 1,
  };
}
