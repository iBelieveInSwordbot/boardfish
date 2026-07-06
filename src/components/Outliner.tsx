// Left drawer showing the ordered list of document items (slides + storyboards).
// Click an item → select + scroll canvas to it. Drag to reorder. + Slide / + Storyboard at bottom.

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect } from 'react';
import type { Action, BoardfishState } from '../store';
import type { DocItem } from '../types';

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  onClose?: () => void;
};

export function Outliner({ state, dispatch, onClose }: Props) {
  const { items, selectedItemId, selectedPanelIds } = state;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Track which item currently owns the primary selected panel, so its outliner row lights up too
  const primaryPanelId = selectedPanelIds[0] ?? null;
  let owningItemId: string | null = null;
  if (primaryPanelId) {
    for (const it of items) {
      if (it.kind === 'storyboard' && it.panels.some((p) => p.id === primaryPanelId)) {
        owningItemId = it.id;
        break;
      }
    }
  }

  const onDragEnd = (evt: DragEndEvent) => {
    const { active, over } = evt;
    if (!over || active.id === over.id) return;
    const ids = items.map((it) => it.id);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = ids.slice();
    reordered.splice(oldIdx, 1);
    reordered.splice(newIdx, 0, String(active.id));
    dispatch({ type: 'REORDER_ITEMS', ids: reordered });
  };

  // Auto-scroll the selected outliner row into view
  useEffect(() => {
    const activeId = selectedItemId ?? owningItemId;
    if (!activeId) return;
    const el = document.querySelector(`[data-outliner-item="${activeId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedItemId, owningItemId]);

  return (
    <aside className="outliner">
      <div className="outliner-header">
        <div className="outliner-title">Outline</div>
        {onClose && (
          <button className="outliner-close" title="Hide Outline (⌘⇧O)" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div className="outliner-body">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            {items.map((it, idx) => (
              <OutlinerRow
                key={it.id}
                item={it}
                index={idx + 1}
                selected={selectedItemId === it.id || owningItemId === it.id}
                dispatch={dispatch}
                canDelete={items.length > 1}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <div className="outliner-footer">
        <button
          className="outliner-add-btn"
          onClick={() => dispatch({ type: 'ADD_ITEM', kind: 'slide', afterItemId: selectedItemId })}
          title="Add a Slide"
        >
          <span className="oi oi-slide" aria-hidden>▭</span>
          + Slide
        </button>
        <button
          className="outliner-add-btn"
          onClick={() => dispatch({ type: 'ADD_ITEM', kind: 'storyboard', afterItemId: selectedItemId })}
          title="Add a Storyboard"
        >
          <span className="oi oi-storyboard" aria-hidden>▦</span>
          + Storyboard
        </button>
      </div>
    </aside>
  );
}

type RowProps = {
  item: DocItem;
  index: number;
  selected: boolean;
  dispatch: React.Dispatch<Action>;
  canDelete: boolean;
};

function OutlinerRow({ item, index, selected, dispatch, canDelete }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };

  const label =
    item.kind === 'slide'
      ? item.slide.title.trim() || 'Untitled Slide'
      : (item.overrides?.name?.trim() ||
          `Storyboard · ${item.panels.length} panel${item.panels.length === 1 ? '' : 's'}`);

  const icon = item.kind === 'slide' ? '▭' : '▦';

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-outliner-item={item.id}
      className={`outliner-row ${selected ? 'is-selected' : ''} ${item.kind === 'slide' ? 'row-slide' : 'row-storyboard'}`}
      onClick={() => dispatch({ type: 'SELECT_ITEM', id: item.id })}
      {...attributes}
      {...listeners}
    >
      <div className="outliner-row-index">{String(index).padStart(2, '0')}</div>
      <div className="outliner-row-icon" aria-hidden>{icon}</div>
      <div className="outliner-row-label" title={label}>{label}</div>
      {canDelete && (
        <button
          className="outliner-row-remove"
          title={`Remove ${item.kind}`}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Remove this ${item.kind}? This can't be undone.`)) {
              dispatch({ type: 'REMOVE_ITEM', id: item.id });
            }
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
