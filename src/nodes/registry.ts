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
import { listLlmModels } from '../ai/client';
import type { LlmModelInfo } from '../ai/client';
import {
  listTextPromptPresets,
  saveTextPromptPreset,
  deleteTextPromptPreset,
  type TextPromptPreset,
} from '../ai/client';
import {
  PRESET_GROUPS,
  BUILT_IN_PRESETS,
  cloneBuiltInPreset,
  cloneFieldsFresh,
  concatFields,
  makeFieldId,
  normalizePresetOptions,
  type PromptField,
  type PresetGroupId,
} from './text-prompt-fields';

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

// ---------------------------------------------------------------------------
// Actor-ref lookup context. NodeEditor provides the list of actors culled
// from the project's "Actors" storyboard so the Text Prompt v2 Dialogue
// field can render a picker. Optional — undefined means "not in an app
// context" or no Actors storyboard exists yet.
// ---------------------------------------------------------------------------
export type ActorRefOption = {
  id: string;           // panel id from the Actors storyboard
  name: string;         // first field value (actor name)
  description?: string;
  thumbUrl?: string;    // panel image if present
};

export const ActorRefContext = createContext<{
  actors: ActorRefOption[];
}>({ actors: [] });

// ---------------------------------------------------------------------------
// Out-node target-panel context. The NodeEditor tells the Out node preview
// what real board panel it will land in (index, corner note, caption
// fields, project aspect + label styling) so the preview can render a
// pixel-accurate mini-board look. Optional — renders fall back to generic
// styling when absent.
// ---------------------------------------------------------------------------
export type OutPanelInfo = {
  panelIndex: number;        // 1-based within its storyboard
  panelNumberPrefix: string; // e.g. "PANEL " so header reads "PANEL 01"
  cornerNote: string;        // right-aligned corner text (e.g. "S01")
  cornerNotePrefix: string;
  fields: Array<{ id: string; label: string; value: string }>;
  panelAspectRatio: number;  // width / height
};

export const OutPanelContext = createContext<OutPanelInfo | null>(null);

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
  category: 'input' | 'gen' | 'edit' | 'utility' | 'output';
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
    /** True when multiple gen-capable nodes are selected. Per-node
     *  Generate button should be disabled and the batch "Generate all"
     *  in the top-bar handles the run. */
    multiGenSelected?: boolean;
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

// ---------------------------------------------------------------------------
// Header-label stamp — image-gen / movie-gen nodes.
//
// The node header on the canvas defaults to the kind's static label ("Image
// Gen", "Movie Gen"). Once the node has been generated at least once its
// model is locked (see modelLocked in the Inspector — same output-based
// gate). We piggy-back a `data.__headerLabel` field that NodeCanvas reads
// in preference to def.label so the header shows the friendly model name
// ("Nano Banana Pro", "Veo 3", etc.).
//
// Runs on every render but only dispatches when the stamp is missing or
// stale relative to the current modelId. Guarded on generatedAt so we only
// stamp AFTER the node has produced output (matches modelLocked gating).
// ---------------------------------------------------------------------------
function useHeaderLabelStamp(
  node: BaseNode,
  onChangeData: ((patch: Record<string, unknown>) => void) | undefined,
  modelId: string,
): void {
  useEffect(() => {
    if (!onChangeData) return;
    if (!node.output?.generatedAt) return;   // only stamp after first gen
    const desired = modelLabel(modelId);
    const current = (node.data as Record<string, unknown>).__headerLabel;
    if (current === desired) return;
    onChangeData({ __headerLabel: desired });
    // Depend on generatedAt + modelId so a model swap on an unlocked node
    // (before first gen) doesn't stamp anything; a re-gen with a different
    // model — which shouldn't happen since model is locked — would refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.output?.generatedAt, modelId, onChangeData]);
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
  const fields = (node.data as { fields?: PromptField[] }).fields;
  const structured = Array.isArray(fields) && fields.length > 0;

  // Structured mode: read-only concat preview. Users edit fields in the
  // Inspector — the node body just shows the resolved prompt so a glance
  // tells them what will actually go to the model.
  //
  // Matt's rule (2026-07-18): show the ENTIRE concatenated prompt. If the
  // text overflows the node's rendered height, the container scrolls;
  // resizing the node exposes more without a hard character cap.
  if (structured) {
    const composed = concatFields(fields, text).trim();
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--text' },
      composed
        ? createElement(
            'div',
            {
              className: 'ne-node-preview-text ne-node-preview-text--scroll',
              // Stop wheel events from bubbling to the canvas zoom handler so
              // users can scroll the preview instead of zooming the canvas.
              onWheel: (e: React.WheelEvent) => e.stopPropagation(),
            },
            composed,
          )
        : createElement(
            'div',
            { className: 'ne-node-preview-empty' },
            '(empty prompt — fill fields in Inspector)',
          ),
    );
  }

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
  useHeaderLabelStamp(node, onChangeData, model);
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
  useHeaderLabelStamp(node, onChangeData, model);
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

// Out node visualized as a mini storyboard page (Matt 2026-07-18):
// renders the SAME chrome the target board panel will render — monospace
// "PANEL NN" header, right-corner note (e.g. "S01"), the current upstream
// media dropped into a slot that matches the project's panel aspect ratio,
// and a caption strip listing every non-empty panel field. When the
// OutPanelContext isn't provided we fall back to generic numbering
// ("01" / "OUT") and a 16:9 slot.
const OutPreview: FC<PreviewProps> = ({ node, onRun, onPromoteFrame, onChangeData }) => {
  const url = node.output?.dataUrl;
  const kind = node.output?.kind;
  const history = readNodeHistory(node);
  const panelInfo = useContext(OutPanelContext);

  const numPrefix = (panelInfo?.panelNumberPrefix ?? '').trim();
  const numText = panelInfo
    ? `${numPrefix ? numPrefix.toUpperCase() + ' ' : ''}${String(panelInfo.panelIndex).padStart(2, '0')}`.trim()
    : '01';
  const cornerText = panelInfo
    ? (panelInfo.cornerNote?.trim() || `S${String(panelInfo.panelIndex).padStart(2, '0')}`)
    : 'OUT';
  const aspect = panelInfo?.panelAspectRatio && panelInfo.panelAspectRatio > 0
    ? panelInfo.panelAspectRatio
    : 16 / 9;
  const fieldsToShow = (panelInfo?.fields ?? []).filter((f) => (f.value ?? '').trim() !== '');

  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--out-page' + (url ? '' : ' is-empty') },
    createElement(
      'div',
      { className: 'ne-out-page-header' },
      createElement('span', { className: 'ne-out-page-num' }, numText),
      createElement('span', { className: 'ne-out-page-corner' }, cornerText),
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
    // Image frame with real project aspect ratio.
    createElement(
      'div',
      {
        className: 'ne-out-page-frame',
        style: { aspectRatio: `${aspect}` },
      },
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
      // Translucent storyboard-sheet overlay on top of the media so the Out
      // node visually reads as a storyboard panel. Sits inside the frame
      // with pointer-events disabled so it doesn't block clicks.
      createElement('img', {
        className: 'ne-out-page-overlay',
        src: '/overlays/boards-overlay.png',
        alt: '',
        draggable: false,
      }),
    ),
    // Caption strip: render each non-empty panel field as its own line.
    createElement(
      'div',
      { className: 'ne-out-page-caption' },
      panelInfo && fieldsToShow.length > 0
        ? fieldsToShow.map((f, i) =>
            createElement(
              'div',
              { key: f.id ?? i, className: 'ne-out-page-caption-line' },
              f.value.trim(),
            ),
          )
        : (url ? 'panel image \u2192 storyboard' : 'wire something to me'),
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

const NullNodePreview: FC<PreviewProps> = ({ node }) => {
  const label = String((node.data as Record<string, unknown>).label ?? 'Null');
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--null' },
    createElement('div', { className: 'ne-null-label' }, label),
  );
};

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
  // Rock-solid guard: if `value` is anything that would render blank
  // (undefined, null, NaN, "", or a string like "8s" that Number() rejects),
  // fall back to durationInput.default → min → 5 so the input always
  // displays a real number. This is defence-in-depth in case the effect
  // above hasn't fired yet on the very first render after model switch.
  const numericValue = (() => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const stripped = value.replace(/[^\d.\-]/g, '');
      const n = Number(stripped !== '' ? stripped : value);
      if (Number.isFinite(n)) return n;
    }
    if (typeof durationInput.default === 'number') return durationInput.default;
    if (typeof durationInput.min === 'number') return durationInput.min;
    return 5;
  })();
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
      value: numericValue,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Number(e.target.value);
        onChangeData({ duration: Number.isFinite(n) ? n : (durationInput.default ?? 5) });
      },
    }),
  );
}

const TextPromptInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const legacyText = String(node.data.text ?? '');
  const fields = ((node.data as { fields?: PromptField[] }).fields ?? []) as PromptField[];
  const structured = fields.length > 0;
  const presetName = String((node.data as { presetName?: unknown }).presetName ?? '');

  const { actors } = useContext(ActorRefContext);
  const [savedPresets, setSavedPresets] = useState<TextPromptPreset[]>(() => {
    try {
      const raw = localStorage.getItem('boardfish:text-prompt-presets:v1');
      if (!raw) return [];
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  });
  const [managingPresets, setManagingPresets] = useState(false);
  const [openMenuFieldId, setOpenMenuFieldId] = useState<string | null>(null);
  const [openAddMenu, setOpenAddMenu] = useState(false);
  const [openPresetSubmenu, setOpenPresetSubmenu] = useState(false);

  // Refresh preset list on mount. Falls back to cached localStorage if the
  // server call fails so power-users on an offline dev box aren't stuck.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await listTextPromptPresets();
        if (cancelled) return;
        setSavedPresets(r.presets ?? []);
        try {
          localStorage.setItem(
            'boardfish:text-prompt-presets:v1',
            JSON.stringify(r.presets ?? []),
          );
        } catch { /* quota errors ignored */ }
      } catch {
        // Fall back to whatever's in localStorage already.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setFields = (next: PromptField[]) => {
    onChangeData({ fields: next });
  };

  const applyPreset = (presetId: string) => {
    // Built-in first, then user-saved.
    let nextFields: PromptField[] | null = null;
    let nextName = '';
    const builtIn = BUILT_IN_PRESETS.find((b) => b.id === presetId);
    if (builtIn) {
      nextFields = cloneBuiltInPreset(builtIn.id);
      nextName = builtIn.name;
    } else {
      const saved = savedPresets.find((p) => p.id === presetId);
      if (saved) {
        nextFields = cloneFieldsFresh(saved.fields as PromptField[]);
        nextName = saved.name;
      }
    }
    if (!nextFields) return;
    const hasContent =
      structured && fields.some((f) =>
        f.kind !== 'section' && String((f as { value?: string }).value ?? '').trim() !== '',
      );
    if (hasContent) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm('Replace current fields with this preset? Existing values will be lost (legacy `text` is kept as a fallback).');
      if (!ok) return;
    }
    // If the current legacy text has content and the preset's first text
    // field is empty, move it into that field so nothing gets orphaned.
    if (legacyText.trim()) {
      const firstText = nextFields.find((f) => f.kind === 'text') as
        | Extract<PromptField, { kind: 'text' }>
        | undefined;
      if (firstText && !firstText.value.trim()) {
        firstText.value = legacyText;
      }
    }
    onChangeData({ fields: nextFields, presetName: nextName });
  };

  const clearPreset = () => {
    if (structured) {
      const hasContent = fields.some((f) =>
        f.kind !== 'section' && String((f as { value?: string }).value ?? '').trim() !== '',
      );
      if (hasContent) {
        // eslint-disable-next-line no-alert
        const ok = window.confirm('Discard structured fields and return to a single legacy textarea?');
        if (!ok) return;
      }
    }
    onChangeData({ fields: undefined, presetName: undefined });
  };

  const savePresetPrompt = async () => {
    if (!structured) return;
    // eslint-disable-next-line no-alert
    const name = window.prompt('Preset name:', presetName || 'My preset');
    if (!name || !name.trim()) return;
    try {
      const r = await saveTextPromptPreset(name.trim(), fields);
      const next = [...savedPresets, r.preset];
      setSavedPresets(next);
      try {
        localStorage.setItem('boardfish:text-prompt-presets:v1', JSON.stringify(next));
      } catch { /* ignore */ }
      onChangeData({ presetName: r.preset.name });
    } catch (e) {
      // Server unavailable — fall back to localStorage-only save.
      const localId = 'local_' + Math.random().toString(36).slice(2, 10);
      const preset = { id: localId, name: name.trim(), fields, createdAt: Date.now() };
      const next = [...savedPresets, preset];
      setSavedPresets(next);
      try {
        localStorage.setItem('boardfish:text-prompt-presets:v1', JSON.stringify(next));
      } catch { /* ignore */ }
      onChangeData({ presetName: preset.name });
      // eslint-disable-next-line no-alert
      window.alert(`Saved locally (server unavailable): ${String((e as Error)?.message || e)}`);
    }
  };

  const deleteSavedPreset = async (id: string) => {
    try {
      await deleteTextPromptPreset(id);
    } catch { /* ignore — still remove from local list */ }
    const next = savedPresets.filter((p) => p.id !== id);
    setSavedPresets(next);
    try {
      localStorage.setItem('boardfish:text-prompt-presets:v1', JSON.stringify(next));
    } catch { /* ignore */ }
  };

  const updateField = (id: string, patch: Partial<PromptField>) => {
    const next = fields.map((f) => (f.id === id ? ({ ...f, ...patch } as PromptField) : f));
    setFields(next);
  };

  const moveField = (id: string, delta: number) => {
    const idx = fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const j = idx + delta;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    const [f] = next.splice(idx, 1);
    next.splice(j, 0, f);
    setFields(next);
    setOpenMenuFieldId(null);
  };

  const deleteField = (id: string) => {
    setFields(fields.filter((f) => f.id !== id));
    setOpenMenuFieldId(null);
  };

  const addField = (kind: PromptField['kind'], presetGroup?: PresetGroupId) => {
    let f: PromptField;
    if (kind === 'section') {
      f = { id: makeFieldId(), kind: 'section', label: 'Section' };
    } else if (kind === 'dialogue') {
      f = { id: makeFieldId(), kind: 'dialogue', label: 'Dialogue', value: '', join: 'block' };
    } else if (kind === 'preset-text') {
      f = {
        id: makeFieldId(),
        kind: 'preset-text',
        label: presetGroup ? PRESET_GROUPS[presetGroup].label : 'Preset',
        value: '',
        presetGroup: presetGroup ?? 'shot-type',
        join: 'inline',
      };
    } else {
      f = { id: makeFieldId(), kind: 'text', label: 'Text', value: '', join: 'block' };
    }
    setFields([...fields, f]);
    setOpenAddMenu(false);
    setOpenPresetSubmenu(false);
  };

  const onExplode = () => {
    if (!structured) return;
    window.dispatchEvent(
      new CustomEvent('boardfish:explode-text-prompt', { detail: { nodeId: node.id } }),
    );
  };

  // ---------------- render ----------------

  const presetRow = createElement(
    'div',
    { className: 'tpv2-preset-row' },
    createElement('label', { className: 'ne-inspect-label', style: { margin: 0 } }, 'Preset'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
          const v = e.target.value;
          e.target.value = '';
          if (!v) return;
          if (v === '__clear__') { clearPreset(); return; }
          if (v === '__save__') { void savePresetPrompt(); return; }
          if (v === '__manage__') { setManagingPresets(true); return; }
          applyPreset(v);
        },
      },
      createElement(
        'option',
        { value: '' },
        structured
          ? `— ${presetName || 'Custom fields'} —`
          : '— Text Prompt (legacy) —',
      ),
      // Top-level: Text Prompt (legacy — clears structured fields) + any
      // non-example built-ins (currently just Multi Prompt).
      createElement('option', { key: '__clear__', value: '__clear__' }, 'Text Prompt (legacy single field)'),
      ...BUILT_IN_PRESETS.filter((b) => !b.example).map((b) =>
        createElement('option', { key: b.id, value: b.id }, b.name),
      ),
      // "User Saved Presets" — built-in examples first, then the user's own.
      (BUILT_IN_PRESETS.some((b) => b.example) || savedPresets.length > 0)
        ? createElement(
            'optgroup',
            { key: 'saved', label: 'User Saved Presets' },
            ...BUILT_IN_PRESETS.filter((b) => b.example).map((b) =>
              createElement('option', { key: b.id, value: b.id }, `${b.name} (example)`),
            ),
            ...savedPresets.map((p) =>
              createElement('option', { key: p.id, value: p.id }, p.name),
            ),
          )
        : null,
      createElement('option', { key: 'sep1', value: '', disabled: true }, '──────'),
      structured
        ? createElement('option', { key: 'save', value: '__save__' }, 'Save current as…')
        : null,
      savedPresets.length > 0
        ? createElement('option', { key: 'manage', value: '__manage__' }, 'Manage saved…')
        : null,
    ),
  );

  const manageDialog = managingPresets
    ? createElement(
        'div',
        {
          style: {
            padding: 8,
            marginBottom: 12,
            background: 'rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
          },
        },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          createElement(
            'span',
            { style: { fontWeight: 600, flex: 1 } },
            'Saved presets',
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'tpv2-field-menu-btn',
              onClick: () => setManagingPresets(false),
              title: 'Close',
            },
            '✕',
          ),
        ),
        savedPresets.length === 0
          ? createElement('div', { className: 'ne-inspect-note' }, 'No saved presets yet.')
          : createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              ...savedPresets.map((p) =>
                createElement(
                  'div',
                  {
                    key: p.id,
                    style: { display: 'flex', alignItems: 'center', gap: 8 },
                  },
                  createElement('span', { style: { flex: 1 } }, p.name),
                  createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'tpv2-field-menu-btn',
                      onClick: () => { void deleteSavedPreset(p.id); },
                      title: 'Delete',
                    },
                    '🗑',
                  ),
                ),
              ),
            ),
      )
    : null;

  // Legacy mode — render a single textarea. Preset picker still shown at top
  // so the user can promote to structured mode at any time.
  if (!structured) {
    return createElement(
      'div',
      { className: 'ne-inspect-body' },
      presetRow,
      manageDialog,
      createElement('label', { className: 'ne-inspect-label' }, 'Prompt'),
      createElement('textarea', {
        className: 'ne-inspect-textarea',
        rows: 8,
        value: legacyText,
        placeholder: 'Describe the shot…',
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChangeData({ text: e.target.value }),
      }),
    );
  }

  // Structured mode.
  const renderField = (f: PromptField) => {
    // Visible delete button — one click to remove any field. Complements the
    // ⋮ menu (which keeps Move Up / Move Down / Delete for keyboard/discovery).
    const deleteBtn = createElement(
      'button',
      {
        type: 'button',
        className: 'tpv2-field-delete-btn',
        title: 'Delete field',
        'aria-label': 'Delete field',
        onClick: () => deleteField(f.id),
      },
      '✕',
    );
    const menu = createElement(
      'div',
      { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 2 } },
      deleteBtn,
      createElement(
        'button',
        {
          type: 'button',
          className: 'tpv2-field-menu-btn',
          title: 'Field menu',
          onClick: () =>
            setOpenMenuFieldId((prev) => (prev === f.id ? null : f.id)),
        },
        '⋮',
      ),
      openMenuFieldId === f.id
        ? createElement(
            'div',
            {
              style: {
                position: 'absolute',
                right: 0,
                top: '100%',
                zIndex: 20,
                background: '#1a1a1f',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6,
                padding: 4,
                minWidth: 120,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              },
              onMouseLeave: () => setOpenMenuFieldId(null),
            },
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => moveField(f.id, -1),
              },
              '↑ Move up',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => moveField(f.id, 1),
              },
              '↓ Move down',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => deleteField(f.id),
              },
              '🗑 Delete',
            ),
          )
        : null,
    );

    if (f.kind === 'section') {
      return createElement(
        'div',
        { key: f.id, className: 'tpv2-field tpv2-field-section' },
        createElement(
          'div',
          { className: 'tpv2-field-header' },
          createElement('input', {
            className: 'tpv2-field-label-input',
            value: f.label,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              updateField(f.id, { label: e.target.value }),
          }),
          menu,
        ),
      );
    }

    const joinPill = createElement(
      'button',
      {
        type: 'button',
        className: 'tpv2-join-pill' + ((f as { join?: string }).join === 'block' ? ' is-block' : ''),
        title: 'Toggle inline / block join',
        onClick: () => {
          const current = (f as { join: 'inline' | 'block' }).join;
          updateField(f.id, { join: current === 'inline' ? 'block' : 'inline' } as Partial<PromptField>);
        },
      },
      (f as { join?: string }).join === 'block' ? 'block' : 'inline',
    );

    if (f.kind === 'text') {
      return createElement(
        'div',
        { key: f.id, className: 'tpv2-field' },
        createElement(
          'div',
          { className: 'tpv2-field-header' },
          createElement('input', {
            className: 'tpv2-field-label-input',
            value: f.label,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              updateField(f.id, { label: e.target.value }),
          }),
          joinPill,
          menu,
        ),
        createElement('textarea', {
          className: 'ne-inspect-textarea',
          rows: 3,
          value: f.value,
          placeholder: f.label,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateField(f.id, { value: e.target.value } as Partial<PromptField>),
        }),
      );
    }

    if (f.kind === 'preset-text') {
      const rawOpts = PRESET_GROUPS[f.presetGroup]?.options ?? [];
      const opts = normalizePresetOptions(rawOpts);
      // Reverse lookup: does the current value match a normalized option?
      // If yes, show that option as selected in the dropdown even after the
      // full prompt has been written into the textarea (so the user can
      // still see which preset they picked).
      const matchedIdx = opts.findIndex((o) => !o.heading && o.value === f.value);
      const rows = f.value && f.value.length > 80 ? 6 : 3;
      return createElement(
        'div',
        { key: f.id, className: 'tpv2-field' },
        createElement(
          'div',
          { className: 'tpv2-field-header' },
          createElement('input', {
            className: 'tpv2-field-label-input',
            value: f.label,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
              updateField(f.id, { label: e.target.value }),
          }),
          joinPill,
          menu,
        ),
        createElement(
          'select',
          {
            className: 'ne-inspect-select tpv2-preset-picker',
            value: matchedIdx >= 0 ? String(matchedIdx) : '',
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              const raw = e.target.value;
              if (!raw) return;
              const idx = Number(raw);
              const picked = opts[idx];
              if (!picked || picked.heading) return;
              updateField(f.id, { value: picked.value } as Partial<PromptField>);
            },
          },
          createElement('option', { value: '' }, '— pick one —'),
          ...opts.map((o, i) =>
            o.heading
              ? createElement(
                  'option',
                  { key: `h-${i}`, value: '', disabled: true, className: 'tpv2-preset-heading' },
                  `─ ${o.label} ─`,
                )
              : createElement('option', { key: `o-${i}`, value: String(i) }, o.label),
          ),
        ),
        createElement('textarea', {
          className: 'ne-inspect-textarea',
          rows,
          value: f.value,
          placeholder: `Free text (or pick from ${PRESET_GROUPS[f.presetGroup]?.label ?? 'preset'})`,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateField(f.id, { value: e.target.value } as Partial<PromptField>),
        }),
      );
    }

    // dialogue
    const actorId = f.actorId ?? '';
    return createElement(
      'div',
      { key: f.id, className: 'tpv2-field' },
      createElement(
        'div',
        { className: 'tpv2-field-header' },
        createElement('input', {
          className: 'tpv2-field-label-input',
          value: f.label,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            updateField(f.id, { label: e.target.value }),
        }),
        menu,
      ),
      createElement('textarea', {
        className: 'ne-inspect-textarea',
        rows: 2,
        value: f.value,
        placeholder: 'What does the actor say?',
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          updateField(f.id, { value: e.target.value } as Partial<PromptField>),
      }),
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } },
        createElement('label', { className: 'ne-inspect-label', style: { margin: 0 } }, 'Actor'),
        createElement('input', {
          className: 'ne-inspect-input',
          style: { flex: 1 },
          value: f.actorName ?? '',
          placeholder: 'Manual actor name (or pick below)',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            updateField(f.id, { actorName: e.target.value, actorId: '' } as Partial<PromptField>),
        }),
      ),
      actors.length === 0
        ? createElement(
            'div',
            { className: 'ne-inspect-note', style: { marginTop: 4 } },
            'No actors in project — you can still enter dialogue without an actor.',
          )
        : createElement(
            'div',
            { className: 'tpv2-actor-grid' },
            ...actors.map((a) =>
              createElement(
                'button',
                {
                  key: a.id,
                  type: 'button',
                  className: 'tpv2-actor-tile' + (a.id === actorId ? ' is-selected' : ''),
                  onClick: () =>
                    updateField(f.id, {
                      actorId: a.id,
                      actorName: a.name,
                    } as Partial<PromptField>),
                  title: a.name,
                },
                a.thumbUrl
                  ? createElement('img', { src: a.thumbUrl, alt: a.name, draggable: false })
                  : null,
                createElement('div', { className: 'tpv2-actor-tile-name' }, a.name),
              ),
            ),
          ),
    );
  };

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    presetRow,
    manageDialog,
    ...fields.map(renderField),
    createElement(
      'div',
      { style: { position: 'relative' } },
      createElement(
        'button',
        {
          type: 'button',
          className: 'tpv2-add-btn',
          onClick: () => {
            setOpenAddMenu((v) => !v);
            setOpenPresetSubmenu(false);
          },
        },
        '+ Add field ▾',
      ),
      openAddMenu
        ? createElement(
            'div',
            {
              style: {
                position: 'absolute',
                left: 0,
                right: 0,
                top: '100%',
                zIndex: 20,
                background: '#1a1a1f',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6,
                padding: 4,
                marginTop: 4,
                boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              },
              onMouseLeave: () => { setOpenAddMenu(false); setOpenPresetSubmenu(false); },
            },
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => addField('text'),
              },
              'Text field',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => setOpenPresetSubmenu((v) => !v),
              },
              'Preset field ▸',
            ),
            openPresetSubmenu
              ? createElement(
                  'div',
                  { style: { paddingLeft: 12 } },
                  ...(Object.keys(PRESET_GROUPS) as PresetGroupId[]).map((g) =>
                    createElement(
                      'button',
                      {
                        key: g,
                        type: 'button',
                        className: 'tpv2-field-menu-btn',
                        style: { display: 'block', width: '100%', textAlign: 'left', padding: '3px 8px' },
                        onClick: () => addField('preset-text', g),
                      },
                      PRESET_GROUPS[g].label,
                    ),
                  ),
                )
              : null,
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => addField('dialogue'),
              },
              'Dialogue field',
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'tpv2-field-menu-btn',
                style: { display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px' },
                onClick: () => addField('section'),
              },
              'Section header',
            ),
          )
        : null,
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'tpv2-explode-btn',
        onClick: onExplode,
        title: 'Break this Text Prompt into one node per non-empty field, connected to a Prompt Concat.',
      },
      '⚡ Explode to Nodes',
    ),
  );
};

const ImageGenInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight, multiGenSelected }) => {
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
        disabled: inFlight || !!multiGenSelected,
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

const MovieGenInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight, multiGenSelected }) => {
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
      // Same resolution scaling for video (Seedance uses pricingOverride).
      const resValue = String(node.data.resolution ?? '');
      const resMul = model?.pricingOverride?.resolutionMultiplier?.[resValue]
        ?? model?.resolutionCostMultiplier?.[resValue]
        ?? 1;
      return createElement(GenerateButtonWithCost, {
        endpointId: model?.endpoint ?? null,
        quantity: {
          seconds: Number.isFinite(durationSecs) && durationSecs > 0 ? durationSecs : undefined,
          variants,
          resolutionMultiplier: resMul,
        },
        disabled: inFlight || !!multiGenSelected,
        inFlight,
        busyLabel: 'Generating\u2026 (video takes 1-5 min)',
        onClick: () => onGenerate(),
        // Video is expensive. Confirm when variants > 1 so a single click
        // doesn't fire N parallel jobs and rack up N× cost (e.g. Veo 3
        // @ $0.75/s × 8s × 4 variants = $24).
        confirmVariants: true,
        itemLabel: 'video',
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

const NullNodeInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const label = String((node.data as Record<string, unknown>).label ?? 'Null');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement('label', { className: 'ne-inspect-label' }, 'Label'),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'text',
      value: label,
      maxLength: 24,
      placeholder: 'Null',
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        // Empty string → clear the override so the label falls back to "Null".
        onChangeData({ label: v === '' ? undefined : v });
      },
    }),
    createElement(
      'div',
      { className: 'ne-inspect-note', style: { marginTop: '10px' } },
      'Passthrough \u2014 forwards its single input unchanged. Handy for organizing long chains. The label shows in the center of the circle.',
    ),
  );
};

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

  // Zoom slider for the thumbnail grid. 0 = default multi-column view (auto-fill
  // with a small minmax), 1 = single-column 1×N with the biggest possible tiles.
  // Values in between smoothly enlarge the column min-width. Kept as inspector-
  // local state (not persisted on the node) since it's a view preference.
  const [gridZoom, setGridZoom] = useState<number>(0);

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
          // Zoom slider row — sits between the tabs and the grid.
          activeSb && activeSb.panels.length > 1
            ? createElement(
                'div',
                { className: 'ne-panelref-zoom' },
                createElement('span', { className: 'ne-panelref-zoom-label' }, 'Grid size'),
                createElement('input', {
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: Math.round(gridZoom * 100),
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                    setGridZoom(Number(e.target.value) / 100),
                  className: 'ne-panelref-zoom-slider',
                  title: 'Drag right for bigger tiles. Max = 1×N single column.',
                }),
              )
            : null,
          activeSb
            ? (() => {
                const ar = activeSb.panels[0]?.aspectRatio ?? 1;
                // Portrait storyboards need narrower columns so tiles don't
                // become huge vertically; landscape can use wider columns.
                const baseMinCol = ar >= 1 ? 96 : Math.max(64, Math.round(96 * ar));
                // Inspector drawer is 340px wide with ~16px horizontal padding
                // in .ne-inspector-scroll + 4px of grid padding/gap accounting.
                // Aim for a min-col near the usable width when zoomed all the
                // way in — that forces `auto-fill` to lay out a single column.
                const maxMinCol = 320;
                const minColPx = Math.round(baseMinCol + (maxMinCol - baseMinCol) * gridZoom);
                // When zoomed, drop the fixed max-height so big tiles are usable
                // (the inspector's own scroll container handles overflow).
                const isZoomed = gridZoom > 0.05;
                return createElement(
                  'div',
                  {
                    className: 'ne-panelref-grid' + (isZoomed ? ' is-zoomed' : ''),
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
// LLM node previews + inspectors (Boardfish 6)
//
// Prompt Enhancer, Run Any LLM, Image Describer, Video Describer all share
// the same skeleton: a model dropdown (populated from
// `openclaw capability model list`), an instructions textarea, and a read-
// only preview of the produced text (for the LLM-producing ones) or a media
// thumb (for describers).
// ---------------------------------------------------------------------------

// Module-scoped caches per filter kind so we hit /api/llm/models at most
// once per (session, filter). Different pickers need different subsets:
//   - text-only    — Prompt Enhancer / Run Any LLM
//   - vision-only  — Image / Video Describer
// Every LLM-backed inspector calls useLlmModels(kind), so caching per kind
// avoids duplicate fetches when multiple inspectors are mounted.
type LoadedModels = { models: LlmModelInfo[]; defaultModelId: string };
type LlmFilter = 'text-only' | 'vision-only';

const _llmCache: Record<LlmFilter, LoadedModels | null> = {
  'text-only': null,
  'vision-only': null,
};
const _llmPromise: Record<LlmFilter, Promise<LoadedModels | null> | null> = {
  'text-only': null,
  'vision-only': null,
};

function loadLlmModels(filter: LlmFilter) {
  if (_llmCache[filter]) return Promise.resolve(_llmCache[filter]);
  if (_llmPromise[filter]) return _llmPromise[filter]!;
  _llmPromise[filter] = listLlmModels(filter).then((res) => {
    if (!res) return null;
    const val: LoadedModels = { models: res.models, defaultModelId: res.defaultModelId };
    _llmCache[filter] = val;
    return val;
  }).catch(() => null);
  return _llmPromise[filter]!;
}

type LlmModelsHookResult = {
  models: LlmModelInfo[];
  defaultModelId: string;
  loading: boolean;
};

function useLlmModels(filter?: 'vision-only'): LlmModelsHookResult {
  // The picker previously accepted only `'vision-only' | undefined`;
  // omitted meant "text". Preserve that call-site contract.
  const kind: LlmFilter = filter === 'vision-only' ? 'vision-only' : 'text-only';
  const [state, setState] = useState<LlmModelsHookResult>(() => {
    const cached = _llmCache[kind];
    if (cached) {
      return {
        models: cached.models,
        defaultModelId: cached.defaultModelId,
        loading: false,
      };
    }
    return { models: [], defaultModelId: '', loading: true };
  });
  useEffect(() => {
    let cancelled = false;
    loadLlmModels(kind).then((res) => {
      if (cancelled) return;
      if (!res) {
        setState({ models: [], defaultModelId: '', loading: false });
        return;
      }
      setState({
        models: res.models,
        defaultModelId: res.defaultModelId,
        loading: false,
      });
    });
    return () => { cancelled = true; };
  }, [kind]);
  return state;
}

/**
 * Render the shared LLM-model + instructions form used by all four LLM
 * nodes. `vision` restricts the dropdown to vision-capable models (used
 * by Image / Video Describer and by Run Any LLM when an image is wired).
 *
 * Named `useLlmModelPickerFields` (not `render...`) so react-hooks lint
 * sees a legitimate hook — it does call useLlmModels()/useState()/etc.
 * It returns JSX rather than a value, which is unusual but fine.
 */
function useLlmModelPickerFields(
  node: BaseNode,
  onChangeData: (patch: Record<string, unknown>) => void,
  opts: { vision?: boolean; instructionsLabel: string; instructionsHelp?: string; instructionsRows?: number },
) {
  const filter: 'vision-only' | undefined = opts.vision ? 'vision-only' : undefined;
  const { models, defaultModelId, loading } = useLlmModels(filter);
  const selectedRaw = String(node.data.modelId ?? '');
  const selected = selectedRaw || defaultModelId;
  const instructions = String(node.data.instructions ?? '');

  // Group by provider so the dropdown is scannable when the catalog has
  // dozens of models (Anthropic + OpenAI + Google + FAL + Codex etc.).
  const byProvider = new Map<string, LlmModelInfo[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, 'Model'),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value: selected,
        disabled: loading && models.length === 0,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChangeData({ modelId: e.target.value }),
      },
      // "Default" option so the user can defer to the server's LLM_DEFAULT_MODEL.
      createElement('option', { value: '' }, defaultModelId
        ? `✨ Server default (${defaultModelId})`
        : '✨ Server default'),
      ...Array.from(byProvider.entries()).map(([provider, list]) =>
        createElement(
          'optgroup',
          { key: provider, label: provider },
          ...list.map((m) => createElement('option', { key: m.id, value: m.id },
            m.name + (m.input && m.input.includes('image') ? ' 👁️' : ''),
          )),
        ),
      ),
    ),
    loading && models.length === 0
      ? createElement('div', { className: 'ne-inspect-note' }, 'Loading models…')
      : (models.length === 0
          ? createElement('div', { className: 'ne-inspect-note' }, 'No models available. Check ai-proxy /api/llm/models.')
          : null),
    createElement('label', { className: 'ne-inspect-label' }, opts.instructionsLabel),
    createElement('textarea', {
      className: 'ne-inspect-textarea',
      rows: opts.instructionsRows ?? 6,
      value: instructions,
      placeholder: opts.instructionsHelp,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChangeData({ instructions: e.target.value }),
    }),
    opts.instructionsHelp
      ? createElement('div', { className: 'ne-inspect-note', style: { fontSize: '11px' } }, opts.instructionsHelp)
      : null,
  );
}

// ---- Text-output preview (used by all four LLM nodes) ----
const LlmTextOutputPreview: FC<PreviewProps> = ({ node }) => {
  const text = node.output?.text ?? '';
  const runtime = (node.data.__runtime ?? {}) as { error?: unknown };
  const err = typeof runtime.error === 'string' ? runtime.error : '';
  const modelId = String(node.data.modelId ?? '');
  const caption = modelId || 'server default';
  if (err) {
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--text is-readonly' },
      createElement('textarea', {
        className: 'ne-node-inline-textarea ne-node-inline-textarea--readonly',
        value: err,
        readOnly: true,
        spellCheck: false,
        style: { color: '#ff8f88' },
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onWheel: (e: React.WheelEvent) => e.stopPropagation(),
      }),
      createElement('div', { className: 'ne-node-preview-caption' }, `⚠️ ${caption}`),
    );
  }
  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--text is-readonly' },
    createElement('textarea', {
      className: 'ne-node-inline-textarea ne-node-inline-textarea--readonly',
      value: text,
      placeholder: 'run the graph to fill this in…',
      readOnly: true,
      spellCheck: false,
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
      onWheel: (e: React.WheelEvent) => e.stopPropagation(),
    }),
    createElement('div', { className: 'ne-node-preview-caption' }, caption),
  );
};

