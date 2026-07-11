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

import { createElement, useEffect, useRef, useContext, createContext, Fragment, type FC } from 'react';
import type { BaseNode, NodeKind, NodeOutput, NodePort } from './types';
import { defaultDataFor, defaultPortsFor } from './types';
import { appendHistory, readNodeHistory } from './graph-utils';
import { FAL_MODELS } from '../ai/fal-models';

// ---------------------------------------------------------------------------
// Panel-ref lookup context. NodeEditor provides the list of available
// storyboard panels (id + label + tiny thumb) so a Panel node's Inspector
// can render a picker. Optional — undefined means "not in an app context".
// ---------------------------------------------------------------------------
export type PanelRefOption = {
  id: string;
  label: string;         // "Storyboard 1 · Panel 3" style
  thumbUrl?: string;     // small preview if available
  imageDataUrl?: string; // full data URL (baked into the node on pick)
};

export const PanelRefContext = createContext<{
  panels: PanelRefOption[];
}>({ panels: [] });

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
  /**
   * Trigger a downstream re-run rooted at this node. Wired by the parent
   * NodeEditor to the same executor path the Inspector uses. Optional so
   * previews rendered outside the editor still work.
   */
  onRun?: () => void;
  /**
   * Promote a history frame (0 = oldest, hist.length-1 = newest) to be the
   * node's current output. Demotes the previous current output into history
   * at the same index. Wired by NodeEditor via a PROMOTE_FRAME reducer
   * action.
   */
  onPromoteFrame?: (historyIndex: number) => void;
  /**
   * Full graph. Optional — previews that want to render an on-the-fly
   * synthesis of upstream inputs (e.g. Prompt Concat's read-only combined
   * text) use this to peek at connected nodes' data/output without waiting
   * for the executor to run.
   */
  graph?: import('./types').NodeGraph;
};

