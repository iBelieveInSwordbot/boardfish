// Spacebar-triggered full-screen preview of the currently-selected panel.
// Renders a fixed backdrop and a scaled clone of the panel inside it, no editing.

import type { Panel, ProjectSettings } from '../types';

type Props = {
  panel: Panel;
  panelIndex: number; // 1-based global index
  settings: ProjectSettings;
  onClose: () => void;
};

export function PanelLightbox({ panel, panelIndex, settings, onClose }: Props) {
  const objectFit: 'contain' | 'fill' | 'cover' =
    settings.imageFit === 'fill' ? 'fill' : settings.imageFit === 'crop' ? 'cover' : 'contain';

  const badges = settings.panelBadges;
  const numberText = badges.useNumberPrefix
    ? `${badges.numberPrefix}${String(panelIndex).padStart(2, '0')}`
    : String(panelIndex).padStart(2, '0');

  return (
    <div className="lightbox-backdrop" onClick={onClose} style={{ background: settings.colors.canvasBg }}>
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
              fontSize: settings.fonts.panelLabelSizePx * 3,
              fontFamily: settings.fonts.family,
              fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
              fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
              padding: '8px 16px',
            }}
          >
            <div className="panel-header-left">{badges.showNumber ? numberText : ''}</div>
            <div className="panel-header-right">
              {badges.showCornerNote && panel.cornerNote && (
                <span>
                  {badges.useCornerNotePrefix ? badges.cornerNotePrefix : ''}
                  {panel.cornerNote}
                </span>
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
        <div
          className="lightbox-fields"
          style={{
            fontSize: settings.fonts.fieldSizePx * 1.6,
            fontFamily: settings.fonts.family,
            fontWeight: settings.fonts.captionBold ? 700 : 400,
            fontStyle: settings.fonts.captionItalic ? 'italic' : 'normal',
            color: settings.colors.fieldText,
          }}
        >
          {panel.fields.map((f) => (
            <div key={f.id} className="lightbox-field" style={{ background: settings.colors.fieldBg }}>
              <div className="lightbox-field-label" style={{ color: settings.colors.panelLabel }}>
                {f.label}
              </div>
              <div className="lightbox-field-value">{f.value || <span className="dim">—</span>}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="lightbox-hint">Space or Esc to close</div>
    </div>
  );
}
