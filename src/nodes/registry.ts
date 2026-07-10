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
//   - Preview: mostly visual state (thumbnail, text preview, "coming soon"
//     placeholder). May opt into light editing via the `onChangeData` prop
//     (e.g. text-prompt's inline textarea) — same reducer path as Inspector.
//   - Inspector: full form; calls `onChangeData` with a shallow patch. Calls
//     `onGenerate` when the user wants to execute starting at this node.

import { createElement, useEffect, useRef, Fragment, type FC } from 'react';
import type { BaseNode, NodeKind, NodeOutput, NodePort } from './types';
import { defaultDataFor, defaultPortsFor } from './types';
import { appendHistory, readNodeHistory } from './graph-utils';
import { FAL_MODELS } from '../ai/fal-models';

// Local view of a FAL model as this file needs it (id + label + coming-soon flag).
// Sourced from src/ai/fal-models.ts, filtered by kind.
export type FalImageModel = {
  id: string;
  label: string;
  comingSoon?: boolean;
};

const IMAGE_MODELS: FalImageModel[] = FAL_MODELS
  .filter((m) => m.kind === 'image')
  .map((m) => ({
    id: m.id,
    label: m.label,
    comingSoon: m.status === 'coming-soon',
  }));

const VIDEO_MODELS: FalImageModel[] = FAL_MODELS
  .filter((m) => m.kind === 'video')
  .map((m) => ({
    id: m.id,
    label: m.label,
    comingSoon: m.status === 'coming-soon',
  }));

// (Historic HARD_CODED_IMAGE_MODELS alias removed after migration to FAL_MODELS.)

const ASPECT_RATIOS: string[] = [
  '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9',
];

/**
 * Optional `onChangeData` prop threaded from NodeView → Preview so kinds
 * like text-prompt can offer inline editing. When absent (e.g. read-only
 * renders), the preview should fall back to display-only state.
 */
export type PreviewProps = {
  node: BaseNode;
  onChangeData?: (patch: Record<string, unknown>) => void;
};

export type NodeKindDef = {
  kind: NodeKind;
  label: string;
  category: 'input' | 'gen' | 'utility' | 'output';
  defaultWidth: number;
  defaultHeight: number;
  defaultData: () => Record<string, unknown>;
  ports: (data: Record<string, unknown>) => NodePort[];
  Preview: FC<PreviewProps>;
  Inspector: FC<{
    node: BaseNode;
    onChangeData: (patch: Record<string, unknown>) => void;
    onGenerate: () => void;
    inFlight: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Shared history hook — mirrors what the DAG executor SHOULD be doing, but
// piggy-backs on the Preview's render lifecycle since dag-executor.ts is off
// limits for this pass.
//
// TODO(dag-executor): Move history push into dag-executor.ts. When the
// executor is about to overwrite `node.output`, call:
//    graph = pushToHistory(graph, node.id, oldOutput);
// and delete this hook. The Preview components should read `data.__history`
// only — writing here creates an extra dispatch per render which is not
// ideal.
// ---------------------------------------------------------------------------
function useHistoryMirror(
  node: BaseNode,
  onChangeData: ((patch: Record<string, unknown>) => void) | undefined,
): NodeOutput[] {
  // Track the previous output snapshot we've seen for THIS node instance.
  // When `node.output.generatedAt` changes, we push the PREVIOUS snapshot
  // onto history — mirroring what the DAG executor should be doing itself.
  const prevOutputRef = useRef<NodeOutput | null>(null);
  const history = readNodeHistory(node);
  useEffect(() => {
    if (!onChangeData) return;
    const cur = node.output;
    const prev = prevOutputRef.current;
    // Update the tracking ref FIRST so subsequent renders compare against
    // the freshest snapshot.
    prevOutputRef.current = cur ? { ...cur } : null;
    if (!cur || !cur.generatedAt) return;
    if (!prev || !prev.generatedAt) return;
    if (prev.generatedAt === cur.generatedAt) return;
    // Guard: if the previous snapshot is already the tail of history (which
    // would happen if dag-executor ever starts pushing itself — see TODO),
    // skip to avoid double-pushes.
    const tail = history[history.length - 1];
    if (tail && tail.generatedAt === prev.generatedAt) return;
    const next = appendHistory(node, prev);
    onChangeData({ __history: next });
    // We intentionally omit `history` from deps: we only want this to fire
    // when the node's output changes, not on every history strip re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.output?.generatedAt, node.output?.dataUrl, onChangeData]);
  return history;
}

/** History strip helper (thumbnails only; restore is TODO). */
function renderHistoryStrip(history: NodeOutput[], kind: 'image' | 'video') {
  if (history.length === 0) return null;
  return createElement(
    'div',
    { className: 'ne-node-history-strip', title: 'Past outputs (click-restore coming soon)' },
    ...history.slice().reverse().map((h, i) => {
      const url = h.dataUrl;
      if (!url) return null;
      return createElement(
        'div',
        { key: (h.generatedAt ?? i) + '_' + i, className: 'ne-node-history-thumb' },
        kind === 'video'
          ? createElement('video', { src: url, muted: true, playsInline: true, preload: 'metadata' })
          : createElement('img', { src: url, alt: '', draggable: false }),
      );
    }).filter(Boolean),
  );
}

// ---------------------------------------------------------------------------
// Preview components
// ---------------------------------------------------------------------------

const TextPromptPreview: FC<PreviewProps> = ({ node, onChangeData }) => {
  const text = String(node.data.text ?? '');
  // Read-only fallback if the parent didn't give us onChangeData. Keeps the
  // old behavior for anyone who instantiates the preview in isolation.
  if (!onChangeData) {
    const trimmed = text.trim();
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--text' },
      trimmed
        ? createElement('div', { className: 'ne-node-preview-text' }, truncate(trimmed, 200))
        : createElement('div', { className: 'ne-node-preview-empty' }, '(empty prompt)'),
    );
  }
  // Editable: textarea fills the node body. Pointer events on the textarea
  // are stopped from bubbling so the node-drag handler on the header/body
  // never fires while typing/selecting text. The reducer's kbd handler
  // already ignores keydowns whose target is a TEXTAREA.
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--text is-editable' },
    createElement('textarea', {
      className: 'ne-node-inline-textarea',
      value: text,
      placeholder: 'Describe the shot\u2026',
      spellCheck: false,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChangeData({ text: e.target.value }),
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
      onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    }),
  );
};

const ImageGenPreview: FC<PreviewProps> = ({ node, onChangeData }) => {
  const history = useHistoryMirror(node, onChangeData);
  const url = node.output?.dataUrl;
  const model = String(node.data.modelId ?? 'nano-banana-pro');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--image' + (url ? '' : ' is-empty') },
    url
      ? createElement('img', {
          src: url,
          alt: '',
          draggable: false,
          className: 'ne-node-preview-thumb',
        })
      : createElement('div', { className: 'ne-node-preview-empty' }, 'no image yet'),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `${modelLabel(model)} \u00b7 ${aspect}`,
    ),
    renderHistoryStrip(history, 'image'),
  );
};

