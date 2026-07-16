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

import { createElement, useEffect, useMemo, useRef, useState, useContext, createContext, Fragment, type FC } from 'react';
import type { BaseNode, NodeKind, NodeOutput, NodePort } from './types';
import { defaultDataFor, defaultPortsFor } from './types';
import { appendHistory, readNodeHistory } from './graph-utils';
import { FAL_MODELS, getFalModel, resolveFalModelId } from '../ai/fal-models';
import type { FalModelInput } from '../ai/fal-models';
import { GenerateButtonWithCost } from '../components/GenerateButtonWithCost';

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
  storyboardId: string;      // groups panels in the picker
  storyboardLabel: string;   // display name of the parent storyboard (from overrides.name or fallback)
  panelIndex: number;        // 1-based index within its storyboard
  aspectRatio: number;       // width / height, resolved from storyboard override or project default
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
    // Also reset the media viewer cursor to 0 (= new current) so the counter
    // shows 1/N of the fresh generation set instead of pointing at the frame
    // the user was previously peeking at.
    onChangeData({ __history: next, __viewIdx: 0 });
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
 *
 * Navigation model (2026-07-11 rewrite):
 *   Instead of destructively swapping frames via onPromoteFrame on every
 *   click (which never lets the counter progress past 2/N and lost stable
 *   ordering), the arrows now bump a viewer cursor stored in
 *   `node.data.__viewIdx`. The display list is
 *      [current, ...historyNewestFirst]
 *   which stays stable across nav clicks; only viewIdx changes. viewIdx=0 is
 *   the "canonical" current output that downstream nodes see; viewIdx>0 is a
 *   look-back into history that doesn't touch `node.output`.
 *
 *   When the viewer commits (double-click the media OR export the node OR
 *   the graph is re-executed), whichever frame is at viewIdx is promoted to
 *   canonical via onPromoteFrame. Until then, downstream connections keep
 *   reading `node.output` unchanged.
 */