const PromptEnhancerPreview = LlmTextOutputPreview;
const LlmRunPreview = LlmTextOutputPreview;
const ImageDescriberPreview = LlmTextOutputPreview;
const VideoDescriberPreview = LlmTextOutputPreview;

// ---- Inspectors ----
const PromptEnhancerInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Rewrites the wired-in prompt using the chosen LLM and your instructions. Output is plain text — wire it into Image Gen, Movie Gen, or another LLM.',
    ),
    useLlmModelPickerFields(node, onChangeData, {
      instructionsLabel: 'Enhancement instructions',
      instructionsHelp: 'How should the LLM refine the prompt? (system-style guidance)',
      instructionsRows: 8,
    }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Enhancing…' : 'Enhance',
    ),
  );
};

const LlmRunInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Send the upstream prompt (and optional image) to any LLM. Output is plain text.',
    ),
    useLlmModelPickerFields(node, onChangeData, {
      instructionsLabel: 'System / instructions (optional)',
      instructionsHelp: 'Leave blank to send the upstream prompt verbatim.',
      instructionsRows: 6,
    }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Running…' : 'Run',
    ),
  );
};

const ImageDescriberInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Wire an image into this node. The chosen vision LLM analyzes it and returns a text prompt you can pipe into Image Gen or Movie Gen.',
    ),
    useLlmModelPickerFields(node, onChangeData, {
      vision: true,
      instructionsLabel: 'Image instructions',
      instructionsHelp: 'How should the LLM describe the image? Return format, focus areas, style tags…',
      instructionsRows: 8,
    }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Describing…' : 'Describe Image',
    ),
  );
};

const VideoDescriberInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Wire a video into this node. The vision LLM analyzes it and returns a text prompt. Not all models support video — Gemini 2.5 Pro / Flash are the safe picks. NOTE: model instructions are currently NOT honored by the OpenClaw CLI’s `capability video describe`; the field is captured for a future upgrade but has no effect today.',
    ),
    useLlmModelPickerFields(node, onChangeData, {
      vision: true,
      instructionsLabel: 'Model instructions (not yet wired — saved for later)',
      instructionsHelp: 'How should the LLM describe the video? Return format, focus areas, style tags…',
      instructionsRows: 8,
    }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Describing… (may take 1–2 min)' : 'Describe Video',
    ),
  );
};

// ---------------------------------------------------------------------------
// Editing Tools — Crop / Resize / Blur / Invert / Extract Video Frame
// ---------------------------------------------------------------------------
// All 5 are deterministic transforms server-side (ffmpeg + Pillow). They
// live in the palette's new 'edit' category. None cost money, so they're
// added to CHEAP_KINDS in dag-executor.ts — they always auto-run as
// ancestors/descendants of a Generate click.
//
// Model:
//   - Preview: shows the last output image/video thumb, or a placeholder.
//   - Inspector: kind-specific parameter controls + a Generate button that
//     kicks the transform. Cheap enough that we could re-run on every
//     data change, but explicit Generate matches the rest of the editor
//     UX and keeps latency predictable.
// ---------------------------------------------------------------------------

// Helper: find the upstream media (image or video) wired into a node's 'in'
// port. Prefers the node's own output (post-Generate), then walks the graph
// to the source. Returns the raw data URL + kind, or null when nothing is
// wired / nothing has generated yet.
function findUpstreamMedia(
  node: BaseNode,
  graph: import('./types').NodeGraph | undefined,
): { dataUrl: string; kind: 'image' | 'video' } | null {
  if (!graph) return null;
  const inEdge = graph.edges.find((e) => e.to.nodeId === node.id && e.to.portId === 'in');
  if (!inEdge) return null;
  const upstream = graph.nodes.find((n) => n.id === inEdge.from.nodeId);
  if (!upstream) return null;
  const out = upstream.output;
  if (out && (out.kind === 'image' || out.kind === 'video') && out.dataUrl) {
    return { dataUrl: out.dataUrl, kind: out.kind };
  }
  // Panel Ref stashes its image on data.imageDataUrl.
  const dataUrl = (upstream.data as { imageDataUrl?: unknown }).imageDataUrl;
  if (typeof dataUrl === 'string' && dataUrl) {
    return { dataUrl, kind: 'image' };
  }
  return null;
}