export type NodeKindDef = {
  kind: NodeKind;
  label: string;
  category: 'input' | 'gen' | 'utility' | 'output';
  /**
   * When true, this kind is hidden from the palette and the right-click
   * "Add node" menu. The reducer may still spawn one via seedDefaultGraph
   * (Out is the classic example — every panel gets exactly one, auto-seeded).
   */
  hiddenFromPalette?: boolean;
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

// `renderHistoryStrip` was retired in favor of the shared renderMediaThumb
// helper below, which combines the current output + history nav + save
// button in a single control. Kept out of the bundle entirely.

// ---------------------------------------------------------------------------
// Save-to-disk helper. Given a data URL (or http URL), triggers a browser
// download with a sensible filename.
// ---------------------------------------------------------------------------
function downloadMedia(url: string, kind: 'image' | 'video', hint?: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = kind === 'video' ? 'mp4' : 'png';
  const label = (hint ?? 'boardfish').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
  const filename = `${label}-${ts}.${ext}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Render the shared media thumbnail: image or video, with ‹/› history nav,
 * save button, movie playback controls (for videos), and a frame counter.
 * Selecting a history frame promotes it to `node.output` via onPromoteFrame.
 */
function renderMediaThumb(opts: {
  node: BaseNode;
  kind: 'image' | 'video';
  currentUrl: string | undefined;
  history: NodeOutput[];              // oldest → newest
  onPromoteFrame?: (historyIndex: number) => void;
  labelHint?: string;
}) {
  const { node, kind, currentUrl, history, onPromoteFrame, labelHint } = opts;
  // Total frames: current output first (index 0), then history newest→oldest.
  // We navigate ‹/› by promoting history frames. Selecting the "current" is
  // the default (no promote needed).
  const historyNewestFirst = history.slice().reverse();
  const totalFrames = (currentUrl ? 1 : 0) + historyNewestFirst.length;

  if (!currentUrl) {
    return createElement(
      'div',
      { className: 'ne-node-preview-empty' },
      kind === 'video' ? '\ud83c\udfac no video yet' : 'no image yet',
    );
  }

  // ‹ prev / › next map to promoting an older/newer history frame.
  // "prev" walks back in time (toward older history).
  //   totalFrames = 1 + hist.length; current is slot 0, hist[hist.length-1]
  //   (newest history) is slot 1, hist[0] (oldest) is slot totalFrames-1.
  // Promoting historyIndex = original-hist-array index (oldest=0).
  const canNav = totalFrames > 1 && Boolean(onPromoteFrame);

  function goPrev() {
    if (!onPromoteFrame || history.length === 0) return;
    // Newest history frame — promote it (becomes current, current drops to hist).
    onPromoteFrame(history.length - 1);
  }
  function goNext() {
    if (!onPromoteFrame || history.length === 0) return;
    // Oldest history frame — same swap mechanism, just to give a symmetric
    // arrow. This is intentionally "wrap" behavior: › steps through older
    // frames the other way.
    onPromoteFrame(0);
  }

  const media = kind === 'video'
    ? createElement('video', {
        src: currentUrl,
        controls: true,
        loop: true,
        playsInline: true,
        preload: 'metadata',
        className: 'ne-node-preview-thumb',
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      })
    : createElement('img', {
        src: currentUrl,
        alt: '',
        draggable: false,
        className: 'ne-node-preview-thumb',
      });

  return createElement(
    'div',
    { className: 'ne-media-thumb-wrap' },
    media,
    canNav
      ? createElement(
          'button',
          {
            className: 'ne-media-arrow ne-media-arrow--prev',
            type: 'button',
            title: 'Previous version',
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); goPrev(); },
            onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          },
          '\u2039',
        )
      : null,
    canNav
      ? createElement(
          'button',
          {
            className: 'ne-media-arrow ne-media-arrow--next',
            type: 'button',
            title: 'Next version',
            onClick: (e: React.MouseEvent) => { e.stopPropagation(); goNext(); },
            onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          },
          '\u203a',
        )
      : null,
    createElement(
      'div',
      { className: 'ne-media-badge-row' },
      totalFrames > 1
        ? createElement(
            'span',
            { className: 'ne-media-counter' },
            `1 / ${totalFrames}`,
          )
        : null,
      createElement(
        'button',
        {
          className: 'ne-media-save',
          type: 'button',
          title: 'Save to disk',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            downloadMedia(currentUrl, kind, labelHint ?? node.kind);
          },
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        },
        '\u2b07',
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Preview components
// ---------------------------------------------------------------------------

const TextPromptPreview: FC<PreviewProps> = ({ node, onChangeData, onRun }) => {
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
  //
  // The little expand icon (⭶) triggers the fullscreen prompt editor via a
  // synthetic keyboard event so the tap-Space handler can pick it up. This
  // gives users a mouse affordance now that Space types spaces inside the
  // textarea instead of hijacking to open fullscreen.
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
    createElement(
      'button',
      {
        className: 'ne-node-expand-btn',
        type: 'button',
        title: 'Expand prompt editor',
        'aria-label': 'Expand prompt editor',
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          // Dispatch a custom event that NodeEditor listens for to open the
          // fullscreen prompt editor on this node. Keeps the Preview
          // decoupled from NodeEditor's local state.
          window.dispatchEvent(
            new CustomEvent('boardfish:open-prompt-editor', { detail: { nodeId: node.id } }),
          );
        },
      },
      // Diagonal expand-arrows glyph (no semi-circle chevrons)
      createElement(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
        createElement('path', {
          d: 'M2 6 L2 2 L6 2 M14 10 L14 14 L10 14 M2 2 L7 7 M14 14 L9 9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ),
    ),
    // Suppress unused-var warning — onRun is available if future work wants
    // to add a per-node run button next to the expand button.
    onRun ? null : null,
  );
};

const ImageGenPreview: FC<PreviewProps> = ({ node, onChangeData, onPromoteFrame }) => {
  const history = useHistoryMirror(node, onChangeData);
  const url = node.output?.dataUrl;
  const model = String(node.data.modelId ?? 'nano-banana-pro');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--image' + (url ? '' : ' is-empty') },
    renderMediaThumb({
      node,
      kind: 'image',
      currentUrl: url,
      history,
      onPromoteFrame,
      labelHint: `image-${modelLabel(model).toLowerCase()}`,
    }),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      `${modelLabel(model)} \u00b7 ${aspect}`,
    ),
  );
};

const MovieGenPreview: FC<PreviewProps> = ({ node, onChangeData, onPromoteFrame }) => {
  const history = useHistoryMirror(node, onChangeData);
  const url = node.output?.dataUrl;
  const model = String(node.data.modelId ?? 'veo-3');
  const aspect = String(node.data.aspect_ratio ?? '16:9');
  const duration = node.data.duration ?? '8s';
  const prompt = String(node.data.prompt ?? '');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--video' + (url ? '' : ' is-empty') },
    renderMediaThumb({
      node,
      kind: 'video',
      currentUrl: url,
      history,
      onPromoteFrame,
      labelHint: `video-${modelLabel(model).toLowerCase()}`,
    }),
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
      `${modelLabel(model)} \u00b7 ${aspect} \u00b7 ${duration}`,
    ),
  );
};

// Out node visualized as a mini storyboard page: numbered header, image frame,
// and a caption strip. Makes it visually obvious that this is what will land
// in the panel when the editor closes.
const OutPreview: FC<PreviewProps> = ({ node, onRun, onPromoteFrame }) => {
  const url = node.output?.dataUrl;
  const kind = node.output?.kind;
  const history = readNodeHistory(node);
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--out-page' + (url ? '' : ' is-empty') },
    // Header strip mimicking a storyboard panel number / corner note
    createElement(
      'div',
      { className: 'ne-out-page-header' },
      createElement('span', { className: 'ne-out-page-num' }, '01'),
      createElement('span', { className: 'ne-out-page-corner' }, 'OUT'),
      onRun
        ? createElement(
            'button',
            {
              className: 'ne-out-page-refresh',
              type: 'button',
              title: 'Refresh from upstream',
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation();
                onRun();
              },
              onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
              onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
            },
            '\u21bb',
          )
        : null,
    ),
    // Image frame (or empty placeholder). Video Out shows first-frame poster
    // through the shared MediaThumb — playback controls come along too.
    createElement(
      'div',
      { className: 'ne-out-page-frame' },
      url
        ? renderMediaThumb({
            node,
            kind: kind === 'video' ? 'video' : 'image',
            currentUrl: url,
            history,
            onPromoteFrame,
            labelHint: 'panel',
          })
        : createElement('div', { className: 'ne-out-page-empty' }, 'wire something to me'),
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

const PromptConcatPreview: FC<PreviewProps> = ({ node, graph }) => {
  const count = Number(node.data.count ?? 2);
  const sep = typeof node.data.separator === 'string' ? String(node.data.separator) : ' · ';
  const own = typeof node.data.text === 'string' ? String(node.data.text) : '';

  // Compute an on-the-fly preview of the concatenated text by peeking at the
  // connected upstream nodes' text (from output.text if the executor has run,
  // otherwise from data.text for text-prompt-like nodes). This mirrors what
  // runPromptConcat does without needing a full graph run — so the user sees
  // the effective prompt live as they type.
  let combined = '';
  if (graph) {
    const parts: string[] = [];
    // Walk edges pointing at this node in order (by portId asc for stability).
    const incoming = graph.edges
      .filter((e) => e.to.nodeId === node.id)
      .slice()
      .sort((a, b) => a.to.portId.localeCompare(b.to.portId));
    for (const e of incoming) {
      const upstream = graph.nodes.find((n) => n.id === e.from.nodeId);
      if (!upstream) continue;
      const out = upstream.output;
      let text = '';
      if (out && out.kind === 'text' && typeof out.text === 'string') text = out.text;
      else if (typeof (upstream.data as Record<string, unknown>).text === 'string')
        text = String((upstream.data as Record<string, unknown>).text);
      if (text) parts.push(text);
    }
    if (own) parts.push(own);
    combined = parts.filter(Boolean).join(sep);
  } else if (typeof node.output?.text === 'string') {
    combined = node.output.text;
  }

  // Render as a read-only Prompt-style preview (matching TextPromptPreview's
  // textarea styling) so the concatenated result reads like a real prompt.
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--text is-readonly' },
    createElement('textarea', {
      className: 'ne-node-inline-textarea ne-node-inline-textarea--readonly',
      value: combined,
      placeholder: `Join ${count} texts with "${sep}"…`,
      spellCheck: false,
      readOnly: true,
      // Same event-stop as the editable variant so clicks/wheels don't drag
      // the node while the user reads/scrolls the combined text.
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
    }),
  );
};

const CustomFalPreview: FC<PreviewProps> = () =>
  createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--stub' },
    createElement('div', { className: 'ne-node-preview-empty' }, '\ud83e\uddea custom FAL \u2014 coming soon'),
  );

const PanelRefPreview: FC<PreviewProps> = ({ node }) => {
  const imageDataUrl = String(node.data.imageDataUrl ?? '');
  const panelLabel = String(node.data.panelLabel ?? '');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--image' + (imageDataUrl ? '' : ' is-empty') },
    imageDataUrl
      ? createElement('img', {
          src: imageDataUrl,
          alt: '',
          draggable: false,
          className: 'ne-node-preview-thumb',
        })
      : createElement(
          'div',
          { className: 'ne-node-preview-empty' },
          'pick a panel in the Inspector \u2192',
        ),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      panelLabel || 'Panel Ref',
    ),
  );
};

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
  // Once a node has produced output, lock the model dropdown. Different
  // models have different input schemas (variants, resolution, duration,
  // etc.), so switching mid-flight silently strips the wrong keys or sends
  // stale ones. If the user really wants a different model, they can add
  // a new Image Gen node.
  const modelLocked = Boolean(url);

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
        disabled: modelLocked,
        title: modelLocked ? 'Model is locked once this node has generated. Add a new Image Gen node to switch models.' : undefined,
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
  const modelLocked = Boolean(url);

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Model'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: modelId,
        disabled: modelLocked,
        title: modelLocked ? 'Model is locked once this node has generated. Add a new Movie Gen node to switch models.' : undefined,
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
    createElement(
      'div',
      { className: 'ne-inspect-chip-row' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'ne-inspect-chip',
          disabled: count <= 2,
          onClick: () => {
            const n = Math.max(2, count - 1);
            const nextSelected = Math.min(selected, n - 1);
            onChangeData({ count: n, selected: nextSelected });
          },
        },
        '\u2212 input',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'ne-inspect-chip',
          disabled: count >= 6,
          onClick: () => {
            onChangeData({ count: Math.min(6, count + 1) });
          },
        },
        '+ input',
      ),
      createElement(
        'span',
        { style: { fontSize: '11px', color: '#9a9aa2', alignSelf: 'center' } },
        `${count} inputs`,
      ),
    ),
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

const PanelRefInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const { panels } = useContext(PanelRefContext);
  const panelId = String(node.data.panelId ?? '');
  const panelLabel = String(node.data.panelLabel ?? '');
  const imageDataUrl = String(node.data.imageDataUrl ?? '');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Reference panel'),
    panels.length === 0
      ? createElement(
          'div',
          { className: 'ne-inspect-note' },
          'No panels in this project yet. Create some storyboard panels first, then come back.',
        )
      : createElement(
          'select',
          {
            className: 'ne-inspect-select',
            value: panelId,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              const nextId = e.target.value;
              const opt = panels.find((p) => p.id === nextId);
              onChangeData({
                panelId: nextId,
                panelLabel: opt?.label ?? '',
                imageDataUrl: opt?.imageDataUrl ?? '',
              });
            },
          },
          createElement('option', { key: '__none', value: '' }, '\u2014 pick a panel \u2014'),
          ...panels.map((p) =>
            createElement(
              'option',
              { key: p.id, value: p.id },
              p.label + (p.imageDataUrl ? '' : ' (no image)'),
            ),
          ),
        ),
    panelId && !imageDataUrl
      ? createElement(
          'div',
          { className: 'ne-inspect-note' },
          'This panel has no rendered image yet. Generate its image first, or pick a different panel.',
        )
      : null,
    imageDataUrl
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('img', { src: imageDataUrl, alt: '', draggable: false }),
        )
      : null,
    panelLabel
      ? createElement(
          'div',
          { className: 'ne-inspect-note' },
          `Bound to: ${panelLabel}`,
        )
      : null,
  );
};

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
    // The Out node is the storyboard panel — there is exactly one per graph
    // and it is auto-seeded when the editor opens. Hide it from the palette
    // so users can't add duplicates.
    hiddenFromPalette: true,
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
  'panel-ref': {
    kind: 'panel-ref',
    label: 'Panel Ref',
    category: 'input',
    defaultWidth: 200,
    defaultHeight: 180,
    defaultData: () => defaultDataFor('panel-ref'),
    ports: (data) => defaultPortsFor('panel-ref', data),
    Preview: PanelRefPreview,
    Inspector: PanelRefInspector,
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