function renderMediaThumb(opts: {
  node: BaseNode;
  kind: 'image' | 'video';
  currentUrl: string | undefined;
  history: NodeOutput[];              // oldest → newest
  onPromoteFrame?: (historyIndex: number) => void;
  onChangeData?: (patch: Record<string, unknown>) => void;
  labelHint?: string;
}) {
  const { node, kind, currentUrl, history, onPromoteFrame, onChangeData, labelHint } = opts;
  // Display array: newest-first. Index 0 = live current, indices 1..H = history
  // from newest to oldest.
  const historyNewestFirst = history.slice().reverse();
  const totalFrames = (currentUrl ? 1 : 0) + historyNewestFirst.length;

  if (!currentUrl) {
    return createElement(
      'div',
      { className: 'ne-node-preview-empty' },
      kind === 'video' ? '\ud83c\udfac no video yet' : 'no image yet',
    );
  }

  // Clamp the stored view cursor to a valid index. When history shrinks (user
  // deletes a frame from the strip) we snap back to 0 rather than leaving a
  // dangling cursor pointing past the end of the array.
  const rawViewIdx = Number((node.data as Record<string, unknown>).__viewIdx);
  const viewIdx = Number.isFinite(rawViewIdx) && rawViewIdx >= 0 && rawViewIdx < totalFrames
    ? Math.floor(rawViewIdx)
    : 0;

  // Resolve the frame at this cursor:
  //   viewIdx = 0 → currentUrl (live output)
  //   viewIdx = k → historyNewestFirst[k-1]
  const displayFrame = viewIdx === 0
    ? { dataUrl: currentUrl, kind }
    : historyNewestFirst[viewIdx - 1];
  const displayUrl = (displayFrame && (displayFrame as { dataUrl?: string }).dataUrl) || currentUrl;

  const canNav = totalFrames > 1;

  function setViewIdx(next: number) {
    if (!onChangeData) return;
    const clamped = ((next % totalFrames) + totalFrames) % totalFrames;
    onChangeData({ __viewIdx: clamped });
  }
  function goPrev() {
    // ‹ : step to a NEWER frame (viewIdx -1, wrap). At viewIdx=0 the only
    // newer thing is a wrap back to the oldest.
    setViewIdx(viewIdx - 1);
  }
  function goNext() {
    // › : step to an OLDER frame (viewIdx +1, wrap).
    setViewIdx(viewIdx + 1);
  }
  function commitPromote() {
    // Double-click / ⌘-click the media to make the currently-viewed frame
    // the canonical current output. Uses the existing PROMOTE_FRAME reducer.
    if (viewIdx === 0) return;                          // already canonical
    if (!onPromoteFrame || history.length === 0) return;
    // Display idx k (k>=1) corresponds to historyNewestFirst[k-1], which in
    // the ORIGINAL oldest-first history array is index `history.length - k`.
    onPromoteFrame(history.length - viewIdx);
    // After promote, the new current is at display 0.
    if (onChangeData) onChangeData({ __viewIdx: 0 });
  }

  const media = kind === 'video'
    ? createElement('video', {
        src: displayUrl,
        controls: true,
        loop: true,
        playsInline: true,
        preload: 'metadata',
        className: 'ne-node-preview-thumb',
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); commitPromote(); },
      })
    : createElement('img', {
        src: displayUrl,
        alt: '',
        draggable: false,
        className: 'ne-node-preview-thumb',
        onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); commitPromote(); },
      });

  // Small arrow SVG glyphs (real arrows, not chevrons). Kept identical shape
  // to the storyboard lightbox for visual consistency.
  const prevArrowSvg = createElement(
    'svg',
    { viewBox: '0 0 20 20', width: 12, height: 12, 'aria-hidden': true },
    createElement('path', {
      d: 'M13 3 L5 10 L13 17 M5 10 L18 10',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
  const nextArrowSvg = createElement(
    'svg',
    { viewBox: '0 0 20 20', width: 12, height: 12, 'aria-hidden': true },
    createElement('path', {
      d: 'M7 3 L15 10 L7 17 M15 10 L2 10',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
  const downloadSvg = createElement(
    'svg',
    { viewBox: '0 0 20 20', width: 12, height: 12, 'aria-hidden': true },
    createElement('path', {
      d: 'M10 3 L10 13 M6 9 L10 13 L14 9 M4 16 L16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );

  return createElement(
    'div',
    { className: 'ne-media-thumb-wrap' },
    media,
    // Top-right toolbar: prev / next / counter / download. Always on top of
    // the media, above port labels, and stays inside the node's rectangle.
    createElement(
      'div',
      {
        className: 'ne-media-toolbar',
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      },
      canNav
        ? createElement(
            'button',
            {
              className: 'ne-media-toolbar-btn',
              type: 'button',
              title: 'Previous version',
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); goPrev(); },
            },
            prevArrowSvg,
          )
        : null,
      canNav
        ? createElement(
            'button',
            {
              className: 'ne-media-toolbar-btn',
              type: 'button',
              title: 'Next version',
              onClick: (e: React.MouseEvent) => { e.stopPropagation(); goNext(); },
            },
            nextArrowSvg,
          )
        : null,
      totalFrames > 1
        ? createElement(
            'span',
            {
              className: 'ne-media-toolbar-counter' + (viewIdx !== 0 ? ' is-off-canonical' : ''),
              title: viewIdx === 0
                ? 'Current output — downstream nodes see this frame.'
                : 'Viewing a history frame. Double-click the media (or heart it in fullscreen) to make it current.',
            },
            `${viewIdx + 1} / ${totalFrames}`,
          )
        : null,
      createElement(
        'button',
        {
          className: 'ne-media-toolbar-btn',
          type: 'button',
          title: 'Save this frame to disk',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            downloadMedia(displayUrl, kind, labelHint ?? node.kind);
          },
        },
        downloadSvg,
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
      onChangeData,
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
      onChangeData,
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
const OutPreview: FC<PreviewProps> = ({ node, onRun, onPromoteFrame, onChangeData }) => {
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
            onChangeData,
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

const CustomFalPreview: FC<PreviewProps> = ({ node, onChangeData, onPromoteFrame }) => {
  const history = useHistoryMirror(node, onChangeData);
  const out = node.output;
  const endpoint = String(node.data.endpoint ?? '').trim();
  const kind: 'image' | 'video' | null =
    out?.kind === 'image' ? 'image'
    : out?.kind === 'video' ? 'video'
    : null;
  const url = out?.dataUrl;

  // Text/unknown outputs: show a small JSON blob.
  if (out && !kind) {
    const text = out.text ?? '';
    return createElement(
      'div',
      { className: 'ne-node-preview' },
      createElement(
        'pre',
        {
          style: {
            margin: 0,
            padding: '6px 8px',
            fontSize: '10px',
            lineHeight: '1.3',
            color: '#c0c0c8',
            background: '#1a1a1f',
            border: '1px solid #2a2a30',
            borderRadius: '4px',
            maxHeight: '120px',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        },
        truncate(text, 800) || '(empty)',
      ),
      createElement(
        'div',
        { className: 'ne-node-preview-caption' },
        endpoint ? truncate(endpoint, 32) : '🧪 Custom FAL',
      ),
    );
  }

  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--' + (kind ?? 'image') + (url ? '' : ' is-empty') },
    kind
      ? renderMediaThumb({
          node,
          kind,
          currentUrl: url,
          history,
          onPromoteFrame,
          onChangeData,
          labelHint: `custom-fal-${(endpoint.split('/').pop() ?? 'out').toLowerCase()}`,
        })
      : createElement('div', { className: 'ne-node-preview-empty' }, endpoint ? '🧪 ready' : '🧪 paste an endpoint'),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      endpoint ? truncate(endpoint, 40) : 'Custom FAL',
    ),
  );
};

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

/**
 * Random Seed + editable seed value control. Any image or video model whose
 * FAL schema declares a `seed` input gets this rendered automatically.
 *
 * Behavior:
 *   - Checkbox toggles "Random seed". When checked, node.data.seed is left
 *     unset (executor sends nothing → FAL picks a random one).
 *   - When unchecked, a numeric field lets the user pin a specific seed.
 *   - Roll button randomizes the pinned seed to a fresh integer.
 */
/**
 * Render a single schema-driven form control for one `FalModelInput`.
 * Handles select/aspect (both are dropdowns), text, number, and boolean.
 * Skips `image-url` (rendered as ports on the node) and `seed` (rendered
 * via renderSeedControl). Returns null for keys the caller wants to skip.
 *
 * The value written back to `node.data[input.key]` matches the FAL schema:
 *   - select/aspect → string
 *   - number → number
 *   - boolean → boolean
 *   - text → string (undefined when blank to keep FAL happy)
 */
function renderSchemaInput(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
  input: FalModelInput,
) {
  const raw = (node.data as Record<string, unknown>)[input.key];
  const cur = raw === undefined || raw === null ? (input.default ?? '') : raw;

  // Aspect + select share the same UI
  if (input.type === 'select' || input.type === 'aspect') {
    const opts = input.options ?? [];
    return createElement(
      Fragment,
      { key: input.key },
      createElement('label', { className: 'ne-inspect-label' }, input.label),
      createElement(
        'select',
        {
          className: 'ne-inspect-select',
          value: String(cur ?? ''),
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
            onChangeData({ [input.key]: e.target.value }),
        },
        ...opts.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
      ),
      input.help
        ? createElement('div', { className: 'ne-inspect-note', style: { fontSize: '11px' } }, input.help)
        : null,
    );
  }

  if (input.type === 'number') {
    const val = typeof cur === 'number' && Number.isFinite(cur) ? cur : Number(cur);
    return createElement(
      Fragment,
      { key: input.key },
      createElement('label', { className: 'ne-inspect-label' }, input.label),
      createElement('input', {
        className: 'ne-inspect-input',
        type: 'number',
        min: input.min,
        max: input.max,
        step: input.step ?? 1,
        value: Number.isFinite(val) ? val : (typeof input.default === 'number' ? input.default : 0),
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          let clamped = n;
          if (input.min !== undefined) clamped = Math.max(input.min, clamped);
          if (input.max !== undefined) clamped = Math.min(input.max, clamped);
          onChangeData({ [input.key]: clamped });
        },
      }),
    );
  }

  if (input.type === 'boolean') {
    const checked = typeof cur === 'boolean' ? cur : (input.default === true);
    return createElement(
      'label',
      { key: input.key, className: 'ne-inspect-checkbox', style: { marginTop: '8px' } },
      createElement('input', {
        type: 'checkbox',
        checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          onChangeData({ [input.key]: e.target.checked }),
      }),
      ' ' + input.label,
    );
  }

  if (input.type === 'text') {
    // Long-ish text fields (system_prompt, negative_prompt, last_frame_url)
    // get a textarea; single-line otherwise.
    const isLong = /prompt|url|instruction/i.test(input.key);
    return createElement(
      Fragment,
      { key: input.key },
      createElement('label', { className: 'ne-inspect-label' }, input.label),
      isLong
        ? createElement('textarea', {
            className: 'ne-inspect-textarea',
            rows: 3,
            value: String(cur ?? ''),
            placeholder: input.help,
            onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
              const v = e.target.value;
              onChangeData({ [input.key]: v === '' ? undefined : v });
            },
          })
        : createElement('input', {
            className: 'ne-inspect-input',
            type: 'text',
            value: String(cur ?? ''),
            placeholder: input.help,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
              const v = e.target.value;
              onChangeData({ [input.key]: v === '' ? undefined : v });
            },
          }),
    );
  }

  // image-url / seed → rendered elsewhere
  return null;
}

/**
 * Given a model, render schema-driven inputs for every key NOT in `skipKeys`.
 * Keeps the inspector current whenever fal-models.ts adds new options.
 */
function renderSchemaExtras(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
  model: import('../ai/fal-models').FalModelDef | null,
  skipKeys: Set<string>,
) {
  if (!model) return null;
  return model.inputs
    .filter((inp) => !skipKeys.has(inp.key))
    .filter((inp) => inp.type !== 'image-url' && inp.type !== 'seed')
    .map((inp) => renderSchemaInput(node, onChangeData, inp))
    .filter(Boolean);
}

function renderSeedControl(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
) {
  const rawSeed = (node.data as Record<string, unknown>).seed;
  const hasSeed = typeof rawSeed === 'number' && Number.isFinite(rawSeed);
  const seedVal = hasSeed ? (rawSeed as number) : 0;
  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, 'Seed'),
    createElement(
      'label',
      { className: 'ne-inspect-checkbox' },
      createElement('input', {
        type: 'checkbox',
        checked: !hasSeed,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          if (e.target.checked) {
            // Turn on Random → clear stored seed.
            onChangeData({ seed: undefined });
          } else {
            // Turn off Random → pin a new random integer as the starting seed.
            const initial = Math.floor(Math.random() * 2_147_483_647);
            onChangeData({ seed: initial });
          }
        },
      }),
      ' Random seed each gen',
    ),
    !hasSeed
      ? null
      : createElement(
          'div',
          { className: 'ne-inspect-seed-row' },
          createElement('input', {
            className: 'ne-inspect-input',
            type: 'number',
            min: 0,
            step: 1,
            value: seedVal,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
              const n = Number(e.target.value);
              onChangeData({ seed: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0 });
            },
          }),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ne-inspect-chip',
              title: 'Roll a new random seed',
              onClick: () => onChangeData({ seed: Math.floor(Math.random() * 2_147_483_647) }),
            },
            '🎲 Roll',
          ),
        ),
  );
}