// Compute the fitted crop rectangle (percent-of-source, 0–1 scale) for a
// given aspect ratio + zoom + manual offset. Used by CropPreview to overlay
// the crop box AND by the server to compute the ffmpeg crop args.
function cropRectPct(
  srcW: number,
  srcH: number,
  aspect: string,
  zoom: number,
  offsetX: number,
  offsetY: number,
): { xPct: number; yPct: number; wPct: number; hPct: number } {
  const clampedZoom = Math.max(0.2, Math.min(1, zoom));
  let cropW: number; let cropH: number;
  if (aspect === 'custom') {
    cropW = srcW * clampedZoom;
    cropH = srcH * clampedZoom;
  } else {
    const m = String(aspect).match(/^(\d+):(\d+)$/);
    if (!m) {
      cropW = srcW * clampedZoom;
      cropH = srcH * clampedZoom;
    } else {
      const aw = Number(m[1]); const ah = Number(m[2]);
      const dstAR = aw / ah;
      const srcAR = srcW / srcH;
      let fitW: number; let fitH: number;
      if (srcAR > dstAR) {
        fitH = srcH;
        fitW = fitH * dstAR;
      } else {
        fitW = srcW;
        fitH = fitW / dstAR;
      }
      cropW = fitW * clampedZoom;
      cropH = fitH * clampedZoom;
    }
  }
  // Center-based positioning, then offset in units of the free travel
  // range (srcW - cropW) / 2 on each axis. offsetX = -1 pins left,
  // +1 pins right, 0 = centered.
  const freeX = srcW - cropW;
  const freeY = srcH - cropH;
  const ox = Math.max(-1, Math.min(1, offsetX || 0));
  const oy = Math.max(-1, Math.min(1, offsetY || 0));
  let x = (freeX / 2) + (ox * freeX / 2);
  let y = (freeY / 2) + (oy * freeY / 2);
  // Clamp to stay inside source.
  x = Math.max(0, Math.min(freeX, x));
  y = Math.max(0, Math.min(freeY, y));
  return {
    xPct: x / srcW,
    yPct: y / srcH,
    wPct: cropW / srcW,
    hPct: cropH / srcH,
  };
}

