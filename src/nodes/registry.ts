// Boardfish 5 — per-kind node registry.
//
// Each entry defines:
//   - metadata (label, category, defaultWidth/Height)
//   - default data blob + ports (delegated to types.ts helpers)
//   - a compact `Preview` React component rendered inside the node body
//   - an `Inspector` React component rendered in the right-side drawer when
//     the node is selected
//
// The registry is deliberately a plain object (no JSX at module scope). Each
// component is defined via React.createElement so this file stays a .ts (no
// .tsx) — the NodeEditor.tsx and .css files handle all the visual polish.
//
// Rendering rules:
//   - Preview: no editing UI, just visual state (thumbnail, text preview,
//     "coming soon" placeholder). Kept small.
//   - Inspector: full form; calls `onChangeData` with a shallow patch. Calls
//     `onGenerate` when the user wants to execute starting at this node.

import { createElement, type FC } from 'react';
import type { BaseNode, NodeKind, NodePort } from './types';
import { defaultDataFor, defaultPortsFor } from './types';

// Placeholder type: the parallel subagent will produce the real FAL model
// list in src/ai/fal-models.ts. Kept intentionally minimal so this file
// stays self-contained until wiring day.
export type FalImageModel = {
  id: string;
  label: string;
  comingSoon?: boolean;
};

const HARD_CODED_IMAGE_MODELS: FalImageModel[] = [
  { id: 'nano-banana-pro', label: 'Nano Banana Pro' },
  { id: 'nano-banana-1', label: 'Nano Banana 1', comingSoon: true },
  { id: 'nano-banana-2', label: 'Nano Banana 2', comingSoon: true },
  { id: 'gpt-image-2', label: 'GPT-image 2', comingSoon: true },
];

const ASPECT_RATIOS: string[] = [
  '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9',
];

export type NodeKindDef = {
  kind: NodeKind;
  label: string;
  category: 'input' | 'gen' | 'utility' | 'output';
  defaultWidth: number;
  defaultHeight: number;
  defaultData: () => Record<string, unknown>;
  ports: (data: Record<string, unknown>) => NodePort[];
  Preview: FC<{ node: BaseNode }>;
  Inspector: FC<{
    node: BaseNode;
    onChangeData: (patch: Record<string, unknown>) => void;
    onGenerate: () => void;
    inFlight: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Preview components
// ---------------------------------------------------------------------------

const TextPromptPreview: FC<{ node: BaseNode }> = ({ node }) => {
  const text = String(node.data.text ?? '').trim();
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--text' },
    text
      ? createElement('div', { className: 'ne-node-preview-text' }, truncate(text, 120))
      : createElement('div', { className: 'ne-node-preview-empty' }, '(empty prompt)'),
  );
};

const ImageGenPreview: FC<{ node: BaseNode }> = ({ node }) => {
  const url = node.output?.dataUrl;
  const model = String(node.data.model ?? 'nano-banana-pro');
  const aspect = String(node.data.aspect ?? '16:9');
  if (url) {
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--image' },
      createElement('img', {
        src: url,
        alt: '',
        draggable: false,
        className: 'ne-node-preview-thumb',
      }),
      createElement(
        'div',
        { className: 'ne-node-preview-caption' },
        `${modelLabel(model)} · ${aspect}`,
      ),
    );
  }
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--image is-empty' },
    createElement('div', { className: 'ne-node-preview-empty' }, 'no image yet'),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `${modelLabel(model)} · ${aspect}`,
    ),
  );
};

const MovieGenPreview: FC<{ node: BaseNode }> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--stub' },
    createElement('div', { className: 'ne-node-preview-empty' }, '🎬 video — coming soon'),
  );

const OutPreview: FC<{ node: BaseNode }> = ({ node }) => {
  const url = node.output?.dataUrl;
  if (url) {
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--out' },
      createElement('img', {
        src: url,
        alt: '',
        draggable: false,
        className: 'ne-node-preview-thumb',
      }),
      createElement('div', { className: 'ne-node-preview-caption' }, 'panel image'),
    );
  }
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--out is-empty' },
    createElement('div', { className: 'ne-node-preview-empty' }, '→ panel image'),
  );
};