/**
 * Shared variants control for Image Gen and Movie Gen. Renders four preset
 * chips (1/2/3/4) plus a free-form number field for arbitrary counts.
 * `dataKey` is the node.data field to write ('num_images' for images,
 * 'num_videos' for movies). `max` bounds the arbitrary input.
 */
function renderVariantsControl(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
  dataKey: 'num_images' | 'num_videos',
  max: number,
) {
  const raw = Number((node.data as Record<string, unknown>)[dataKey]);
  const value = Number.isFinite(raw) && raw >= 1 ? Math.min(max, Math.floor(raw)) : 1;
  const presets = [1, 2, 3, 4];
  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, 'Variants'),
    createElement(
      'div',
      { className: 'ne-inspect-chip-row' },
      ...presets.map((n) =>
        createElement(
          'button',
          {
            key: n,
            type: 'button',
            className: 'ne-inspect-chip' + (value === n ? ' is-active' : ''),
            onClick: () => onChangeData({ [dataKey]: n }),
          },
          String(n),
        ),
      ),
      createElement('input', {
        type: 'number',
        className: 'ne-inspect-input ne-inspect-variants-custom',
        min: 1,
        max,
        step: 1,
        value,
        title: `1–${max} variants (over ${presets[presets.length - 1]} fires additional concurrent jobs)`,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          const clamped = Math.max(1, Math.min(max, Math.floor(n)));
          onChangeData({ [dataKey]: clamped });
        },
      }),
    ),
  );
}

