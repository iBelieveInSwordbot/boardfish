import { useContext, useEffect, useRef, useState } from 'react';
import { GeneratingPanelsContext } from './Canvas';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Panel, PanelImageVersion, ProjectSettings } from '../types';
import { styleSuffix, PANEL_STYLE_ORDER, STYLE_PRESET_LABELS, STYLE_PRESET_TAGS } from '../types';
import type { Action } from '../store';
import { generatePanelImage, ratioToLabel } from '../ai/client';

type Props = {
  panel: Panel;
  index: number; // global panel index (1-based)
  selected: boolean;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
  onOpenNodeEditor?: (panelId: string) => void;
};

export function PanelView({ panel, index, selected, settings, dispatch, onOpenNodeEditor }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });
  // Show a spinner overlay when this panel has a node-editor gen running
  // (either the editor is visible or it's detached in the background).
  const generatingSet = useContext(GeneratingPanelsContext);
  const isNodeGenerating = generatingSet.has(panel.id);
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(panel.aiPrompt ?? '');
  // How many concurrent variants to generate when Generate is clicked (1-4).
  // Persisted only in-editor; not saved to the panel because it's a
  // per-click choice, not a stable property.
  const [variantCount, setVariantCount] = useState<1 | 2 | 3 | 4>(1);
  // Rapid re-gen: counter of currently in-flight generations for this panel.
  // Multiple clicks fire multiple concurrent requests; each archives its result
  // to history, and whichever finishes last becomes the current image. Nothing
  // is lost — the user can revisit any version from the history strip.
  const [inFlight, setInFlight] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const historyCount = panel.imageHistory?.length ?? 0;

  // Prompt source: if we have an explicit aiPrompt (AI Director flow), use it.
  // Otherwise fall back to concatenated Description-style fields, so a blank
  // panel added via "+ Panel" can generate straight from what the user typed
  // in the description caption(s).
  function promptFromFields(): string {
    // Prefer field labeled "Description" (case-insensitive) if present, else
    // join all non-empty field values.
    const desc = panel.fields.find((f) => f.label.toLowerCase() === 'description');
    if (desc && desc.value.trim()) return desc.value.trim();
    return panel.fields.map((f) => f.value.trim()).filter(Boolean).join('. ');
  }

  function effectivePrompt(): string {
    if (panel.aiPrompt && panel.aiPrompt.trim()) return panel.aiPrompt.trim();
    return promptFromFields();
  }

  // Fire one generation (non-blocking). If prompt is empty, no-op.
  // styleModeOverride lets the editor commit a per-click override without
  // waiting for React state to flush; falls back to panel.styleMode.
  async function fireGenerate(promptOverride?: string, styleModeOverride?: Panel['styleMode']) {
    const rawPrompt = (promptOverride ?? effectivePrompt()).trim();
    if (!rawPrompt) {
      setErr('Add a description first, then try again.');
      return;
    }
    const mode = styleModeOverride ?? panel.styleMode;
    const finalPrompt = rawPrompt + styleSuffix(mode);
    setErr(null);
    setInFlight((n) => n + 1);
    try {
      const img = await generatePanelImage({
        prompt: finalPrompt,
        aspectRatio: ratioToLabel(settings.panelAspectRatio),
      });
      dispatch({
        type: 'APPLY_AI_IMAGE',
        panelId: panel.id,
        dataUrl: img.dataUrl,
        imageName: `AI ${new Date().toISOString().slice(0,10)} ${panel.id.slice(0,6)}.jpg`,
        // Save the user-facing prompt (without style suffix) so the editor
        // shows what they typed, not the mangled version.
        prompt: rawPrompt,
        generatedAt: Date.now(),
      });
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setInFlight((n) => Math.max(0, n - 1));
    }
  }

  // Prompt-editor path: submits the current textarea value, closes editor.
  // Fires `variantCount` concurrent generations — each result lands in history.
  async function runGenerate() {
    if (!aiPrompt.trim()) return;
    setAiOpen(false);
    const prompt = aiPrompt.trim();
    // Fire all variants concurrently; each fireGenerate manages its own
    // inFlight increment/decrement and dispatches APPLY_AI_IMAGE on success.
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < variantCount; i++) {
      jobs.push(fireGenerate(prompt));
    }
    // Don't await — let them run in the background so the editor closes
    // immediately. Errors are surfaced individually via setErr().
    void Promise.all(jobs);
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: settings.colors.panelBg,
    color: settings.colors.text,
    borderColor: selected ? settings.colors.accent : 'transparent',
    fontFamily: settings.fonts.family,
  };

  // 'fit' = contain (letterbox), 'fill' = stretch non-proportionally, 'crop' = cover
  const objectFit: 'contain' | 'fill' | 'cover' =
    settings.imageFit === 'fill' ? 'fill' : settings.imageFit === 'crop' ? 'cover' : 'contain';

  const badges = settings.panelBadges;
  const showHeader = badges.showNumber || badges.showCornerNote;

  const numberText = badges.useNumberPrefix
    ? `${badges.numberPrefix}${String(index).padStart(2, '0')}`
    : String(index).padStart(2, '0');

  const headerStyle: React.CSSProperties = {
    color: settings.colors.panelLabel,
    fontSize: settings.fonts.panelLabelSizePx,
    fontFamily: settings.fonts.family,
    fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
    fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`panel ${selected ? 'panel-selected' : ''}`}
      data-panel-id={panel.id}
      onClick={(e) => {
        e.stopPropagation();
        const modifier: 'set' | 'toggle' | 'range' =
          e.shiftKey ? 'range' : (e.metaKey || e.ctrlKey) ? 'toggle' : 'set';
        dispatch({ type: 'SELECT_PANEL', id: panel.id, modifier });
      }}
      {...attributes}
      {...listeners}
    >
      {showHeader && (
        <div className="panel-header" style={headerStyle}>
          <div className="panel-header-left">{badges.showNumber ? numberText : ''}</div>
          <div className="panel-header-right">
            {badges.showCornerNote ? (
              <div className="panel-header-note-wrap">
                {badges.useCornerNotePrefix && badges.cornerNotePrefix && (
                  <span className="panel-header-note-prefix">{badges.cornerNotePrefix}</span>
                )}
                <input
                  className="panel-header-note"
                  style={{
                  color: settings.colors.panelLabel,
                  fontSize: settings.fonts.panelLabelSizePx,
                  fontFamily: settings.fonts.family,
                  fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
                  fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
                }}
                  value={panel.cornerNote}
                  placeholder="note"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => dispatch({ type: 'SET_CORNER_NOTE', panelId: panel.id, value: e.target.value })}
                  spellCheck={false}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div
        className="panel-image"
        style={{
          aspectRatio: `${settings.panelAspectRatio}`,
          background: '#000',
        }}
        onDoubleClick={(e) => {
          if (!onOpenNodeEditor) return;
          e.stopPropagation();
          e.preventDefault();
          onOpenNodeEditor(panel.id);
        }}
        title={onOpenNodeEditor ? 'Double-click to open node editor' : undefined}
      >
        {panel.imageDataUrl ? (
          <img src={panel.imageDataUrl} alt={panel.imageName ?? ''} style={{ objectFit }} draggable={false} />
        ) : (
          <div className="panel-image-placeholder">no image</div>
        )}
        {(isNodeGenerating || inFlight > 0) && (
          <div className="panel-generating-overlay" title="Generating…">
            <div className="panel-generating-spinner" />
            <div className="panel-generating-label">
              {isNodeGenerating ? 'Node gen…' : `Gen × ${inFlight}`}
            </div>
          </div>
        )}
        {panel.videoDataUrl && (
          <div className="panel-video-badge" title="This panel has a video — press Space to play">
            ▶ VIDEO
          </div>
        )}
      </div>
      <div className="panel-fields">
        {panel.fields.map((f) => (
          <div key={f.id} className="panel-field">
            <textarea
              value={f.value}
              placeholder={f.label}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                dispatch({ type: 'UPDATE_FIELD', panelId: panel.id, fieldId: f.id, value: e.target.value })
              }
              rows={2}
              style={{
                color: settings.colors.fieldText,
                caretColor: settings.colors.fieldText,
                background: settings.colors.fieldBg,
                fontSize: settings.fonts.fieldSizePx,
                fontFamily: settings.fonts.family,
                fontWeight: settings.fonts.captionBold ? 700 : 400,
                fontStyle: settings.fonts.captionItalic ? 'italic' : 'normal',
              }}
            />
          </div>
        ))}
      </div>
      {/* AI controls (hover-revealed) */}
      {!aiOpen && !historyOpen && (
        <div className="panel-ai-controls" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {inFlight > 0 && (
            <span className="panel-ai-badge" title={`${inFlight} generation${inFlight === 1 ? '' : 's'} in flight`}>
              ● {inFlight}
            </span>
          )}
          {historyCount > 0 && (
            <button
              className="panel-ai-btn"
              title={`${historyCount} prior generation${historyCount === 1 ? '' : 's'}`}
              onClick={() => setHistoryOpen(true)}
            >
              🕒 {historyCount}
            </button>
          )}
          {(panel.imageDataUrl || effectivePrompt()) && (
            <button
              className="panel-ai-btn"
              title="Re-generate (click multiple times for parallel variants; every result is saved)"
              onClick={() => { void fireGenerate(); }}
            >
              ↻ Re-gen
            </button>
          )}
          <button
            className="panel-ai-btn"
            title={panel.aiPrompt ? 'Edit prompt' : effectivePrompt() ? 'AI generate from description' : 'AI generate image'}
            onClick={() => { setAiPrompt(panel.aiPrompt ?? effectivePrompt()); setAiOpen(true); }}
          >
            {panel.imageDataUrl ? '✎ Prompt' : '✨ AI'}
          </button>
        </div>
      )}
      {historyOpen && (
        <PanelHistoryPane
          panel={panel}
          historyCount={historyCount}
          dispatch={dispatch}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {aiOpen && (
        <div
          className="panel-ai-editor"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <textarea
            className="panel-ai-textarea"
            rows={3}
            placeholder="Describe the shot for Nano Banana Pro..."
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            autoFocus
          />
          <div className="panel-ai-style">
            <div className="panel-ai-style-label">Style</div>
            <div className="panel-ai-style-chips">
              {PANEL_STYLE_ORDER.map((mode) => {
                const active = (panel.styleMode ?? 'pencil-sketch') === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={`panel-ai-style-chip ${active ? 'active' : ''}`}
                    title={STYLE_PRESET_TAGS[mode] || 'No style directive appended'}
                    onClick={() => dispatch({ type: 'UPDATE_PANEL', id: panel.id, patch: { styleMode: mode } })}
                  >
                    {STYLE_PRESET_LABELS[mode]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="panel-ai-variants" title="How many variants to generate concurrently. Each result is saved to this panel's history.">
            <span className="panel-ai-variants-label">Variants:</span>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                className={`panel-ai-variant-btn ${variantCount === n ? 'active' : ''}`}
                onClick={() => setVariantCount(n as 1 | 2 | 3 | 4)}
              >
                {n}
              </button>
            ))}
          </div>
          {err && <div className="panel-ai-error">{err}</div>}
          <div className="panel-ai-actions">
            <button className="panel-ai-btn" onClick={() => setAiOpen(false)}>Cancel</button>
            <button className="panel-ai-btn primary" onClick={runGenerate} disabled={!aiPrompt.trim()}>
              {variantCount === 1 ? 'Generate' : `Generate ×${variantCount}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- History pane (inline over the panel) ----------
//
// Shows the current image + all prior versions. Click a thumbnail to check it
// (multi-select up to 9); "Compare selected" opens the full-screen grid.
// Grid layouts: 2·1 / 3·1 / 2·2 (4) / 5-flow / 6-flow / 7-flow / 8-flow / 3·3 (9).
// Single "Use" swap and "Delete" per version remain available. The current
// image is included as a selectable card labeled "current" so it can
// participate in Compare too.

type HistoryPaneProps = {
  panel: Panel;
  historyCount: number;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
};

function PanelHistoryPane({ panel, historyCount, dispatch, onClose }: HistoryPaneProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // Build a unified list: current image first (id='__current'), then history newest-first.
  const history = panel.imageHistory ?? [];
  const currentAsVersion: PanelImageVersion | null = panel.imageDataUrl
    ? {
        id: '__current',
        dataUrl: panel.imageDataUrl,
        prompt: panel.aiPrompt ?? '',
        generatedAt: 0, // marker
      }
    : null;
  const versions: PanelImageVersion[] = [
    ...(currentAsVersion ? [currentAsVersion] : []),
    ...history.slice().reverse(),
  ];

  function toggle(id: string) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 9) return prev; // cap at 9 (3×3 grid)
      return [...prev, id];
    });
  }

  const selectedVersions = selectedIds
    .map((id) => versions.find((v) => v.id === id))
    .filter((v): v is PanelImageVersion => Boolean(v));

  return (
    <>
      <div
        className="panel-ai-history"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="panel-ai-history-head">
          <span>
            {historyCount === 0 ? 'Current only' : `Current + ${historyCount} prior`}
            {selectedIds.length > 0 && ` · ${selectedIds.length} selected`}
          </span>
          <div className="panel-ai-history-head-actions">
            {selectedIds.length >= 2 && (
              <button className="panel-ai-btn primary" onClick={() => setCompareOpen(true)}>
                Compare ({selectedIds.length})
              </button>
            )}
            {selectedIds.length > 0 && (
              <button className="panel-ai-btn" onClick={() => setSelectedIds([])}>Clear</button>
            )}
            <button className="panel-ai-btn" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="panel-ai-history-strip">
          {versions.map((v) => {
            const isCurrent = v.id === '__current';
            const isSelected = selectedIds.includes(v.id);
            return (
              <div
                key={v.id}
                className={`panel-ai-history-thumb ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''}`}
                title={
                  (isCurrent ? 'Currently displayed\n\n' : new Date(v.generatedAt).toLocaleString() + '\n\n') +
                  (v.prompt || '(no prompt recorded)')
                }
                onClick={() => toggle(v.id)}
              >
                <img src={v.dataUrl} alt="" draggable={false} />
                {isCurrent && <div className="panel-ai-history-thumb-badge">current</div>}
                {isSelected && (
                  <div className="panel-ai-history-thumb-check">
                    {selectedIds.indexOf(v.id) + 1}
                  </div>
                )}
                <div
                  className="panel-ai-history-thumb-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!isCurrent && (
                    <button
                      className="panel-ai-btn primary"
                      onClick={() => {
                        dispatch({ type: 'RESTORE_AI_IMAGE', panelId: panel.id, versionId: v.id });
                        onClose();
                      }}
                    >
                      Use
                    </button>
                  )}
                  {!isCurrent && (
                    <button
                      className="panel-ai-btn danger"
                      onClick={() => {
                        if (confirm('Delete this previous generation? This cannot be undone.')) {
                          dispatch({ type: 'DELETE_AI_HISTORY', panelId: panel.id, versionId: v.id });
                        }
                      }}
                      title="Delete this version"
                    >
                      ✖
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {compareOpen && selectedVersions.length >= 2 && (
        <HistoryCompareOverlay
          panelId={panel.id}
          versions={selectedVersions}
          currentImageDataUrl={panel.imageDataUrl}
          dispatch={dispatch}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </>
  );
}

// ---------- Full-screen compare overlay (2-4 images) ----------

type CompareProps = {
  panelId: string;
  versions: PanelImageVersion[];
  currentImageDataUrl: string | null;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
};

function HistoryCompareOverlay({ panelId, versions, currentImageDataUrl, dispatch, onClose }: CompareProps) {
  const n = versions.length;
  const gridClass = `compare-${Math.min(Math.max(n, 2), 9)}`;

  // Grid vs focus mode. In grid mode: 2/3/4-up thumbnails. In focus mode: one
  // image fills the viewport, arrow keys cycle, scroll = zoom, drag = pan.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // The most recently hovered / clicked cell is the "active" one; pressing
  // spacebar promotes it to focus mode. In focus mode, activeIdx = focusIdx.
  const [activeIdx, setActiveIdx] = useState(0);

  // Zoom + pan state (only used in focus mode).
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  function enterFocus(idx: number) {
    setFocusIdx(idx);
    setActiveIdx(idx);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  function exitFocus() {
    setFocusIdx(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Space = toggle focus mode on the active cell
      if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (focusIdx === null) enterFocus(activeIdx);
        else exitFocus();
        return;
      }
      // Arrow keys cycle in focus mode (also work in grid mode to move active)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = (activeIdx + dir + n) % n;
        setActiveIdx(next);
        if (focusIdx !== null) {
          setFocusIdx(next);
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }
        return;
      }
      // Enter in focus mode = use this version
      if (e.key === 'Enter' && focusIdx !== null) {
        e.preventDefault();
        e.stopPropagation();
        const v = versions[focusIdx];
        if (v.id === '__current') { onClose(); return; }
        dispatch({ type: 'RESTORE_AI_IMAGE', panelId, versionId: v.id });
        onClose();
        return;
      }
      // Escape: focus → grid, grid → close
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (focusIdx !== null) exitFocus();
        else onClose();
        return;
      }
      // 0 = reset zoom in focus mode
      if (e.key === '0' && focusIdx !== null) {
        e.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIdx, activeIdx, n]);

  function onWheelFocus(e: React.WheelEvent) {
    if (focusIdx === null) return;
    e.preventDefault();
    const factor = 1 + (-e.deltaY / 400);
    setZoom((z) => Math.max(0.25, Math.min(8, +(z * factor).toFixed(3))));
  }

  function onPointerDownFocus(e: React.PointerEvent) {
    if (focusIdx === null) return;
    if (zoom <= 1) return; // no need to pan when fit-to-screen
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function onPointerMoveFocus(e: React.PointerEvent) {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.panX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.panY + (e.clientY - dragRef.current.startY),
    });
  }
  function onPointerUpFocus(e: React.PointerEvent) {
    if (dragRef.current) {
      dragRef.current = null;
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }

  const focusedVersion = focusIdx !== null ? versions[focusIdx] : null;

  return (
    <div className="panel-compare-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel-compare-toolbar" onClick={(e) => e.stopPropagation()}>
        <span>{focusIdx !== null ? `Focus · ${focusIdx + 1} of ${n}` : `Compare ${n} versions`}</span>
        <span className="panel-compare-hint">
          {focusIdx !== null
            ? 'Scroll to zoom · Drag to pan · ←/→ cycle · Space or Esc: back to grid · Enter: use this one'
            : 'Click a tile to focus · Space to zoom the highlighted one · Use makes it the panel image'}
        </span>
        <div className="panel-compare-toolbar-btns">
          {focusIdx !== null && focusedVersion && focusedVersion.id !== '__current' && (
            <button
              className="panel-ai-btn primary"
              onClick={() => {
                dispatch({ type: 'RESTORE_AI_IMAGE', panelId, versionId: focusedVersion.id });
                onClose();
              }}
            >
              Use this (Enter)
            </button>
          )}
          {focusIdx !== null && focusedVersion && focusedVersion.id !== '__current' && (
            <button
              className="panel-ai-btn danger"
              title="Delete this version"
              onClick={() => {
                if (!confirm('Delete this previous generation? This cannot be undone.')) return;
                dispatch({ type: 'DELETE_AI_HISTORY', panelId, versionId: focusedVersion.id });
                // Step back to previous frame if we deleted the current focus.
                const nextIdx = Math.max(0, focusIdx - 1);
                // If nothing left in versions after this, exit compare.
                if (versions.length <= 1) onClose();
                else { setFocusIdx(nextIdx); setActiveIdx(nextIdx); }
              }}
            >
              🗑 Delete
            </button>
          )}
          {focusIdx !== null && (
            <button className="panel-ai-btn" onClick={exitFocus}>Back to grid</button>
          )}
          <button className="panel-ai-btn" onClick={onClose}>Close (Esc)</button>
        </div>
      </div>

      {focusIdx === null && (
        <div className={`panel-compare-grid ${gridClass}`} onClick={(e) => e.stopPropagation()}>
          {versions.map((v, i) => {
            const isCurrent = v.dataUrl === currentImageDataUrl;
            const isActive = i === activeIdx;
            return (
              <div
                key={v.id}
                className={`panel-compare-cell ${isCurrent ? 'is-current' : ''} ${isActive ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => enterFocus(i)}
                title={v.prompt || '(no prompt recorded)'}
              >
                <img src={v.dataUrl} alt="" draggable={false} />
                <div className="panel-compare-caption">
                  <div className="panel-compare-caption-row">
                    <span>{isCurrent ? 'current' : v.generatedAt ? new Date(v.generatedAt).toLocaleString() : ''}</span>
                    <div className="panel-compare-caption-btns">
                      {v.id !== '__current' && (
                        <button
                          className="panel-ai-btn primary tiny"
                          onClick={(e) => {
                            e.stopPropagation();
                            dispatch({ type: 'RESTORE_AI_IMAGE', panelId, versionId: v.id });
                            onClose();
                          }}
                        >
                          Use
                        </button>
                      )}
                      {v.id !== '__current' && (
                        <button
                          className="panel-ai-btn danger tiny"
                          title="Delete this version"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!confirm('Delete this previous generation? This cannot be undone.')) return;
                            dispatch({ type: 'DELETE_AI_HISTORY', panelId, versionId: v.id });
                          }}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                  {v.prompt && <div className="panel-compare-prompt">{v.prompt}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {focusIdx !== null && focusedVersion && (
        <div
          className="panel-compare-focus"
          onWheel={onWheelFocus}
          onPointerDown={onPointerDownFocus}
          onPointerMove={onPointerMoveFocus}
          onPointerUp={onPointerUpFocus}
          onPointerCancel={onPointerUpFocus}
          style={{ cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in' }}
        >
          <img
            src={focusedVersion.dataUrl}
            alt=""
            draggable={false}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }}
          />
          <div className="panel-compare-focus-caption">
            {focusedVersion.id === '__current'
              ? 'current'
              : focusedVersion.generatedAt ? new Date(focusedVersion.generatedAt).toLocaleString() : ''}
            {focusedVersion.prompt && <div className="panel-compare-prompt">{focusedVersion.prompt}</div>}
            <div className="panel-compare-zoom-hud">
              <button className="panel-ai-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>−</button>
              <button className="panel-ai-btn" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button>
              <button className="panel-ai-btn" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>+</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
