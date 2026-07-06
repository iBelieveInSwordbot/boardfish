import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Panel, ProjectSettings } from '../types';
import type { Action } from '../store';

type Props = {
  panel: Panel;
  selected: boolean;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

export function PanelView({ panel, selected, settings, dispatch }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: panel.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    background: settings.colors.panelBg,
    color: settings.colors.text,
    borderColor: selected ? settings.colors.accent : 'transparent',
  };

  const objectFit: 'contain' | 'cover' =
    settings.imageFit === 'fill' || settings.imageFit === 'crop' ? 'cover' : 'contain';

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
              style={{ color: settings.colors.fieldText, caretColor: settings.colors.fieldText }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