// Interactive Crop preview — shows the upstream image with a translucent
// overlay marking the crop rectangle. Drag the rectangle to reposition;
// zoom slider controls size. Deferred generate: hitting Apply bakes.
const CropPreview: FC<PreviewProps> = ({ node, onChangeData, graph }) => {
  const upstream = findUpstreamMedia(node, graph);
  const sourceUrl = upstream?.dataUrl ?? node.output?.dataUrl;
  const sourceKind = upstream?.kind ?? node.output?.kind ?? 'image';
  const zoom = Math.max(0.2, Math.min(1, Number(node.data.zoom ?? 1)));
  const aspect = String(node.data.aspect ?? '16:9');
  const offsetX = Math.max(-1, Math.min(1, Number(node.data.offsetX ?? 0)));
  const offsetY = Math.max(-1, Math.min(1, Number(node.data.offsetY ?? 0)));

  if (!sourceUrl) {
    return createElement(
      'div',
      { className: 'ne-node-preview-empty' },
      'wire an image or video in',
    );
  }

  const mediaEl =
    sourceKind === 'video'
      ? createElement('video', {
          src: sourceUrl,
          muted: true,
          playsInline: true,
          preload: 'metadata',
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#111',
            pointerEvents: 'none',
          },
        })
      : createElement('img', {
          src: sourceUrl,
          draggable: false,
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#111',
            pointerEvents: 'none',
          },
        });

  // For the visual overlay, treat the container as the source rect. We
  // don't know actual source pixel dims without loading, but for a
  // preview the aspect math against a "unit" source works fine — the
  // server does exact math at Generate time.
  const rect = cropRectPct(1000, 1000 * (aspect === 'custom' ? 1 : (() => {
    const m = String(aspect).match(/^(\d+):(\d+)$/);
    if (!m) return 1;
    return Number(m[2]) / Number(m[1]);
  })()), aspect, zoom, offsetX, offsetY);

  // Drag state persists across renders via useRef. Pointer capture keeps
  // release events firing even if the pointer leaves the container.
  const dragRef = useRef<{
    el: HTMLDivElement | null;
    startX: number; startY: number;
    startOffsetX: number; startOffsetY: number;
    wPct: number; hPct: number;
    dragging: boolean;
  }>({
    el: null, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0,
    wPct: 1, hPct: 1, dragging: false,
  });
  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    dragRef.current = {
      el,
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
      wPct: rect.wPct,
      hPct: rect.hPct,
      dragging: true,
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st.dragging || !st.el) return;
    e.stopPropagation();
    const bbox = st.el.getBoundingClientRect();
    // Full travel range on each axis = (1 - wPct) or (1 - hPct) of the
    // container. Offset ranges -1..1 across that travel; 1 unit of offset
    // corresponds to (travelPx / 2) pixels.
    const travelPxX = Math.max(1, (1 - st.wPct) * bbox.width);
    const travelPxY = Math.max(1, (1 - st.hPct) * bbox.height);
    const dx = (e.clientX - st.startX) / (travelPxX / 2);
    const dy = (e.clientY - st.startY) / (travelPxY / 2);
    const nx = Math.max(-1, Math.min(1, st.startOffsetX + dx));
    const ny = Math.max(-1, Math.min(1, st.startOffsetY + dy));
    onChangeData?.({ offsetX: nx, offsetY: ny });
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st.dragging) return;
    e.stopPropagation();
    try {
      if (st.el) st.el.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    dragRef.current = { ...st, el: null, dragging: false };
  };

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${rect.xPct * 100}%`,
    top: `${rect.yPct * 100}%`,
    width: `${rect.wPct * 100}%`,
    height: `${rect.hPct * 100}%`,
    border: '2px solid #4ecdc4',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
    boxSizing: 'border-box',
    pointerEvents: 'none', // dragging is on the container, not this box
    cursor: 'move',
  };

  const captionCrop = aspect === 'custom'
    ? `custom · zoom ${Math.round(zoom * 100)}% · drag to move`
    : `${aspect} · zoom ${Math.round(zoom * 100)}% · drag to move`;

  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--edit', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    createElement(
      'div',
      {
        style: {
          position: 'relative',
          flex: 1, minHeight: 0, overflow: 'hidden',
          borderRadius: 4,
          cursor: 'move',
          touchAction: 'none',
        },
        onPointerDown: beginDrag,
        onPointerMove: dragMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      },
      mediaEl,
      createElement('div', { style: overlayStyle }),
    ),
    createElement('input', {
      type: 'range',
      min: 20, max: 100, step: 1,
      value: String(Math.round(zoom * 100)),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = Number(e.target.value) / 100;
        onChangeData?.({ zoom: v });
      },
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      style: { width: '100%' },
      title: 'Crop zoom',
    }),
    createElement('div', { className: 'ne-node-preview-caption', style: { fontSize: 10 } }, captionCrop),
  );
};

// Interactive Resize preview — shows the upstream image scaled inside the
// node body per the scale slider. When scale < 1 the smaller image can be
// dragged around within the node canvas; that position is baked into the
// output at Generate time (server pads the canvas back to source size).
const ResizePreview: FC<PreviewProps> = ({ node, onChangeData, graph }) => {
  const upstream = findUpstreamMedia(node, graph);
  const sourceUrl = upstream?.dataUrl ?? node.output?.dataUrl;
  const sourceKind = upstream?.kind ?? node.output?.kind ?? 'image';
  const scale = Math.max(0.25, Math.min(2, Number(node.data.scale ?? 1)));
  const offsetX = Math.max(-1, Math.min(1, Number(node.data.offsetX ?? 0)));
  const offsetY = Math.max(-1, Math.min(1, Number(node.data.offsetY ?? 0)));

  if (!sourceUrl) {
    return createElement(
      'div',
      { className: 'ne-node-preview-empty' },
      'wire an image or video in',
    );
  }

  // Simulate scale by clamping the media to `scale/2` of container size
  // (100% container = scale 2.0). Center + apply offset when scale < 1.
  // Offset only matters when the image is smaller than the canvas.
  const displayPct = Math.round((scale / 2) * 100);
  const canMove = scale < 1;
  const translatePctX = canMove ? offsetX * 50 : 0; // ±50% travel each way
  const translatePctY = canMove ? offsetY * 50 : 0;
  const mediaStyle: React.CSSProperties = {
    display: 'block',
    maxWidth: `${displayPct}%`,
    maxHeight: `${displayPct}%`,
    objectFit: 'contain',
    outline: '1px dashed rgba(78, 205, 196, 0.7)',
    transform: `translate(${translatePctX}%, ${translatePctY}%)`,
    cursor: canMove ? 'move' : 'default',
    pointerEvents: 'none',
  };
  const mediaEl =
    sourceKind === 'video'
      ? createElement('video', {
          src: sourceUrl,
          muted: true,
          playsInline: true,
          preload: 'metadata',
          style: mediaStyle,
        })
      : createElement('img', {
          src: sourceUrl,
          draggable: false,
          style: mediaStyle,
        });

  // Drag to reposition the scaled image (only meaningful when scale < 1).
  const dragRef = useRef<{
    el: HTMLDivElement | null;
    startX: number; startY: number;
    startOffsetX: number; startOffsetY: number;
    scale: number;
    dragging: boolean;
  }>({
    el: null, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0,
    scale: 1, dragging: false,
  });
  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canMove) return;
    e.stopPropagation();
    const el = e.currentTarget;
    dragRef.current = {
      el,
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
      scale,
      dragging: true,
    };
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st.dragging || !st.el) return;
    e.stopPropagation();
    const bbox = st.el.getBoundingClientRect();
    // Free travel per axis is (1 - scale) * bbox on each side. Offset
    // -1..1 = full travel each direction from center.
    const travelPxX = Math.max(1, (1 - st.scale) * bbox.width);
    const travelPxY = Math.max(1, (1 - st.scale) * bbox.height);
    const dx = (e.clientX - st.startX) / (travelPxX / 2);
    const dy = (e.clientY - st.startY) / (travelPxY / 2);
    const nx = Math.max(-1, Math.min(1, st.startOffsetX + dx));
    const ny = Math.max(-1, Math.min(1, st.startOffsetY + dy));
    onChangeData?.({ offsetX: nx, offsetY: ny });
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st.dragging) return;
    e.stopPropagation();
    try {
      if (st.el) st.el.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    dragRef.current = { ...st, el: null, dragging: false };
  };

  const captionResize = canMove
    ? `scale ${Math.round(scale * 100)}% · drag to reposition`
    : `scale ${Math.round(scale * 100)}%`;

  return createElement(
    'div',
    { className: 'ne-node-preview ne-node-preview--edit', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    createElement(
      'div',
      {
        style: {
          flex: 1, minHeight: 0, overflow: 'hidden', borderRadius: 4,
          background: '#111', display: 'flex', alignItems: 'center',
          justifyContent: 'center',
          cursor: canMove ? 'move' : 'default',
          touchAction: 'none',
        },
        onPointerDown: beginDrag,
        onPointerMove: dragMove,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      },
      mediaEl,
    ),
    createElement('input', {
      type: 'range',
      min: 25, max: 200, step: 1,
      value: String(Math.round(scale * 100)),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = Number(e.target.value) / 100;
        // Reset offset when scaling up past 1.0 (no room to move anymore).
        if (v >= 1) onChangeData?.({ scale: v, offsetX: 0, offsetY: 0 });
        else onChangeData?.({ scale: v });
      },
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
      style: { width: '100%' },
      title: 'Resize scale',
    }),
    createElement('div', { className: 'ne-node-preview-caption', style: { fontSize: 10 } }, captionResize),
  );
};

const EditToolPreview: FC<PreviewProps> = ({ node, onChangeData, onPromoteFrame }) => {
  const out = node.output;
  const kind: 'image' | 'video' = out?.kind === 'video' ? 'video' : 'image';
  const currentUrl = out?.dataUrl;
  const runtime = (node.data.__runtime ?? {}) as { error?: unknown };
  const err = typeof runtime.error === 'string' ? runtime.error : '';
  const rawHistory = (node.data as { __history?: unknown }).__history;
  const history = Array.isArray(rawHistory) ? (rawHistory as NodeOutput[]) : [];
  if (err) {
    return createElement(
      'div',
      { className: 'ne-node-preview ne-node-preview--text is-readonly' },
      createElement('textarea', {
        className: 'ne-node-inline-textarea ne-node-inline-textarea--readonly',
        value: err,
        readOnly: true,
        spellCheck: false,
        style: { color: '#ff8f88' },
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onWheel: (e: React.WheelEvent) => e.stopPropagation(),
      }),
      createElement('div', { className: 'ne-node-preview-caption' }, `⚠️ ${node.kind}`),
    );
  }
  return renderMediaThumb({
    node,
    kind,
    currentUrl,
    history,
    onPromoteFrame,
    onChangeData,
    labelHint: node.kind,
  });
};

// Small shared helper for a labeled number input in the Inspector.
function renderNumberField(
  label: string,
  value: number,
  onChange: (n: number) => void,
  opts?: { min?: number; max?: number; step?: number; help?: string },
) {
  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, label),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'number',
      value: String(value),
      min: opts?.min,
      max: opts?.max,
      step: opts?.step ?? 1,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      },
    }),
    opts?.help
      ? createElement('div', { className: 'ne-inspect-note', style: { fontSize: '11px' } }, opts.help)
      : null,
  );
}

function renderSelectField<T extends string>(
  label: string,
  value: T,
  options: { value: T; label: string }[],
  onChange: (v: T) => void,
  help?: string,
) {
  return createElement(
    Fragment,
    null,
    createElement('label', { className: 'ne-inspect-label' }, label),
    createElement(
      'select',
      {
        className: 'ne-inspect-select',
        value,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as T),
      },
      ...options.map((o) => createElement('option', { key: o.value, value: o.value }, o.label)),
    ),
    help ? createElement('div', { className: 'ne-inspect-note', style: { fontSize: '11px' } }, help) : null,
  );
}

const CROP_ASPECTS: { value: string; label: string }[] = [
  { value: '1:1', label: '1:1 square' },
  { value: '4:5', label: '4:5 portrait' },
  { value: '9:16', label: '9:16 vertical' },
  { value: '16:9', label: '16:9 widescreen' },
  { value: '2:3', label: '2:3 portrait' },
  { value: '3:2', label: '3:2 landscape' },
  { value: '21:9', label: '21:9 cinematic' },
  { value: 'custom', label: 'Custom dims' },
];

const CropInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const aspect = String(node.data.aspect ?? '16:9');
  const zoom = Math.max(0.2, Math.min(1, Number(node.data.zoom ?? 1)));
  const offsetX = Math.max(-1, Math.min(1, Number(node.data.offsetX ?? 0)));
  const offsetY = Math.max(-1, Math.min(1, Number(node.data.offsetY ?? 0)));
  const width = Number(node.data.width ?? 1024);
  const height = Number(node.data.height ?? 1024);
  const canReset = zoom !== 1 || offsetX !== 0 || offsetY !== 0;
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Crop the upstream media. Pick an aspect ratio, drag the teal box on the node body to reposition, and use the zoom slider to size. Click Apply to bake.',
    ),
    renderSelectField('Aspect ratio', aspect, CROP_ASPECTS, (v) => onChangeData({ aspect: v })),
    createElement('label', { className: 'ne-inspect-label' }, `Zoom (${Math.round(zoom * 100)}%)`),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'range',
      min: 20, max: 100, step: 1,
      value: String(Math.round(zoom * 100)),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ zoom: Number(e.target.value) / 100 }),
      style: { width: '100%' },
    }),
    canReset
      ? createElement(
          'button',
          {
            type: 'button',
            className: 'ne-inspect-secondary',
            style: { marginTop: 4, fontSize: 11 },
            onClick: () => onChangeData({ zoom: 1, offsetX: 0, offsetY: 0 }),
          },
          'Reset position + zoom',
        )
      : null,
    aspect === 'custom'
      ? createElement(
          Fragment,
          null,
          renderNumberField('Width (px)', width, (n) => onChangeData({ width: Math.max(1, Math.round(n)) }), { min: 1 }),
          renderNumberField('Height (px)', height, (n) => onChangeData({ height: Math.max(1, Math.round(n)) }), { min: 1 }),
        )
      : null,
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Cropping…' : 'Apply Crop',
    ),
  );
};

const RESIZE_FITS: { value: string; label: string }[] = [
  { value: 'stretch', label: 'Stretch (distort to fit)' },
  { value: 'fit', label: 'Fit (letterbox, no crop)' },
  { value: 'fill', label: 'Fill (zoom + crop)' },
];

const ResizeInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const scale = Math.max(0.25, Math.min(2, Number(node.data.scale ?? 1)));
  const useCustom = Boolean(node.data.useCustomDims ?? false);
  const width = Number(node.data.width ?? 1024);
  const height = Number(node.data.height ?? 1024);
  const fit = String(node.data.fit ?? 'stretch');
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Scale the upstream media using the slider on the node body. Aspect ratio is preserved automatically. Toggle Custom Dims for exact pixel dimensions.',
    ),
    createElement('label', { className: 'ne-inspect-label' }, `Scale (${Math.round(scale * 100)}%)`),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'range',
      min: 25, max: 200, step: 1,
      value: String(Math.round(scale * 100)),
      disabled: useCustom,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ scale: Number(e.target.value) / 100 }),
      style: { width: '100%' },
    }),
    createElement(
      'label',
      { className: 'ne-inspect-label', style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('input', {
        type: 'checkbox',
        checked: useCustom,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ useCustomDims: e.target.checked }),
      }),
      'Use custom pixel dimensions',
    ),
    useCustom
      ? createElement(
          Fragment,
          null,
          renderNumberField('Width (px)', width, (n) => onChangeData({ width: Math.max(1, Math.round(n)) }), { min: 1 }),
          renderNumberField('Height (px)', height, (n) => onChangeData({ height: Math.max(1, Math.round(n)) }), { min: 1 }),
          renderSelectField('Fit mode', fit, RESIZE_FITS, (v) => onChangeData({ fit: v })),
        )
      : null,
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Resizing…' : 'Apply Resize',
    ),
  );
};

const BLUR_KINDS: { value: string; label: string }[] = [
  { value: 'gaussian', label: 'Gaussian (smoother)' },
  { value: 'box', label: 'Fast Box (faster)' },
];

const BlurInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const kind = String(node.data.kind ?? 'gaussian');
  const radius = Number(node.data.radius ?? 8);
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Blur the upstream image or video. Radius is in pixels; higher = more blur.',
    ),
    renderSelectField('Blur type', kind, BLUR_KINDS, (v) => onChangeData({ kind: v })),
    renderNumberField('Radius (px)', radius, (n) => onChangeData({ radius: Math.max(0, n) }), { min: 0, max: 200, step: 1 }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Blurring…' : 'Apply Blur',
    ),
  );
};

const InvertInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const alphaOnly = Boolean(node.data.alphaOnly ?? false);
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Invert the upstream media. Toggle “alpha only” if you’re inverting a mask.',
    ),
    createElement(
      'label',
      { className: 'ne-inspect-label', style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('input', {
        type: 'checkbox',
        checked: alphaOnly,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ alphaOnly: e.target.checked }),
      }),
      'Invert alpha channel only',
    ),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Inverting…' : 'Apply Invert',
    ),
  );
};

const EXTRACT_PICK_BY: { value: string; label: string }[] = [
  { value: 'time', label: 'Time (seconds)' },
  { value: 'frame', label: 'Frame number' },
];

const ExtractFrameInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const pickBy = String(node.data.pickBy ?? 'time');
  const time = Number(node.data.time ?? 0);
  const frame = Number(node.data.frame ?? 0);
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Extract a single frame from an upstream video as a PNG image.',
    ),
    renderSelectField('Pick by', pickBy, EXTRACT_PICK_BY, (v) => onChangeData({ pickBy: v })),
    pickBy === 'time'
      ? renderNumberField('Time (sec)', time, (n) => onChangeData({ time: Math.max(0, n) }), { min: 0, step: 0.1, help: 'Seconds from the start of the video.' })
      : renderNumberField('Frame #', frame, (n) => onChangeData({ frame: Math.max(0, Math.round(n)) }), { min: 0, step: 1, help: 'Zero-indexed frame number.' }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Extracting…' : 'Extract Frame',
    ),
  );
};

// ---------------------------------------------------------------------------
// Frame Fix / Import / Export (v1.1.0)
// ---------------------------------------------------------------------------

// FRAMERATE_MODES ordering + labels mirror aifix_app.py so the node UI is
// visually identical to the .app dialog. If you touch this, keep the mode
// ids in sync with server.js's FRAMERATE_MODES table and aifix_app.py.
const FRAMERATE_MODES: { id: string; label: string }[] = [
  { id: 'conform24',    label: 'Conform 24 → 24 fps  (rebase wonky 23.75/23.94 GenAI clips)' },
  { id: 'conform30',    label: 'Conform 24 → 30 fps  (retimes; audio pitches up)' },
  { id: 'conform2997',  label: 'Conform 24 → 29.97 fps  (broadcast NTSC)' },
  { id: 'expand2430',   label: 'Expand 24 → 30 fps  (keep duration; random dup, audio kept)' },
  { id: 'expand242997', label: 'Expand 24 → 29.97 fps  (keep duration; random dup, audio kept)' },
  { id: 'pulldown',     label: '3:2 pulldown → 29.97 fps  (interlaced, broadcast)' },
];

// Interp models exposed to the UI — the Python tool's INTERP_MODELS list.
const INTERP_MODELS: { value: string; label: string }[] = [
  { value: 'rife-v4.6',  label: 'RIFE v4.6 — latest, balanced (default)' },
  { value: 'rife-v4',    label: 'RIFE v4 — earlier v4 weights' },
  { value: 'rife-v3.1',  label: 'RIFE v3.1 — alt architecture' },
  { value: 'rife-anime', label: 'RIFE anime — stylized content' },
  { value: 'rife-HD',    label: 'RIFE HD — high-detail variant' },
];

const FrameFixPreview: FC<PreviewProps> = ({ node, onChangeData, onPromoteFrame }) => {
  const history = useHistoryMirror(node, onChangeData);
  const url = node.output?.dataUrl;
  const modes = Array.isArray(node.data.framerateModes) ? (node.data.framerateModes as string[]) : [];
  const parts: string[] = [];
  if (node.data.detectMissing) parts.push('missing');
  if (node.data.detectDuplicates) {
    parts.push(node.data.dupMode === 'exact' ? 'dupes/exact' : `dupes/near-${node.data.dupSensitivity ?? 5}`);
  }
  if (modes.length > 0) parts.push(modes[0]);
  if (node.data.posterizeEnabled) parts.push(`posterize/${node.data.posterizeN ?? 2}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no ops';
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
      labelHint: 'framefix',
    }),
    createElement(
      'div',
      { className: 'ne-node-preview-caption' },
      summary,
    ),
  );
};