const SwitchPreview: FC<{ node: BaseNode }> = ({ node }) => {
  const count = Number(node.data.count ?? 2);
  const selected = Number(node.data.selected ?? 0);
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--switch' },
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `Switch: pick #${selected + 1} of ${count}`,
    ),
  );
};

const NullNodePreview: FC<{ node: BaseNode }> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--null' },
    createElement('div', { className: 'ne-node-preview-caption' }, 'passthrough'),
  );

const PromptConcatPreview: FC<{ node: BaseNode }> = ({ node }) => {
  const count = Number(node.data.count ?? 2);
  const sep = JSON.stringify(String(node.data.separator ?? ' '));
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--concat' },
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `Join ${count} texts with ${sep}`,
    ),
  );
};

const CustomFalPreview: FC<{ node: BaseNode }> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--stub' },
    createElement('div', { className: 'ne-node-preview-empty' }, '🧪 custom FAL — coming soon'),
  );

// ---------------------------------------------------------------------------
// Inspector components
// ---------------------------------------------------------------------------

const TextPromptInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const value = String(node.data.text ?? '');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Prompt'),
    createElement('textarea', {
      className: 'ne-inspect-textarea',
      rows: 8,
      value,
      placeholder: 'Describe the shot…',
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChangeData({ text: e.target.value }),
    }),
  );
};

const ImageGenInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const model = String(node.data.model ?? 'nano-banana-pro');
  const aspect = String(node.data.aspect ?? '16:9');
  const variants = Number(node.data.variants ?? 1);
  const url = node.output?.dataUrl;

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    // Model
    createElement('label', { className: 'ne-inspect-label' }, 'Model'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: model,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onChangeData({ model: e.target.value }),
      },
      ...HARD_CODED_IMAGE_MODELS.map((m) =>
        createElement(
          'option',
          {
            key: m.id,
            value: m.id,
            disabled: m.comingSoon,
          },
          m.comingSoon ? `${m.label} (coming soon)` : m.label,
        ),
      ),
    ),
    // Aspect
    createElement('label', { className: 'ne-inspect-label' }, 'Aspect Ratio'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: aspect,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onChangeData({ aspect: e.target.value }),
      },
      ...ASPECT_RATIOS.map((a) =>
        createElement('option', { key: a, value: a }, a),
      ),
    ),
    // Variants
    createElement('label', { className: 'ne-inspect-label' }, 'Variants'),
    createElement(
      'div',
      { className: 'ne-inspect-chip-row' },
      ...[1, 2, 3, 4].map((n) =>
        createElement(
          'button',
          {
            key: n,
            type: 'button',
            className: 'ne-inspect-chip' + (variants === n ? ' is-active' : ''),
            onClick: () => onChangeData({ variants: n }),
          },
          String(n),
        ),
      ),
    ),
    // Generate
    createElement(
      'button',
      {
        type: 'button',
        className: 'ne-inspect-generate',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Generating…' : 'Generate',
    ),
    // Thumbnail
    url
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('img', { src: url, alt: '', draggable: false }),
        )
      : null,
  );
};

const MovieGenInspector: NodeKindDef['Inspector'] = () =>
  createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Video generation is coming next. The node exists so graphs can round-trip today; wiring lands in Phase B/2.',
    ),
  );

const OutInspector: NodeKindDef['Inspector'] = ({ node }) => {
  const url = node.output?.dataUrl;
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'The Out node writes back to the Panel when you press ⌘S. Whatever image reaches this node becomes the panel image.',
    ),
    url
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('img', { src: url, alt: '', draggable: false }),
        )
      : null,
  );
};

const SwitchInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const count = Number(node.data.count ?? 2);
  const selected = Number(node.data.selected ?? 0);
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Inputs'),
    createElement('input', {
      type: 'number',
      className: 'ne-inspect-input',
      min: 2,
      max: 6,
      value: count,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Math.max(2, Math.min(6, Number(e.target.value) || 2));
        const nextSelected = Math.min(selected, n - 1);
        onChangeData({ count: n, selected: nextSelected });
      },
    }),
    createElement('label', { className: 'ne-inspect-label' }, 'Selected'),
    createElement(
      'div',
      { className: 'ne-inspect-chip-row' },
      ...Array.from({ length: count }, (_, i) =>
        createElement(
          'button',
          {
            key: i,
            type: 'button',
            className: 'ne-inspect-chip' + (selected === i ? ' is-active' : ''),
            onClick: () => onChangeData({ selected: i }),
          },
          `#${i + 1}`,
        ),
      ),
    ),
  );
};