/**
 * Model-aware duration control. Reads the current model's `duration` input
 * schema and renders either a select (Veo, Kling: enumerated durations) or a
 * number input (Seedance: 3–12 range). Applies the schema's default so the
 * field is never blank.
 */
function renderDurationControl(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
) {
  const modelId = String((node.data as Record<string, unknown>).modelId ?? '');
  const model = modelId ? getFalModel(modelId) : null;
  const durationInput: FalModelInput | undefined = model?.inputs.find((i) => i.key === 'duration');
  if (!durationInput) return null;
  const cur = (node.data as Record<string, unknown>).duration;

  // Validate the current value against the new model's schema. When you
  // switch from Veo ("8s", string) to Seedance (integer 3-12), the string
  // "8s" is defined but invalid for the number input, and Number("8s")
  // = NaN would render as blank. Same the other way around: a raw number
  // 5 isn't in Kling's enumerated options.
  const isValidForSchema = (() => {
    if (cur === undefined || cur === null || cur === '') return false;
    if (durationInput.type === 'select' && Array.isArray(durationInput.options)) {
      return durationInput.options.some((o) => String(o.value) === String(cur));
    }
    // number input
    const n = typeof cur === 'number' ? cur : parseFloat(String(cur).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n)) return false;
    if (durationInput.min !== undefined && n < durationInput.min) return false;
    if (durationInput.max !== undefined && n > durationInput.max) return false;
    return true;
  })();

  const value: unknown = isValidForSchema ? cur : durationInput.default;

  // Auto-apply the schema default whenever the current value doesn't
  // match this model's duration schema. Fires on mount and on model
  // switch. Ensures the field is never blank and the executor always
  // has a valid value to send.
  useEffect(() => {
    if (!isValidForSchema && durationInput.default !== undefined) {
      onChangeData({ duration: durationInput.default });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const label = durationInput.label ?? 'Duration (seconds)';

  if (durationInput.type === 'select' && Array.isArray(durationInput.options)) {
    return createElement(
      Fragment,
      null,
      createElement('label', { className: 'ne-inspect-label' }, label),
      createElement(
        'select',
        {
          className: 'ne-inspect-select',
          value: String(value ?? ''),
          onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
            onChangeData({ duration: e.target.value }),
        },
        ...durationInput.options.map((opt) =>
          createElement('option', { key: opt.value, value: opt.value }, opt.label),
        ),
      ),
    );
  }

  // Number range fallback. Keep the schema's min/max/step and enforce them.
  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, label),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'number',
      min: durationInput.min ?? 1,
      max: durationInput.max ?? 60,
      step: durationInput.step ?? 1,
      value: Number(value ?? 5),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Number(e.target.value);
        onChangeData({ duration: Number.isFinite(n) ? n : (durationInput.default ?? 5) });
      },
    }),
  );
}

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
  const rawModelId = String(node.data.modelId ?? 'nano-banana-pro');
  const modelId = resolveFalModelId(rawModelId) ?? rawModelId;
  const url = node.output?.dataUrl;
  const model = getFalModel(modelId);
  // Once a node has produced output, lock the model dropdown. Different
  // models have different input schemas (variants, resolution, duration,
  // etc.), so switching mid-flight silently strips the wrong keys or sends
  // stale ones. If the user really wants a different model, they can add
  // a new Image Gen node.
  const modelLocked = Boolean(url);

  // Auto-heal a stale/aliased modelId once the resolver has mapped it.
  useEffect(() => {
    if (rawModelId !== modelId) onChangeData({ modelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawModelId, modelId]);

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
    // Schema-driven aspect / image_size: pick whichever aspect-shaped input
    // this model actually uses (aspect_ratio, image_size, or neither). Falls
    // back to the hardcoded ASPECT_RATIOS list if the model has none.
    (() => {
      const aspectInput =
        model?.inputs.find((i) => i.type === 'aspect') ??
        model?.inputs.find((i) => i.key === 'image_size');
      if (aspectInput) return renderSchemaInput(node, onChangeData, aspectInput);
      // Fallback for models with no aspect input at all.
      return createElement(
        Fragment,
        null,
        createElement('label', { className: 'ne-inspect-label' }, 'Aspect Ratio'),
        createElement(
          'select',
          {
            className: 'ne-inspect-select',
            value: String(node.data.aspect_ratio ?? '16:9'),
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
              onChangeData({ aspect_ratio: e.target.value }),
          },
          ...ASPECT_RATIOS.map((a) => createElement('option', { key: a, value: a }, a)),
        ),
      );
    })(),
    // Variants (chips 1–4 + free-form input for arbitrary counts up to 20;
    // executor chunks into FAL num_images-4 batches when count > 4).
    renderVariantsControl(node, onChangeData, 'num_images', 20),
    // Ref inputs stepper. Only shown for models that support a variable
    // number of refs (maxRefInputs > 1 and no fixed refPorts). Fixed-port
    // models (Veo 3.1 FLF: first+last) render exactly their declared ports
    // and don't get a stepper.
    (() => {
      if (model?.refPorts && model.refPorts.length > 0) return null;
      const cap = Math.max(1, Math.min(9, model?.maxRefInputs ?? 1));
      if (cap <= 1) return null;
      const refCount = Math.max(1, Math.min(cap, Number(node.data.refCount ?? 1)));
      return createElement(
        Fragment,
        null,
        createElement('label', { className: 'ne-inspect-label' }, 'Ref inputs'),
        createElement(
          'div',
          { className: 'ne-inspect-chip-row' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'ne-inspect-chip',
              disabled: refCount <= 1,
              onClick: () => onChangeData({ refCount: Math.max(1, refCount - 1) }),
            },
            '\u2212 input',
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ne-inspect-chip',
              disabled: refCount >= cap,
              onClick: () => onChangeData({ refCount: Math.min(cap, refCount + 1) }),
            },
            '+ input',
          ),
          createElement(
            'span',
            { style: { fontSize: '11px', color: '#9a9aa2', alignSelf: 'center' } },
            `${refCount} / ${cap} ref${refCount === 1 ? '' : 's'}`,
          ),
        ),
      );
    })(),
    // Schema-driven extras: resolution, output_format, quality,
    // safety_tolerance, negative_prompt, system_prompt, generate_audio,
    // etc. Excludes keys already rendered by the fixed controls above.
    renderSchemaExtras(
      node,
      onChangeData,
      model,
      new Set([
        'prompt',        // wired from text-prompt or upstream concat
        'aspect_ratio',  // rendered by the aspect block above
        'image_size',    // " (GPT Image 2 / Flux 2)
        'num_images',    // Variants chip row
        'seed',          // renderSeedControl below
        // Ref-image keys are ports on the node, not fields.
        'image_url',
        'image_urls',
        'first_frame_url',
        'start_image_url',
      ]),
    ),
    // Random Seed control (schema-driven — only renders when the current
    // model has a `seed` input; every current image model does).
    (model?.inputs.some((i) => i.key === 'seed'))
      ? renderSeedControl(node, onChangeData)
      : null,
    // Generate — cost hint pulled from /api/fal/price for this endpoint.
    // Quantity is num_images (default 1, capped at the variants cap the
    // Inspector allows). The button falls back to plain "Generate" while
    // pricing loads or when the endpoint isn't priced by images.
    //
    // Nano Banana Pro (and any model with resolutionCostMultiplier) charges
    // more at higher resolutions; the fal /pricing endpoint only returns a
    // baseline. Look up the multiplier for the selected resolution and let
    // the estimator apply it.
    (() => {
      const resValue = String(node.data.resolution ?? '');
      const resMul = model?.resolutionCostMultiplier?.[resValue] ?? 1;
      return createElement(GenerateButtonWithCost, {
        endpointId: model?.endpoint ?? null,
        quantity: {
          images: Math.max(1, Math.min(20, Number(node.data.num_images ?? 1))),
          resolutionMultiplier: resMul,
        },
        disabled: inFlight,
        inFlight,
        busyLabel: 'Generating\u2026',
        onClick: () => onGenerate(),
      });
    })(),
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
  const rawModelId = String(node.data.modelId ?? 'veo-3');
  const modelId = resolveFalModelId(rawModelId) ?? rawModelId;
  const url = node.output?.dataUrl;
  const model = getFalModel(modelId);
  const modelLocked = Boolean(url);

  // Auto-heal a stale/aliased modelId (e.g. veo-3-fast → veo-3-1-fast).
  useEffect(() => {
    if (rawModelId !== modelId) onChangeData({ modelId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawModelId, modelId]);

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
    // Schema-driven aspect (each Veo variant restricts to different options;
    // Kling adds 1:1; Veo 3.1 FLF adds 'auto').
    (() => {
      const aspectInput = model?.inputs.find((i) => i.type === 'aspect');
      if (aspectInput) return renderSchemaInput(node, onChangeData, aspectInput);
      return createElement(
        Fragment,
        null,
        createElement('label', { className: 'ne-inspect-label' }, 'Aspect Ratio'),
        createElement(
          'select',
          {
            className: 'ne-inspect-select',
            value: String(node.data.aspect_ratio ?? '16:9'),
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
              onChangeData({ aspect_ratio: e.target.value }),
          },
          ...['16:9', '9:16', '1:1'].map((a) => createElement('option', { key: a, value: a }, a)),
        ),
      );
    })(),
    // Duration control is now model-schema-driven: Veo/Kling get a select of
    // valid enumerated durations, Seedance gets a clamped number field, and
    // the schema's default fires automatically so the field is never blank.
    renderDurationControl(node, onChangeData),
    // Ref inputs stepper for video models with variable ref counts
    // (Seedance 2 Reference: up to 9). Fixed-port models (Veo 3.1 FLF) get
    // one port per declaration and no stepper. Same shape as ImageGen.
    (() => {
      if (model?.refPorts && model.refPorts.length > 0) return null;
      const cap = Math.max(1, Math.min(9, model?.maxRefInputs ?? 1));
      if (cap <= 1) return null;
      const refCount = Math.max(1, Math.min(cap, Number(node.data.refCount ?? 1)));
      return createElement(
        Fragment,
        null,
        createElement('label', { className: 'ne-inspect-label' }, 'Ref inputs'),
        createElement(
          'div',
          { className: 'ne-inspect-chip-row' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'ne-inspect-chip',
              disabled: refCount <= 1,
              onClick: () => onChangeData({ refCount: Math.max(1, refCount - 1) }),
            },
            '\u2212 input',
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'ne-inspect-chip',
              disabled: refCount >= cap,
              onClick: () => onChangeData({ refCount: Math.min(cap, refCount + 1) }),
            },
            '+ input',
          ),
          createElement(
            'span',
            { style: { fontSize: '11px', color: '#9a9aa2', alignSelf: 'center' } },
            `${refCount} / ${cap} ref${refCount === 1 ? '' : 's'}`,
          ),
        ),
      );
    })(),
    // Variants: FAL video endpoints don't accept num_videos natively, so the
    // executor fires N parallel jobs of 1 each. Cap at 10 because each job
    // costs 1–5 min and $$$; 10 concurrent is already aggressive.
    renderVariantsControl(node, onChangeData, 'num_videos', 10),
    // Schema-driven extras: resolution, negative_prompt, generate_audio,
    // auto_fix, cfg_scale, safety_tolerance, last_frame_url, etc.
    // Excludes keys already rendered above (aspect, duration, ref-image ports).
    renderSchemaExtras(
      node,
      onChangeData,
      model,
      new Set([
        'prompt',
        'aspect_ratio',
        'duration',
        'seed',
        'image_url',
        'image_urls',
        'first_frame_url',
        'start_image_url',
      ]),
    ),
    // Random Seed control (video models with a `seed` input in their schema).
    (model?.inputs.some((i) => i.key === 'seed'))
      ? renderSeedControl(node, onChangeData)
      : null,
    // Generate — cost = unit_price × seconds × num_videos for per-second
    // pricing. Duration values vary by model: Veo uses "8s" (string with
    // 's' suffix), Kling uses "5" (numeric string), Seedance uses 5
    // (raw number). Parse robustly so the estimate is correct across all.
    // num_videos > 1 fires that many parallel jobs, each billed separately.
    (() => {
      const rawDuration = node.data.duration;
      const durationSecs =
        typeof rawDuration === 'number'
          ? rawDuration
          : typeof rawDuration === 'string'
            ? parseFloat(rawDuration.replace(/[^0-9.]/g, ''))
            : NaN;
      const variants = Math.max(1, Math.min(10, Math.floor(Number(node.data.num_videos ?? 1))));
      return createElement(GenerateButtonWithCost, {
        endpointId: model?.endpoint ?? null,
        quantity: {
          seconds: Number.isFinite(durationSecs) && durationSecs > 0 ? durationSecs : undefined,
          variants,
        },
        disabled: inFlight,
        inFlight,
        busyLabel: 'Generating\u2026 (video takes 1-5 min)',
        onClick: () => onGenerate(),
      });
    })(),
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