const MovieGenPreview: FC<PreviewProps> = ({ node, onChangeData }) => {
  const history = useHistoryMirror(node, onChangeData);
  const url = node.output?.dataUrl;
  const model = String(node.data.modelId ?? 'veo-3');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  const duration = Number(node.data.duration ?? 5);
  const prompt = String(node.data.prompt ?? '');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--video' + (url ? '' : ' is-empty') },
    url
      ? createElement('video', {
          src: url,
          muted: true,
          loop: true,
          autoPlay: true,
          playsInline: true,
          className: 'ne-node-preview-thumb',
        })
      : createElement('div', { className: 'ne-node-preview-empty' }, '\ud83c\udfac no video yet'),
    // Inline prompt — lets a Movie Gen node stand alone without a wired
    // Text Prompt. Upstream text (if wired) still concatenates in executor.
    onChangeData
      ? createElement('textarea', {
          className: 'ne-node-inline-textarea ne-node-inline-textarea--compact',
          value: prompt,
          placeholder: 'Video prompt (or wire a Text Prompt)…',
          spellCheck: false,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChangeData({ prompt: e.target.value }),
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
          onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
        })
      : null,
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `${modelLabel(model)} \u00b7 ${aspect} \u00b7 ${duration}s`,
    ),
    renderHistoryStrip(history, 'video'),
  );
};

// Out node visualized as a mini storyboard page: numbered header, image frame,
// and a caption strip. Makes it visually obvious that this is what will land
// in the panel when the editor closes.
const OutPreview: FC<PreviewProps> = ({ node }) => {
  const url = node.output?.dataUrl;
  const kind = node.output?.kind;
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--out-page' + (url ? '' : ' is-empty') },
    // Header strip mimicking a storyboard panel number / corner note
    createElement(
      'div',
      { className: 'ne-out-page-header' },
      createElement('span', { className: 'ne-out-page-num' }, '01'),
      createElement('span', { className: 'ne-out-page-corner' }, 'OUT'),
    ),
    // Image frame (or empty placeholder)
    createElement(
      'div',
      { className: 'ne-out-page-frame' },
      url
        ? (kind === 'video'
            ? createElement('video', { src: url, muted: true, loop: true, autoPlay: true, playsInline: true })
            : createElement('img', { src: url, alt: '', draggable: false }))
        : createElement('div', { className: 'ne-out-page-empty' }, 'no image yet'),
    ),
    // Caption strip
    createElement(
      'div',
      { className: 'ne-out-page-caption' },
      url ? 'panel image \u2192 storyboard' : 'wire something to me',
    ),
  );
};

const SwitchPreview: FC<PreviewProps> = ({ node }) => {
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

const NullNodePreview: FC<PreviewProps> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--null' },
    createElement('div', { className: 'ne-node-preview-caption' }, 'passthrough'),
  );