const NullNodeInspector: NodeKindDef['Inspector'] = () =>
  createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Passthrough — forwards its single input unchanged. Handy for organizing long chains.',
    ),
  );

const PromptConcatInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const count = Number(node.data.count ?? 2);
  const separator = String(node.data.separator ?? ' ');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Inputs'),
    createElement('input', {
      type: 'number',
      className: 'ne-inspect-input',
      min: 2,
      max: 6,
      value: count,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Math.max(2, Math.min(6, Number(e.target.value) || 2));
        onChangeData({ count: n });
      },
    }),
    createElement('label', { className: 'ne-inspect-label' }, 'Separator'),
    createElement('input', {
      type: 'text',
      className: 'ne-inspect-input',
      value: separator,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onChangeData({ separator: e.target.value }),
    }),
  );
};

const CustomFalInspector: NodeKindDef['Inspector'] = () =>
  createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Custom FAL endpoint — coming in Phase B/2. You will be able to paste a fal.ai model slug and wire it into any graph.',
    ),
  );

// ---------------------------------------------------------------------------
// Registry table
// ---------------------------------------------------------------------------

export const NODE_KINDS: Record<NodeKind, NodeKindDef> = {
  'text-prompt': {
    kind: 'text-prompt',
    label: 'Text Prompt',
    category: 'input',
    defaultWidth: 220,
    defaultHeight: 140,
    defaultData: () => defaultDataFor('text-prompt'),
    ports: (data) => defaultPortsFor('text-prompt', data),
    Preview: TextPromptPreview,
    Inspector: TextPromptInspector,
  },
  'image-gen': {
    kind: 'image-gen',
    label: 'Image Gen',
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 180,
    defaultData: () => defaultDataFor('image-gen'),
    ports: (data) => defaultPortsFor('image-gen', data),
    Preview: ImageGenPreview,
    Inspector: ImageGenInspector,
  },
  'movie-gen': {
    kind: 'movie-gen',
    label: 'Movie Gen',
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 160,
    defaultData: () => defaultDataFor('movie-gen'),
    ports: (data) => defaultPortsFor('movie-gen', data),
    Preview: MovieGenPreview,
    Inspector: MovieGenInspector,
  },
  out: {
    kind: 'out',
    label: 'Out',
    category: 'output',
    defaultWidth: 200,
    defaultHeight: 160,
    defaultData: () => defaultDataFor('out'),
    ports: (data) => defaultPortsFor('out', data),
    Preview: OutPreview,
    Inspector: OutInspector,
  },
  switch: {
    kind: 'switch',
    label: 'Switch',
    category: 'utility',
    defaultWidth: 200,
    defaultHeight: 140,
    defaultData: () => defaultDataFor('switch'),
    ports: (data) => defaultPortsFor('switch', data),
    Preview: SwitchPreview,
    Inspector: SwitchInspector,
  },
  'null-node': {
    kind: 'null-node',
    label: 'Null',
    category: 'utility',
    defaultWidth: 160,
    defaultHeight: 100,
    defaultData: () => defaultDataFor('null-node'),
    ports: (data) => defaultPortsFor('null-node', data),
    Preview: NullNodePreview,
    Inspector: NullNodeInspector,
  },
  'prompt-concat': {
    kind: 'prompt-concat',
    label: 'Prompt Concat',
    category: 'utility',
    defaultWidth: 200,
    defaultHeight: 140,
    defaultData: () => defaultDataFor('prompt-concat'),
    ports: (data) => defaultPortsFor('prompt-concat', data),
    Preview: PromptConcatPreview,
    Inspector: PromptConcatInspector,
  },
  'custom-fal': {
    kind: 'custom-fal',
    label: 'Custom FAL',
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 140,
    defaultData: () => defaultDataFor('custom-fal'),
    ports: (data) => defaultPortsFor('custom-fal', data),
    Preview: CustomFalPreview,
    Inspector: CustomFalInspector,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function modelLabel(id: string): string {
  const m = HARD_CODED_IMAGE_MODELS.find((x) => x.id === id);
  return m ? m.label : id;
}
