import { useEffect, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Panel, PanelImageVersion, ProjectSettings } from '../types';
import { styleSuffix } from '../types';
import type { Action } from '../store';
import { generatePanelImage, ratioToLabel } from '../ai/client';

type Props = {
  panel: Panel;
  index: number; // global panel index (1-based)
  selected: boolean;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

export function PanelView({ panel, index, selected, settings, dispatch }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });
  const [aiOpen, setAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(panel.aiPrompt ?? '');
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
  async function runGenerate() {
    if (!aiPrompt.trim()) return;
    setAiOpen(false);
    await fireGenerate(aiPrompt.trim());
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
      >
        {panel.imageDataUrl ? (
          <img src={panel.imageDataUrl} alt={panel.imageName ?? ''} style={{ objectFit }} draggable={false} />
        ) : (
          <div className="panel-image-placeholder">no image</div>
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
          <label className="panel-ai-toggle" title="When on, the panel is rendered in the same B&W pencil-sketch storyboard style as the scripted AI Director flow.">
            <input
              type="checkbox"
              checked={(panel.styleMode ?? 'pencil-sketch') === 'pencil-sketch'}
              onChange={(e) => {
                const newMode: Panel['styleMode'] = e.target.checked ? 'pencil-sketch' : 'none';
                dispatch({ type: 'UPDATE_PANEL', id: panel.id, patch: { styleMode: newMode } });
              }}
            />
            <span>Pencil-sketch storyboard style</span>
          </label>
          {err && <div className="panel-ai-error">{err}</div>}
          <div className="panel-ai-actions">
            <button className="panel-ai-btn" onClick={() => setAiOpen(false)}>Cancel</button>
            <button className="panel-ai-btn primary" onClick={runGenerate} disabled={!aiPrompt.trim()}>
              Generate
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
// (multi-select up to 4); "Compare selected" opens the full-screen grid.
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
      if (prev.length >= 4) return prev; // cap at 4
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
  const gridClass = n === 2 ? 'compare-2' : n === 3 ? 'compare-3' : 'compare-4';

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="panel-compare-backdrop" onClick={onClose}>
      <div className="panel-compare-toolbar" onClick={(e) => e.stopPropagation()}>
        <span>Compare {n} versions</span>
        <span className="panel-compare-hint">Click any image to make it the current panel image — the one it replaces is saved to history.</span>
        <button className="panel-ai-btn" onClick={onClose}>Close (Esc)</button>
      </div>
      <div className={`panel-compare-grid ${gridClass}`} onClick={(e) => e.stopPropagation()}>
        {versions.map((v) => {
          const isCurrent = v.dataUrl === currentImageDataUrl;
          return (
            <div
              key={v.id}
              className={`panel-compare-cell ${isCurrent ? 'is-current' : ''}`}
              onClick={() => {
                if (v.id === '__current') { onClose(); return; }
                dispatch({ type: 'RESTORE_AI_IMAGE', panelId, versionId: v.id });
                onClose();
              }}
              title={v.prompt || '(no prompt recorded)'}
            >
              <img src={v.dataUrl} alt="" draggable={false} />
              <div className="panel-compare-caption">
                {isCurrent ? 'current' : v.generatedAt ? new Date(v.generatedAt).toLocaleString() : ''}
                {v.prompt && <div className="panel-compare-prompt">{v.prompt}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
