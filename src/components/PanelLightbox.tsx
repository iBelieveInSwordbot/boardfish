// Spacebar-triggered full-screen preview of the currently-selected panel.
// Editable caption fields; arrow keys navigate prev/next; Esc closes.

import { useEffect } from 'react';
import type { Panel, ProjectSettings } from '../types';
import type { Action } from '../store';

type Props = {
  panel: Panel;
  panelIndex: number; // 1-based global index
  totalPanels: number;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
  onNavigate: (dir: 1 | -1) => void;
};

export function PanelLightbox({
  panel,
  panelIndex,
  totalPanels,
  settings,
  dispatch,
  onClose,
  onNavigate,
}: Props) {
  const objectFit: 'contain' | 'fill' | 'cover' =
    settings.imageFit === 'fill' ? 'fill' : settings.imageFit === 'crop' ? 'cover' : 'contain';

  const badges = settings.panelBadges;
  const numberText = badges.useNumberPrefix
    ? `${badges.numberPrefix}${String(panelIndex).padStart(2, '0')}`
    : String(panelIndex).padStart(2, '0');

  // Arrow-key navigation (only when the lightbox itself is focused, i.e. user isn't editing a field)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // If user is typing in a caption textarea, let arrows move the caret; don't hijack
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNavigate(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onNavigate(-1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate]);

  return (
    <div className="lightbox-backdrop" onClick={onClose} style={{ background: settings.colors.canvasBg }}>
      <button
        className="lightbox-nav lightbox-nav-prev"
        title="Previous panel (←)"
        disabled={totalPanels < 2}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(-1);
        }}
      >
        ‹
      </button>
      <button
        className="lightbox-nav lightbox-nav-next"
        title="Next panel (→)"
        disabled={totalPanels < 2}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate(1);
        }}
      >
        ›
      </button>
      <div
        className="lightbox-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: settings.colors.panelBg,
          color: settings.colors.text,
          fontFamily: settings.fonts.family,
        }}
      >
        {(badges.showNumber || badges.showCornerNote) && (
          <div
            className="panel-header"
            style={{
              color: settings.colors.panelLabel,
              fontSize: settings.fonts.panelLabelSizePx * 2.4,
              fontFamily: settings.fonts.family,
              fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
              fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
              padding: '10px 16px',
            }}
          >
            <div className="panel-header-left">{badges.showNumber ? numberText : ''}</div>
            <div className="panel-header-right">
              {badges.showCornerNote && (
                <div className="panel-header-note-wrap">
                  {badges.useCornerNotePrefix && badges.cornerNotePrefix && (
                    <span className="panel-header-note-prefix">{badges.cornerNotePrefix}</span>
                  )}
                  <input
                    className="panel-header-note"
                    style={{
                      color: settings.colors.panelLabel,
                      fontSize: settings.fonts.panelLabelSizePx * 2.4,
                      fontFamily: settings.fonts.family,
                      fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
                      fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
                    }}
                    value={panel.cornerNote}
                    placeholder="note"
                    onChange={(e) => dispatch({ type: 'SET_CORNER_NOTE', panelId: panel.id, value: e.target.value })}
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        <div className="lightbox-image" style={{ aspectRatio: `${settings.panelAspectRatio}`, background: '#000' }}>
          {panel.imageDataUrl ? (
            <img src={panel.imageDataUrl} alt={panel.imageName ?? ''} style={{ objectFit }} draggable={false} />
          ) : (
            <div className="panel-image-placeholder">no image</div>
          )}
        </div>
        <div className="lightbox-fields">
          {panel.fields.map((f) => (
            <div key={f.id} className="lightbox-field" style={{ background: settings.colors.fieldBg }}>
              <div className="lightbox-field-label" style={{ color: settings.colors.panelLabel }}>
                {f.label}
              </div>
              <textarea
                className="lightbox-field-input"
                value={f.value}
                placeholder={f.label}
                rows={3}
                style={{
                  fontSize: settings.fonts.fieldSizePx * 1.5,
                  fontFamily: settings.fonts.family,
                  fontWeight: settings.fonts.captionBold ? 700 : 400,
                  fontStyle: settings.fonts.captionItalic ? 'italic' : 'normal',
                  color: settings.colors.fieldText,
                  background: 'transparent',
                  caretColor: settings.colors.fieldText,
                }}
                onChange={(e) =>
                  dispatch({ type: 'UPDATE_FIELD', panelId: panel.id, fieldId: f.id, value: e.target.value })
                }
              />
            </div>
          ))}
        </div>
      </div>
      <div className="lightbox-hint">
        {panelIndex} / {totalPanels}  ·  ← / → to navigate  ·  Esc to close
      </div>
    </div>
  );
}