// Curated presets so the user can one-click a working config for common
// models. `slug` is the fal.ai endpoint, `imageKey` is where an upstream
// image goes (undefined = no image input), `starterJson` is a template.
const CUSTOM_FAL_PRESETS: Array<{
  label: string;
  slug: string;
  imageKey?: string;
  starterJson: string;
  note?: string;
}> = [
  {
    label: 'FLUX Pro 1.1 (text→image)',
    slug: 'fal-ai/flux-pro/v1.1',
    starterJson: '{\n  "image_size": "landscape_16_9",\n  "num_inference_steps": 28,\n  "guidance_scale": 3.5\n}',
  },
  {
    label: 'FLUX Kontext (edit)',
    slug: 'fal-ai/flux-kontext',
    imageKey: 'image_url',
    starterJson: '{\n  "guidance_scale": 3.5\n}',
    note: 'Wire an image to the image port.',
  },
  {
    label: 'Ideogram v3 (text→image)',
    slug: 'fal-ai/ideogram/v3',
    starterJson: '{\n  "aspect_ratio": "16:9",\n  "rendering_speed": "BALANCED"\n}',
  },
  {
    label: 'Recraft V3 (text→image)',
    slug: 'fal-ai/recraft-v3',
    starterJson: '{\n  "image_size": "landscape_16_9",\n  "style": "realistic_image"\n}',
  },
  {
    label: 'Kling 2.1 img→video',
    slug: 'fal-ai/kling-video/v2.1/master/image-to-video',
    imageKey: 'image_url',
    starterJson: '{\n  "duration": "5",\n  "aspect_ratio": "16:9"\n}',
    note: 'Wire an image to the image port.',
  },
  {
    label: 'Seedance Pro img→video',
    slug: 'fal-ai/bytedance/seedance/v1/pro/image-to-video',
    imageKey: 'image_url',
    starterJson: '{\n  "duration": 5,\n  "resolution": "720p"\n}',
    note: 'Wire an image to the image port.',
  },
  {
    label: 'Topaz Video Upscale',
    slug: 'fal-ai/topaz/upscale/video',
    imageKey: 'video_url',
    starterJson: '{\n  "upscale_factor": 2\n}',
    note: 'Wire a video to the image port.',
  },
];

const CustomFalInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const endpoint = String(node.data.endpoint ?? '');
  const inputJson = String(node.data.inputJson ?? '{}');
  const imageKey = String(node.data.imageKey ?? 'image_url');
  const out = node.output;
  const url = out?.dataUrl;

  // Validate JSON live so the user sees the error before they hit Generate.
  let jsonError: string | null = null;
  if (inputJson.trim() !== '') {
    try {
      const parsed = JSON.parse(inputJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        jsonError = 'Must be a JSON object (e.g. { "guidance_scale": 7.5 }).';
      }
    } catch (err) {
      jsonError = (err as Error).message;
    }
  }

  return createElement(
    'div',
    { className: 'ne-inspect-body' },

    // What this node is / how it works
    createElement(
      'div',
      {
        className: 'ne-inspect-note',
        style: {
          padding: '8px 10px',
          background: '#1a1a1f',
          border: '1px solid #2a2a30',
          borderRadius: '4px',
          fontSize: '11px',
          lineHeight: '1.5',
          color: '#c0c0c8',
          marginBottom: '10px',
        },
      },
      createElement('div', { style: { fontWeight: 600, marginBottom: '4px', color: '#e6e6ea' } }, '🧪 Custom FAL'),
      'Run any model on fal.ai from a graph. Pick a preset below or paste any slug from ',
      createElement(
        'a',
        { href: 'https://fal.ai/models', target: '_blank', rel: 'noreferrer', style: { color: '#7aa2f7' } },
        'fal.ai/models',
      ),
      '. Wire a Text Prompt into ',
      createElement('code', null, 'prompt'),
      ' and (optionally) an image/video into ',
      createElement('code', null, 'image'),
      '.',
    ),

    // Preset picker — one-click config for common models
    createElement('label', { className: 'ne-inspect-label' }, 'Preset'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
          const preset = CUSTOM_FAL_PRESETS.find((p) => p.slug === e.target.value);
          if (!preset) return;
          onChangeData({
            endpoint: preset.slug,
            inputJson: preset.starterJson,
            imageKey: preset.imageKey ?? 'image_url',
          });
        },
      },
      createElement('option', { value: '' }, '— pick a preset —'),
      ...CUSTOM_FAL_PRESETS.map((p) =>
        createElement('option', { key: p.slug, value: p.slug }, p.label),
      ),
    ),

    createElement('label', { className: 'ne-inspect-label' }, 'FAL endpoint'),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'text',
      value: endpoint,
      spellCheck: false,
      placeholder: 'fal-ai/flux-pro/v1.1',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onChangeData({ endpoint: e.target.value }),
    }),
    createElement(
      'div',
      { className: 'ne-inspect-note', style: { fontSize: '11px', marginTop: '4px' } },
      'The model’s slug on fal.ai. Example: on the fal.ai page for FLUX Pro 1.1 the URL is ',
      createElement('code', null, 'fal.ai/models/fal-ai/flux-pro/v1.1'),
      ' — you paste ',
      createElement('code', null, 'fal-ai/flux-pro/v1.1'),
      '.',
    ),

    createElement('label', { className: 'ne-inspect-label' }, 'Upstream image → key'),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'text',
      value: imageKey,
      spellCheck: false,
      placeholder: 'image_url',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        onChangeData({ imageKey: e.target.value }),
    }),
    createElement(
      'div',
      { className: 'ne-inspect-note', style: { fontSize: '11px', marginTop: '4px' } },
      'If you wire an image into the ',
      createElement('code', null, 'image'),
      ' port, that image is sent to FAL under this key. Leave as ',
      createElement('code', null, 'image_url'),
      ' for most models. Some need ',
      createElement('code', null, 'image_urls'),
      ' (array), ',
      createElement('code', null, 'first_frame_image'),
      ', or ',
      createElement('code', null, 'video_url'),
      '. Keys ending in “s” are sent as an array.',
    ),

    createElement('label', { className: 'ne-inspect-label' }, 'Extra input (JSON)'),
    createElement('textarea', {
      className: 'ne-inspect-textarea',
      value: inputJson,
      spellCheck: false,
      rows: 8,
      placeholder: '{\n  "guidance_scale": 7.5,\n  "num_inference_steps": 28\n}',
      style: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        lineHeight: '1.4',
      },
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChangeData({ inputJson: e.target.value }),
    }),
    jsonError
      ? createElement(
          'div',
          {
            className: 'ne-inspect-note',
            style: { color: '#f7768e', fontSize: '11px', marginTop: '4px' },
          },
          '⚠ ' + jsonError,
        )
      : createElement(
          'div',
          { className: 'ne-inspect-note', style: { fontSize: '11px', marginTop: '4px' } },
          'Every model on fal.ai has its own input schema (see the “API” tab on the model’s page). Anything you type here is merged into the payload; upstream ',
          createElement('code', null, 'prompt'),
          ' and image are added automatically unless overridden here.',
        ),

    createElement(GenerateButtonWithCost, {
      endpointId: endpoint.trim() || null,
      quantity: {},
      disabled: inFlight || !endpoint.trim() || Boolean(jsonError),
      inFlight,
      busyLabel: 'Running…',
      onClick: () => onGenerate(),
    }),

    url && out?.kind === 'image'
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('img', { src: url, alt: '', draggable: false }),
        )
      : url && out?.kind === 'video'
      ? createElement(
          'div',
          { className: 'ne-inspect-thumb' },
          createElement('video', { src: url, controls: true, style: { width: '100%' } }),
        )
      : out?.text
      ? createElement(
          'pre',
          {
            style: {
              margin: '8px 0 0 0',
              padding: '8px',
              fontSize: '11px',
              lineHeight: '1.4',
              color: '#c0c0c8',
              background: '#1a1a1f',
              border: '1px solid #2a2a30',
              borderRadius: '4px',
              maxHeight: '240px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            },
          },
          out.text,
        )
      : null,
  );
};

const PanelRefInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const { panels } = useContext(PanelRefContext);
  const panelId = String(node.data.panelId ?? '');
  const panelLabel = String(node.data.panelLabel ?? '');
  const imageDataUrl = String(node.data.imageDataUrl ?? '');

  // Group panels by storyboard, preserving the order they arrive in
  // (which matches Outliner order).
  const storyboards = useMemo(() => {
    const map = new Map<string, { id: string; label: string; panels: PanelRefOption[] }>();
    for (const p of panels) {
      let sb = map.get(p.storyboardId);
      if (!sb) {
        sb = { id: p.storyboardId, label: p.storyboardLabel, panels: [] };
        map.set(p.storyboardId, sb);
      }
      sb.panels.push(p);
    }
    return Array.from(map.values());
  }, [panels]);

  // Which storyboard tab is active. Default: the storyboard that owns the
  // currently-picked panel, else the first storyboard.
  const selectedPanel = panels.find((p) => p.id === panelId);
  const [activeSbId, setActiveSbId] = useState<string>(
    selectedPanel?.storyboardId ?? storyboards[0]?.id ?? '',
  );
  // If the graph is reopened with a picked panel, snap the tab to its storyboard.
  useEffect(() => {
    if (selectedPanel && selectedPanel.storyboardId !== activeSbId) {
      setActiveSbId(selectedPanel.storyboardId);
    }
    // Only follow selection changes, not tab clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPanel?.id]);
  // If storyboards list changes and current tab vanishes, jump to first.
  useEffect(() => {
    if (storyboards.length === 0) return;
    if (!storyboards.some((s) => s.id === activeSbId)) {
      setActiveSbId(storyboards[0].id);
    }
  }, [storyboards, activeSbId]);

  const activeSb = storyboards.find((s) => s.id === activeSbId) ?? storyboards[0];

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
          'div',
          { className: 'ne-panelref-picker' },
          // Storyboard tabs
          storyboards.length > 1
            ? createElement(
                'div',
                { className: 'ne-panelref-tabs' },
                ...storyboards.map((sb) =>
                  createElement(
                    'button',
                    {
                      key: sb.id,
                      type: 'button',
                      className:
                        'ne-panelref-tab' + (sb.id === activeSb?.id ? ' is-active' : ''),
                      onClick: () => setActiveSbId(sb.id),
                      title: sb.label,
                    },
                    sb.label,
                  ),
                ),
              )
            : null,
          // Grid — tiles adopt the storyboard's panel aspect ratio so
          // portrait panels don't get their heads cropped by square thumbs.
          activeSb
            ? (() => {
                const ar = activeSb.panels[0]?.aspectRatio ?? 1;
                // Portrait storyboards need narrower columns so tiles don't
                // become huge vertically; landscape can use wider columns.
                const minColPx = ar >= 1 ? 96 : Math.max(64, Math.round(96 * ar));
                return createElement(
                  'div',
                  {
                    className: 'ne-panelref-grid',
                    style: {
                      gridTemplateColumns: `repeat(auto-fill, minmax(${minColPx}px, 1fr))`,
                    },
                  },
                  ...activeSb.panels.map((p) => {
                    const isSel = p.id === panelId;
                    const hasImg = Boolean(p.imageDataUrl);
                    return createElement(
                      'button',
                      {
                        key: p.id,
                        type: 'button',
                        className:
                          'ne-panelref-tile' +
                          (isSel ? ' is-selected' : '') +
                          (hasImg ? '' : ' is-empty'),
                        style: { aspectRatio: `${p.aspectRatio}` },
                        onClick: () => {
                          onChangeData({
                            panelId: p.id,
                            panelLabel: p.label,
                            imageDataUrl: p.imageDataUrl ?? '',
                          });
                        },
                        title: p.label,
                      },
                      hasImg
                        ? createElement('img', {
                            src: p.imageDataUrl,
                            alt: '',
                            draggable: false,
                            className: 'ne-panelref-tile-img',
                          })
                        : createElement(
                            'div',
                            { className: 'ne-panelref-tile-empty' },
                            'no image',
                          ),
                      createElement(
                        'div',
                        { className: 'ne-panelref-tile-num' },
                        String(p.panelIndex),
                      ),
                    );
                  }),
                );
              })()
            : null,
        ),
    panelId && !imageDataUrl
      ? createElement(
          'div',
          { className: 'ne-inspect-note' },
          'This panel has no rendered image yet. Generate its image first, or pick a different panel.',
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
    defaultWidth: 260,
    defaultHeight: 220,
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
