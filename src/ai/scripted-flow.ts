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
import type { PromptField } from '../nodes/text-prompt-fields';
import { makeFieldId } from '../nodes/text-prompt-fields';

// Small helper — build a `text` PromptField with a fresh id.
function textField(label: string, value: string, join: 'inline' | 'block' = 'block'): PromptField {
  return { id: makeFieldId(), kind: 'text', label, value, join };
}

/**
 * Strip a known style-tag suffix from a description so the DESCRIPTION
 * field only carries the visually-concrete content. When Ronan is told
 * "append the style directive verbatim," descriptions end with the tag
 * text; we want that tag to live in its own STYLE field.
 *
 * Returns { description, style } — style empty if the tag isn't present.
 */
export function splitDescriptionAndStyle(
  raw: string,
  styleTag: string | null | undefined,
): { description: string; style: string } {
  const tag = (styleTag || '').trim();
  const text = (raw || '').trim();
  if (!tag) return { description: text, style: '' };
  const tagIdx = text.lastIndexOf(tag);
  if (tagIdx === -1) return { description: text, style: '' };
  const before = text.slice(0, tagIdx).replace(/[,\s]+$/g, '').trim();
  return { description: before, style: tag };
}

/**
 * Build MultiPrompt fields for a SHOT (final-storyboard panel).
 * Fields, in order:
 *   • Description — the visually-concrete part of imagePrompt (style stripped)
 *   • Camera — shot type / camera move / angle joined into one line
 *   • Style — the style tag as its own editable field
 * The camera line is inline-joined; description + style are block-joined.
 */
export function buildShotPromptFields(opts: {
  imagePrompt: string;
  shotType?: string;
  cameraMove?: string;
  angle?: string;
  styleTag?: string | null;
}): PromptField[] {
  const { description, style } = splitDescriptionAndStyle(opts.imagePrompt, opts.styleTag);
  const cameraParts = [opts.shotType, opts.cameraMove, opts.angle]
    .map((x) => (x || '').trim())
    .filter(Boolean);
  const camera = cameraParts.join(' · ');
  return [
    textField('Description', description, 'block'),
    textField('Camera', camera, 'block'),
    textField('Style', style, 'block'),
  ];
}

/**
 * Build MultiPrompt fields for an ASSET panel (actor / location / prop).
 *   • Description — the visually-concrete part of asset.description
 *   • Framing    — the section-specific framing suffix (light-grey full-body,
 *                  establishing shot, product-style close-up, etc.)
 *   • Style      — the style tag
 */
export function buildAssetPromptFields(opts: {
  description: string;
  framingSuffix: string;
  styleTag?: string | null;
}): PromptField[] {
  const { description, style } = splitDescriptionAndStyle(opts.description, opts.styleTag);
  // Strip any leading comma from framingSuffix so it reads cleanly as a
  // standalone field value (Matt's config uses ", ..." for inline glue).
  const framing = (opts.framingSuffix || '').replace(/^,\s*/, '').trim();
  return [
    textField('Description', description, 'block'),
    textField('Framing', framing, 'block'),
    textField('Style', style, 'block'),
  ];
}

/**
 * Build a fresh text-prompt node with MultiPrompt fields baked in.
 * Used for asset panels (actors/locations/props) that also want the
 * MultiPrompt structure in their node view but don't have PanelRef inputs.
 */
export function seedAssetPanelGraph(opts: {
  legacyPrompt: string;
  fields: PromptField[];
  aspectRatio: string;
  generatedImageDataUrl?: string;
  generatedMime?: string;
  presetName?: string;
}): NodeGraph {
  return seedFinalStoryboardGraph({
    prompt: opts.legacyPrompt,
    aspectRatio: opts.aspectRatio,
    refs: [],
    generatedImageDataUrl: opts.generatedImageDataUrl,
    generatedMime: opts.generatedMime,
    promptFields: opts.fields,
    promptPresetName: opts.presetName || 'Multi Prompt',
  });
}