const FrameFixInspector: NodeKindDef['Inspector'] = ({ node, onChangeData, onGenerate, inFlight }) => {
  const detectMissing = Boolean(node.data.detectMissing ?? true);
  const detectDuplicates = Boolean(node.data.detectDuplicates ?? true);
  const dupMode = String(node.data.dupMode ?? 'exact');
  const dupSensitivity = Math.max(1, Math.min(10, Number(node.data.dupSensitivity ?? 5)));
  const dupesDropInterpolate = Boolean(node.data.dupesDropInterpolate ?? false);
  const framerateModes = Array.isArray(node.data.framerateModes) ? (node.data.framerateModes as string[]) : [];
  const posterizeEnabled = Boolean(node.data.posterizeEnabled ?? false);
  const posterizeN = Math.max(2, Math.min(100, Number(node.data.posterizeN ?? 2)));
  const interpModel = String(node.data.interpModel ?? 'rife-v4.6');
  const crf = Math.max(10, Math.min(30, Number(node.data.crf ?? 18)));

  const toggleFramerate = (id: string, checked: boolean) => {
    const next = new Set(framerateModes);
    if (checked) next.add(id); else next.delete(id);
    // Preserve source ordering per FRAMERATE_MODES.
    onChangeData({ framerateModes: FRAMERATE_MODES.map((m) => m.id).filter((mid) => next.has(mid)) });
  };

  const section = (title: string, ...kids: React.ReactNode[]) =>
    createElement(
      'div',
      { className: 'ne-framefix-section' },
      createElement('div', { className: 'ne-framefix-section-title' }, title),
      ...kids,
    );

  const check = (label: string, value: boolean, onChange: (v: boolean) => void, disabled?: boolean) =>
    createElement(
      'label',
      { className: 'ne-inspect-label', style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 } },
      createElement('input', {
        type: 'checkbox',
        checked: value,
        disabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked),
      }),
      label,
    );

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'AI Frame Fix — detect + repair frame skips / duplicate runs, and (optionally) convert framerate. Runs the aifix.py Python tool on the server.',
    ),
    section('Detection',
      check('Detect missing frames', detectMissing, (v) => onChangeData({ detectMissing: v })),
      check('Detect duplicate frames', detectDuplicates, (v) => onChangeData({ detectDuplicates: v })),
    ),
    section('Duplicate detection mode',
      createElement(
        'label',
        { className: 'ne-inspect-label', style: { display: 'flex', alignItems: 'center', gap: '6px', opacity: detectDuplicates ? 1 : 0.5 } },
        createElement('input', {
          type: 'radio',
          name: `dupMode-${node.id}`,
          checked: dupMode === 'exact',
          disabled: !detectDuplicates,
          onChange: () => onChangeData({ dupMode: 'exact' }),
        }),
        'Exact (near-exact adjacent dupes)',
      ),
      createElement(
        'label',
        { className: 'ne-inspect-label', style: { display: 'flex', alignItems: 'center', gap: '6px', opacity: detectDuplicates ? 1 : 0.5 } },
        createElement('input', {
          type: 'radio',
          name: `dupMode-${node.id}`,
          checked: dupMode === 'near',
          disabled: !detectDuplicates,
          onChange: () => onChangeData({ dupMode: 'near' }),
        }),
        'Near (adjustable sensitivity)',
      ),
      dupMode === 'near'
        ? createElement(
            Fragment,
            null,
            createElement('label', { className: 'ne-inspect-label' }, `Sensitivity: ${dupSensitivity} (1 = strict, 10 = aggressive)`),
            createElement('input', {
              className: 'ne-inspect-input',
              type: 'range',
              min: 1, max: 10, step: 1,
              value: String(dupSensitivity),
              disabled: !detectDuplicates,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ dupSensitivity: Number(e.target.value) }),
              style: { width: '100%' },
            }),
          )
        : null,
      check('Replace duplicates with RIFE-synth (keep length)',
        dupesDropInterpolate,
        (v) => onChangeData({ dupesDropInterpolate: v }),
        !detectDuplicates,
      ),
    ),
    section('Interpolation model',
      renderSelectField(
        'RIFE model',
        interpModel,
        INTERP_MODELS,
        (v) => onChangeData({ interpModel: v }),
        (detectMissing || dupesDropInterpolate) ? undefined : 'Only used when “Detect missing” or “Replace with RIFE-synth” is on.',
      ),
    ),
    section('Frame rate conversion',
      ...FRAMERATE_MODES.map((m) => check(m.label, framerateModes.includes(m.id), (v) => toggleFramerate(m.id, v))),
      framerateModes.length > 1
        ? createElement('div', { className: 'ne-inspect-note', style: { color: 'rgba(255,180,60,0.9)' } },
            `Only the first selected mode (${framerateModes[0]}) will be applied. Multi-select coming later.`,
          )
        : null,
      createElement('div', { className: 'ne-inspect-note', style: { fontSize: '11px' } },
        'Conform speeds up playback; the bundled ffmpeg has no rubberband, so pitch shifts up on conform. Use expand modes to keep duration + audio.',
      ),
    ),
    section('Posterize time',
      check('Enable posterize (hold every N frames)', posterizeEnabled, (v) => onChangeData({ posterizeEnabled: v })),
      posterizeEnabled
        ? renderNumberField('N (frames to hold)', posterizeN, (n) => onChangeData({ posterizeN: Math.max(2, Math.min(100, Math.round(n))) }), { min: 2, max: 100, step: 1 })
        : null,
    ),
    section('Encoding',
      renderNumberField('CRF', crf, (n) => onChangeData({ crf: Math.max(10, Math.min(30, Math.round(n))) }), {
        min: 10, max: 30, step: 1,
        help: 'Lower = higher quality, larger file. 18 is visually lossless.',
      }),
    ),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate' + (inFlight ? ' is-busy' : ''),
        type: 'button',
        disabled: inFlight,
        onClick: () => onGenerate(),
      },
      inFlight ? 'Fixing frames…' : 'Run Frame Fix',
    ),
  );
};

const ImportPreview: FC<PreviewProps> = ({ node, onChangeData }) => {
  const url = String((node.data as { mediaUrl?: unknown }).mediaUrl ?? '');
  const kind = String((node.data as { mediaKind?: unknown }).mediaKind ?? '');
  const filename = String((node.data as { filename?: unknown }).filename ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickFile = () => inputRef.current?.click();
  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!onChangeData) return;
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { uploadFile } = await import('../ai/media-store');
      const rec = await uploadFile(file);
      const isVideo = file.type.startsWith('video/');
      if (rec) {
        onChangeData({
          mediaId: rec.id,
          mediaUrl: rec.url,
          mediaKind: isVideo ? 'video' : 'image',
          filename: file.name,
        });
      }
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };
  const hiddenInput = createElement('input', {
    ref: inputRef,
    type: 'file',
    accept: 'image/*,video/*',
    style: { display: 'none' },
    onChange: onFileChosen,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  });
  if (!url) {
    return createElement(
      'div',
      {
        className: 'ne-node-preview ne-import-preview is-empty',
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation();
          pickFile();
        },
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      },
      '(empty — click to choose, or drop file onto canvas)',
      hiddenInput,
    );
  }
  return createElement(
    'div',
    {
      className: 'ne-node-preview ne-import-preview',
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        pickFile();
      },
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      title: 'Click to replace file',
    },
    kind === 'video'
      ? createElement('video', { src: url, muted: true, loop: true, autoPlay: true, playsInline: true })
      : createElement('img', { src: url, alt: filename || 'imported media' }),
    filename
      ? createElement('div', { className: 'ne-node-preview-caption' }, filename)
      : null,
    hiddenInput,
  );
};

const ImportInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const url = String((node.data as { mediaUrl?: unknown }).mediaUrl ?? '');
  const kind = String((node.data as { mediaKind?: unknown }).mediaKind ?? '');
  const filename = String((node.data as { filename?: unknown }).filename ?? '');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = () => inputRef.current?.click();
  const onClear = () => onChangeData({ mediaId: '', mediaUrl: '', mediaKind: '', filename: '' });

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      // Lazy import so this file stays a .ts (no runtime top-level fetch impact).
      const { uploadFile } = await import('../ai/media-store');
      const rec = await uploadFile(file);
      const isVideo = file.type.startsWith('video/');
      if (rec) {
        onChangeData({
          mediaId: rec.id,
          mediaUrl: rec.url,
          mediaKind: isVideo ? 'video' : 'image',
          filename: file.name,
        });
      } else {
        // Fallback: keep the data URL locally. Not ideal for big videos but
        // at least the node works.
        const reader = new FileReader();
        reader.onload = () => {
          onChangeData({
            mediaId: '',
            mediaUrl: String(reader.result),
            mediaKind: isVideo ? 'video' : 'image',
            filename: file.name,
          });
        };
        reader.readAsDataURL(file);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Import a local image or video into the graph. Files are uploaded to the media store so they survive page reload.',
    ),
    createElement('label', { className: 'ne-inspect-label' }, 'Filename'),
    createElement('div', { className: 'ne-inspect-input', style: { padding: '6px 8px', opacity: filename ? 1 : 0.5 } }, filename || '(none)'),
    createElement('label', { className: 'ne-inspect-label' }, 'Media kind'),
    createElement('div', { className: 'ne-inspect-input', style: { padding: '6px 8px', opacity: kind ? 1 : 0.5 } }, kind || '(none)'),
    createElement('input', {
      ref: inputRef,
      type: 'file',
      accept: 'image/*,video/*',
      style: { display: 'none' },
      onChange: onFileChosen,
    }),
    createElement(
      'button',
      {
        className: 'ne-inspect-generate',
        type: 'button',
        disabled: uploading,
        onClick: onPick,
      },
      uploading ? 'Uploading…' : (url ? 'Replace file…' : 'Choose file…'),
    ),
    url
      ? createElement(
          'button',
          {
            className: 'ne-inspect-generate',
            type: 'button',
            style: { marginTop: '6px', background: 'rgba(255,80,80,0.2)', border: '1px solid rgba(255,80,80,0.4)' },
            onClick: onClear,
          },
          'Clear',
        )
      : null,
  );
};

// Trigger a browser download of the given URL with the given filename.
// Handles both data: URLs and /api/media/... references.
async function triggerDownload(url: string, filename: string): Promise<void> {
  let href = url;
  let cleanup: (() => void) | null = null;
  if (!url.startsWith('data:')) {
    // Fetch → blob → object URL. Ensures the download attribute is honored
    // (some browsers ignore `download` for cross-origin refs).
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    const blob = await res.blob();
    href = URL.createObjectURL(blob);
    cleanup = () => URL.revokeObjectURL(href);
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (cleanup) setTimeout(cleanup, 5_000);
}

const ExportPreview: FC<PreviewProps> = ({ node }) => {
  const outKind = node.output?.kind;
  const outUrl = node.output?.dataUrl;
  const filename = String((node.data as { filename?: unknown }).filename ?? 'export');
  return createElement(
    'div',
    { className: 'ne-node-preview' + (outUrl ? '' : ' is-empty') },
    outUrl
      ? createElement(
          Fragment,
          null,
          outKind === 'video'
            ? createElement('video', { src: outUrl, muted: true, loop: true, autoPlay: true, playsInline: true, style: { width: '100%', height: 'auto' } })
            : createElement('img', { src: outUrl, alt: filename, style: { width: '100%', height: 'auto' } }),
          createElement(
            'button',
            {
              className: 'ne-export-download-btn',
              type: 'button',
              onClick: (e: React.MouseEvent) => {
                e.stopPropagation();
                const ext = outKind === 'video' ? 'mp4' : 'png';
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                triggerDownload(outUrl, `${filename}-${stamp}.${ext}`).catch((err) => {
                  // eslint-disable-next-line no-console
                  console.error('[export] download error', err);
                });
              },
              onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
              onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
            },
            `⬇ Download ${outKind ?? 'media'}`,
          ),
        )
      : createElement('div', { className: 'ne-node-preview-caption' }, '(wire media to export)'),
  );
};

const ExportInspector: NodeKindDef['Inspector'] = ({ node, onChangeData }) => {
  const filename = String((node.data as { filename?: unknown }).filename ?? 'export');
  const outKind = node.output?.kind;
  const outUrl = node.output?.dataUrl;
  const ext = outKind === 'video' ? 'mp4' : outKind === 'image' ? 'png' : '—';
  const doDownload = () => {
    if (!outUrl) return;
    const outExt = outKind === 'video' ? 'mp4' : 'png';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(outUrl, `${filename}-${stamp}.${outExt}`).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[export] download error', err);
    });
  };
  return createElement(
    'div',
    { className: 'ne-inspect-body' },
    createElement(
      'div',
      { className: 'ne-inspect-note' },
      'Export the wired upstream media to a local file. Format auto-detected from upstream kind.',
    ),
    createElement('label', { className: 'ne-inspect-label' }, 'Filename prefix'),
    createElement('input', {
      className: 'ne-inspect-input',
      type: 'text',
      value: filename,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeData({ filename: e.target.value }),
      placeholder: 'export',
    }),
    createElement('label', { className: 'ne-inspect-label' }, 'Format'),
    createElement('div', { className: 'ne-inspect-input', style: { padding: '6px 8px' } }, `.${ext} (${outKind ?? 'no upstream media'})`),
    createElement(
      'button',
      {
        className: 'ne-export-download-btn',
        type: 'button',
        disabled: !outUrl,
        onClick: doDownload,
      },
      outUrl ? `⬇ Download ${outKind ?? 'media'}` : 'Wire media to enable download',
    ),
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
  'prompt-enhancer': {
    kind: 'prompt-enhancer',
    label: 'Prompt Enhancer',
    // 'utility' groups it near Prompt Concat in the palette. It's text
    // in / text out, no image/video.
    category: 'utility',
    defaultWidth: 220,
    defaultHeight: 160,
    defaultData: () => defaultDataFor('prompt-enhancer'),
    ports: (data) => defaultPortsFor('prompt-enhancer', data),
    Preview: PromptEnhancerPreview,
    Inspector: PromptEnhancerInspector,
  },
  'llm-run': {
    kind: 'llm-run',
    label: 'Run Any LLM',
    // 'gen' because it's an inference call that costs money and produces
    // a fresh generation, like Image Gen / Movie Gen.
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 160,
    defaultData: () => defaultDataFor('llm-run'),
    ports: (data) => defaultPortsFor('llm-run', data),
    Preview: LlmRunPreview,
    Inspector: LlmRunInspector,
  },
  'image-describer': {
    kind: 'image-describer',
    label: 'Image Describer',
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 180,
    defaultData: () => defaultDataFor('image-describer'),
    ports: (data) => defaultPortsFor('image-describer', data),
    Preview: ImageDescriberPreview,
    Inspector: ImageDescriberInspector,
  },
  'video-describer': {
    kind: 'video-describer',
    label: 'Video Describer',
    category: 'gen',
    defaultWidth: 220,
    defaultHeight: 180,
    defaultData: () => defaultDataFor('video-describer'),
    ports: (data) => defaultPortsFor('video-describer', data),
    Preview: VideoDescriberPreview,
    Inspector: VideoDescriberInspector,
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
  // ---- Editing tools ----
  'crop': {
    kind: 'crop',
    label: 'Crop',
    category: 'edit',
    defaultWidth: 260,
    defaultHeight: 260,
    defaultData: () => defaultDataFor('crop'),
    ports: (data) => defaultPortsFor('crop', data),
    Preview: CropPreview,
    Inspector: CropInspector,
  },
  'resize': {
    kind: 'resize',
    label: 'Resize',
    category: 'edit',
    defaultWidth: 260,
    defaultHeight: 260,
    defaultData: () => defaultDataFor('resize'),
    ports: (data) => defaultPortsFor('resize', data),
    Preview: ResizePreview,
    Inspector: ResizeInspector,
  },
  'blur': {
    kind: 'blur',
    label: 'Blur',
    category: 'edit',
    defaultWidth: 220,
    defaultHeight: 200,
    defaultData: () => defaultDataFor('blur'),
    ports: (data) => defaultPortsFor('blur', data),
    Preview: EditToolPreview,
    Inspector: BlurInspector,
  },
  'invert': {
    kind: 'invert',
    label: 'Invert',
    category: 'edit',
    defaultWidth: 200,
    defaultHeight: 180,
    defaultData: () => defaultDataFor('invert'),
    ports: (data) => defaultPortsFor('invert', data),
    Preview: EditToolPreview,
    Inspector: InvertInspector,
  },
  'extract-frame': {
    kind: 'extract-frame',
    label: 'Extract Video Frame',
    category: 'edit',
    defaultWidth: 220,
    defaultHeight: 220,
    defaultData: () => defaultDataFor('extract-frame'),
    ports: (data) => defaultPortsFor('extract-frame', data),
    Preview: EditToolPreview,
    Inspector: ExtractFrameInspector,
  },
  // ---- I/O nodes (v1.1.0) ----
  'frame-fix': {
    kind: 'frame-fix',
    label: 'AI Frame Fix',
    category: 'edit',
    defaultWidth: 240,
    defaultHeight: 220,
    defaultData: () => defaultDataFor('frame-fix'),
    ports: (data) => defaultPortsFor('frame-fix', data),
    Preview: FrameFixPreview,
    Inspector: FrameFixInspector,
  },
  'import': {
    kind: 'import',
    label: 'Import',
    category: 'input',
    defaultWidth: 220,
    defaultHeight: 200,
    defaultData: () => defaultDataFor('import'),
    ports: (data) => defaultPortsFor('import', data),
    Preview: ImportPreview,
    Inspector: ImportInspector,
  },
  'export': {
    kind: 'export',
    label: 'Export',
    category: 'output',
    defaultWidth: 240,
    defaultHeight: 220,
    defaultData: () => defaultDataFor('export'),
    ports: (data) => defaultPortsFor('export', data),
    Preview: ExportPreview,
    Inspector: ExportInspector,
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
