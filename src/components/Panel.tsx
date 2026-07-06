import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Panel, ProjectSettings } from '../types';
import type { Action } from '../store';

type Props = {
  panel: Panel;
  index: number; // global panel index (1-based)
  selected: boolean;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

export function PanelView({ panel, index, selected, settings, dispatch }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: settings.colors.panelBg,
    color: settings.colors.text,
    borderColor: selected ? settings.colors.accent : 'transparent',
    fontFamily: settings.fonts.family,
  };

  const objectFit: 'contain' | 'cover' =
    settings.imageFit === 'fill' || settings.imageFit === 'crop' ? 'cover' : 'contain';

  const badgeStyle: React.CSSProperties = {
    color: settings.colors.panelLabel,
    fontSize: settings.fonts.panelLabelSizePx,
    fontFamily: settings.fonts.family,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`panel ${selected ? 'panel-selected' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        dispatch({ type: 'SELECT_PANEL', id: panel.id });
      }}
      {...attributes}
      {...listeners}
    >
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
        {settings.panelBadges.showNumber && (
          <div className="panel-badge panel-badge-tl" style={badgeStyle}>
            {String(index).padStart(2, '0')}
          </div>
        )}
        {settings.panelBadges.showCornerNote && (
          <input
            className="panel-badge panel-badge-tr panel-badge-input"
            style={badgeStyle}
            value={panel.cornerNote}
            placeholder="note"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => dispatch({ type: 'SET_CORNER_NOTE', panelId: panel.id, value: e.target.value })}
            spellCheck={false}
          />
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
                fontSize: settings.fonts.fieldSizePx,
                fontFamily: settings.fonts.family,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