export type SeededRef = {
  panelId: string;
  imageDataUrl: string;
  label?: string; // human label — used as the PanelRef node's cornerNote-ish tag
};

/**
 * Build the seeded graph. `refs` may be empty, in which case we produce the
 * plain 3-node chain (TextPrompt → ImageGen → Out).
 *
 * When `generatedImageDataUrl` is provided, we also attach it as the
 * `output` snapshot on both the ImageGen and Out nodes so double-clicking
 * into the node editor immediately shows the generated result in the
 * ImageGen preview — not just the wiring. Without this the ImageGen node
 * looks empty even after the storyboard panel has an image.
 */
export function seedFinalStoryboardGraph(opts: {
  prompt: string;
  aspectRatio: string;
  refs: SeededRef[];
  generatedImageDataUrl?: string;
  generatedMime?: string;
  /** Structured MultiPrompt fields. When provided, the seeded text-prompt
   *  node opens in Multi Prompt mode with these fields pre-populated. The
   *  `prompt` string is still passed as the legacy fallback so the executor
   *  emits the same concatenated text either way. */
  promptFields?: PromptField[];
  /** Display label for the Multi Prompt preset badge on the node. */
  promptPresetName?: string;
}): NodeGraph {
  const { prompt, aspectRatio, refs, generatedImageDataUrl, generatedMime, promptFields, promptPresetName } = opts;
  const cappedRefs = refs.slice(0, 6);

  const nodes: BaseNode[] = [];
  const edges: Edge[] = [];

  // Layout: text prompt top-left, panel refs down the left column, image gen
  // in the middle, out on the right. Y positions stagger so the wires read
  // cleanly.
  // Prompt node data: always include the legacy `text` blob as a fallback
  // so any consumer that ignores `fields` still gets the same output. When
  // `promptFields` is provided we ALSO set `fields` + `presetName` so the
  // text-prompt node renders in Multi Prompt mode and lets the user edit
  // individual sections (Description / Style / Framing / etc.).
  const promptData: Record<string, unknown> = {
    ...defaultDataFor('text-prompt'),
    text: prompt,
  };
  if (promptFields && promptFields.length > 0) {
    promptData.fields = promptFields;
    promptData.presetName = promptPresetName || 'Multi Prompt';
  }
  const promptNode: BaseNode = {
    id: newId('n'),
    kind: 'text-prompt',
    x: 80,
    y: 80,
    ports: defaultPortsFor('text-prompt'),
    data: promptData,
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
  // If we already generated the panel's image via the scripted flow, stash
  // the dataUrl on the ImageGen node's __history and output snapshots so it
  // renders in-preview the moment the node editor opens.
  const genOutput = generatedImageDataUrl
    ? {
        kind: 'image' as const,
        dataUrl: generatedImageDataUrl,
        mime: generatedMime || 'image/png',
        generatedAt: Date.now(),
      }
    : undefined;
  if (genOutput) {
    // Also seed __history so the node's version stepper starts at 1/1 for
    // the scripted gen. Empty otherwise — first user re-gen will append.
    (genData as Record<string, unknown>).__history = [genOutput];
  }
  const genNode: BaseNode = {
    id: newId('n'),
    kind: 'image-gen',
    x: 480,
    y: 200,
    ports: defaultPortsFor('image-gen', genData),
    data: genData,
    output: genOutput,
  };
  nodes.push(genNode);

  const outNode: BaseNode = {
    id: newId('n'),
    kind: 'out',
    x: 820,
    y: 200,
    ports: defaultPortsFor('out'),
    data: defaultDataFor('out'),
    // Mirror the ImageGen output onto Out so the Out node preview also
    // shows the panel image (matches how the seedDefaultGraph flow works
    // when a panel already had an imageDataUrl).
    output: genOutput,
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