const PromptConcatPreview: FC<PreviewProps> = ({ node }) => {
  const count = Number(node.data.count ?? 2);
  const sep = JSON.stringify(String(node.data.separator ?? ' '));
  // If the node has been executed we have the combined text on
  // `node.output.text`. Show it so users can eyeball what will land in the
  // downstream ImageGen. When empty, hint the user to run the graph.
  const combined = typeof node.output?.text === 'string' ? node.output.text : '';
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--concat' },
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `Join ${count} texts with ${sep}`,
    ),
    combined
      ? createElement(
          'div',
          { className: 'ne-node-preview-text', style: { flex: 1, overflow: 'auto' } },
          truncate(combined, 400),
        )
      : createElement(
          'div',
          { className: 'ne-node-preview-empty' },
          'run to see combined text',
        ),
  );
};

const CustomFalPreview: FC<PreviewProps> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--stub' },
    createElement('div', { className: 'ne-node-preview-empty' }, '\ud83e\uddea custom FAL \u2014 coming soon'),
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
      placeholder: 'Describe the shot\u2026',
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChangeData({ text: e.target.value }),
    }),
  );
};

const ImageGenInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const modelId = String(node.data.modelId ?? 'nano-banana-pro');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  const variants = Number(node.data.num_images ?? 1);
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
        value: modelId,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onChangeData({ modelId: e.target.value }),
      },
      ...IMAGE_MODELS.map((m) =>
        createElement(
          'option',
          { key: m.id, value: m.id, disabled: m.comingSoon },
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
          onChangeData({ aspect_ratio: e.target.value }),
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
            onClick: () => onChangeData({ num_images: n }),
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
      inFlight ? 'Generating\u2026' : 'Generate',
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

const MovieGenInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const modelId = String(node.data.modelId ?? 'veo-3');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  const duration = Number(node.data.duration ?? 5);
  const url = node.output?.dataUrl;

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Model'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: modelId,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onChangeData({ modelId: e.target.value }),
      },
      ...VIDEO_MODELS.map((m) =>
        createElement(
          'option',
          { key: m.id, value: m.id, disabled: m.comingSoon },
          m.comingSoon ? `${m.label} (coming soon)` : m.label,
        ),
      ),
    ),
    createElement('label', { className: 'ne-inspect-label' }, 'Aspect Ratio'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: aspect,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onChangeData({ aspect_ratio: e.target.value }),
      },
      ...['16:9', '9:16', '1:1'].map((a) =>
        createElement('option', { key: a, value: a }, a),
      ),
    ),
    createElement('label', { className: 'ne-inspect-label' }, 'Duration (seconds)'),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'number',
      min: 1,
      max: 30,
      step: 1,
      value: duration,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onChangeData({ duration: Number(e.target.value) || 5 }),
    }),
    createElement(
      'button',
      {
        type: 'button',
        className: 'ne-inspect-generate',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Generating\u2026 (video takes 1-5 min)' : 'Generate',
    ),
    url
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('video', {
            src: url,
            controls: true,
            style: { maxWidth: '100%', maxHeight: '240px', borderRadius: '6px' },
          }),
        )
      : null,
  );
};

const OutInspector: NodeKindDef['Inspector'] = ({ node }) => {
  const url = node.output?.dataUrl;
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'The Out node writes back to the Panel when you press \u2318S. Whatever image reaches this node becomes the panel image.',
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
      'Passthrough \u2014 forwards its single input unchanged. Handy for organizing long chains.',
    ),
  );

const PromptConcatInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  // Clamp 2\u20138 per the task spec (was 2\u20136 before).
  const count = Math.max(2, Math.min(8, Number(node.data.count ?? 2)));
  const separator = String(node.data.separator ?? ' ');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Inputs'),
    // +/\u2212 stepper matches the task spec: buttons + clamp 2\u20138. We keep the
    // number field alongside for direct typing/scrubbing.
    createElement(
      Fragment,
      null,
      createElement(
        'div',
        { className: 'ne-inspect-chip-row' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'ne-inspect-chip',
            disabled: count <= 2,
            onClick: () => onChangeData({ count: Math.max(2, count - 1) }),
          },
          '\u2212 input',
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'ne-inspect-chip',
            disabled: count >= 8,
            onClick: () => onChangeData({ count: Math.min(8, count + 1) }),
          },
          '+ input',
        ),
        createElement(
          'span',
          { style: { fontSize: '11px', color: '#9a9aa2', alignSelf: 'center' } },
          `${count} inputs`,
        ),
      ),
    ),
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
      'Custom FAL endpoint \u2014 coming in Phase B/2. You will be able to paste a fal.ai model slug and wire it into any graph.',
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
  return s.slice(0, n - 1) + '\u2026';
}

function modelLabel(id: string): string {
  const m = FAL_MODELS.find((x) => x.id === id);
  return m ? m.label : id;
}
