import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Panel, ProjectSettings } from '../types';
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
  const [aiPrompt, setAiPrompt] = useState(panel.aiPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runGenerate() {
    if (!aiPrompt.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const img = await generatePanelImage({
        prompt: aiPrompt.trim(),
        aspectRatio: ratioToLabel(settings.panelAspectRatio),
      });
      dispatch({
        type: 'UPDATE_PANEL',
        id: panel.id,
        patch: {
          imageDataUrl: img.dataUrl,
          imageName: `AI ${new Date().toISOString().slice(0,10)} ${panel.id.slice(0,6)}.jpg`,
          aiPrompt: aiPrompt.trim(),
        },
      });
      setAiOpen(false);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
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
      {!aiOpen && (
        <div className="panel-ai-controls" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {panel.aiPrompt && panel.imageDataUrl && (
            <button
              className="panel-ai-btn"
              title="Regenerate with current prompt"
              disabled={busy}
              onClick={() => { setAiPrompt(panel.aiPrompt ?? ''); void runGenerate(); }}
            >
              {busy ? '…' : '↻ Re-gen'}
            </button>
          )}
          <button
            className="panel-ai-btn"
            title={panel.aiPrompt ? 'Edit prompt' : 'AI generate image'}
            disabled={busy}
            onClick={() => { setAiPrompt(panel.aiPrompt ?? ''); setAiOpen(true); }}
          >
            {panel.imageDataUrl ? '✎ Prompt' : '✨ AI'}
          </button>
        </div>
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
            disabled={busy}
            autoFocus
          />
          {err && <div className="panel-ai-error">{err}</div>}
          <div className="panel-ai-actions">
            <button className="panel-ai-btn" onClick={() => setAiOpen(false)} disabled={busy}>Cancel</button>
            <button className="panel-ai-btn primary" onClick={runGenerate} disabled={busy || !aiPrompt.trim()}>
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
