// Freeform Keynote-style slide: an arbitrary number of draggable, resizable,
// styleable text boxes. Coordinates are stored as PERCENTAGES of the slide-body
// container so slides render correctly at any zoom or page size.
//
// v5 changes vs. v4:
//   - No more subtitle box; slides hold an array of text boxes instead.
//   - Selected box supports Cmd+C / Cmd+X / Cmd+V / Cmd+D and Option-drag to
//     duplicate. Backspace/Delete removes the selected box (no clipboard).
//   - A small "+ Text" button in the top-right of the slide body adds a new
//     empty text box.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type {
  ProjectSettings,
  Slide,
  SlideFontWeight,
  SlideTextAlign,
  SlideTextBox,
} from '../types';
import { SLIDE_FONT_FAMILIES, SLIDE_FONT_SIZES, SLIDE_FONT_WEIGHTS, cryptoRandomId, newDefaultTextBox } from '../types';
import type { Action } from '../store';

type Props = {
  slide: Slide;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

const MIN_WIDTH_PCT = 5;
const MIN_HEIGHT_PCT = 3;

// Module-level clipboard for slide text boxes. Shared across all Slide
// components so ⌘C on one slide can be ⌘V'd on another. Stores the box data
// sans id (id is minted at paste time).
let _slideClipboard: Omit<SlideTextBox, 'id'> | null = null;

/**
 * The container has `.slide-body` (100% of the page minus footer). Text boxes
 * are absolutely positioned inside it using percentages, so we do a single
 * bounding-rect measurement per drag/resize to convert pixels→percent.
 */
export function SlideView({ slide, settings, dispatch }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Deselect when clicking the empty part of the slide.
  const onBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSelectedId(null);
      setEditingId(null);
    }
  };

  // Cmd/Ctrl click OUTSIDE our container deselects too (matches Keynote feel).
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSelectedId(null);
        setEditingId(null);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // Escape exits edit mode, then exits selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editingId) {
        setEditingId(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (selectedId) {
        setSelectedId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editingId, selectedId]);

  const updateBox = useCallback(
    (textBoxId: string, patch: Partial<SlideTextBox>) => {
      dispatch({ type: 'UPDATE_SLIDE_TEXTBOX', slideId: slide.id, textBoxId, patch });
    },
    [dispatch, slide.id],
  );

  const activeBox = selectedId ? slide.textBoxes.find((b) => b.id === selectedId) ?? null : null;

  // Helper: given an existing box, produce a duplicate with a fresh id + a
  // small offset so the copy is visible.
  const duplicateBox = useCallback((source: SlideTextBox, offsetPct = 2): SlideTextBox => {
    const newX = Math.min(100 - source.width, Math.max(0, source.x + offsetPct));
    const newY = Math.min(100 - source.height, Math.max(0, source.y + offsetPct));
    return { ...source, id: cryptoRandomId(), x: newX, y: newY };
  }, []);

  // Clipboard/duplication keyboard shortcuts. Only active when a box is
  // selected AND we're not currently editing text inside a box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keys while typing in a contentEditable, input, or textarea.
      const target = e.target as HTMLElement | null;
      const isTypingIntoField =
        !!target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');
      if (isTypingIntoField) return;
      if (editingId) return;

      const meta = e.metaKey || e.ctrlKey;

      // Delete / Backspace: remove selected box (no clipboard write). Only when
      // a box is selected and we're not editing.
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId && !meta) {
        // Only act if the event is happening within our slide (avoid stealing
        // deletes from other UI). Cheapest heuristic: only act if our container
        // is on the page and the currently focused element isn't elsewhere.
        if (!containerRef.current) return;
        e.preventDefault();
        dispatch({ type: 'REMOVE_SLIDE_TEXTBOX', slideId: slide.id, textBoxId: selectedId });
        setSelectedId(null);
        return;
      }

      if (!meta) return;

      const key = e.key.toLowerCase();

      // ⌘C — copy selected box
      if (key === 'c' && selectedId && activeBox) {
        e.preventDefault();
        const { id: _drop, ...rest } = activeBox;
        void _drop;
        _slideClipboard = structuredCloneCompat(rest);
        return;
      }
      // ⌘X — cut selected box
      if (key === 'x' && selectedId && activeBox) {
        e.preventDefault();
        const { id: _drop, ...rest } = activeBox;
        void _drop;
        _slideClipboard = structuredCloneCompat(rest);
        dispatch({ type: 'REMOVE_SLIDE_TEXTBOX', slideId: slide.id, textBoxId: selectedId });
        setSelectedId(null);
        return;
      }
      // ⌘V — paste
      if (key === 'v' && _slideClipboard) {
        e.preventDefault();
        // Offset the pasted box a bit so it's visible if source was on this slide.
        const src = _slideClipboard;
        const newBox: SlideTextBox = {
          ...src,
          id: cryptoRandomId(),
          x: Math.min(100 - src.width, Math.max(0, src.x + 2)),
          y: Math.min(100 - src.height, Math.max(0, src.y + 2)),
        };
        dispatch({ type: 'ADD_SLIDE_TEXTBOX', slideId: slide.id, textBox: newBox });
        setSelectedId(newBox.id);
        return;
      }
      // ⌘D — duplicate selected box in place with +2% offset
      if (key === 'd' && selectedId && activeBox) {
        e.preventDefault();
        const dup = duplicateBox(activeBox);
        dispatch({ type: 'ADD_SLIDE_TEXTBOX', slideId: slide.id, textBox: dup });
        setSelectedId(dup.id);
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeBox, dispatch, duplicateBox, editingId, selectedId, slide.id]);

  const addNewTextBox = () => {
    const box: SlideTextBox = {
      ...newDefaultTextBox('Text'),
      x: 30,
      y: 30,
      width: 40,
      height: 15,
    };
    dispatch({ type: 'ADD_SLIDE_TEXTBOX', slideId: slide.id, textBox: box });
    setSelectedId(box.id);
    setEditingId(null);
  };

  /**
   * Alt-drag handler: when the user starts a move with the alt key held, we
   * duplicate the source box AT THE SAME COORDS and hand the drag off to the
   * newly-added clone. Returns the id to use for the drag; the SlideTextBoxView
   * will consult this via a callback prop.
   */
  const beginAltDuplicate = useCallback(
    (source: SlideTextBox): string => {
      const clone: SlideTextBox = { ...source, id: cryptoRandomId() };
      dispatch({ type: 'ADD_SLIDE_TEXTBOX', slideId: slide.id, textBox: clone });
      setSelectedId(clone.id);
      return clone.id;
    },
    [dispatch, slide.id],
  );

  return (
    <div
      ref={containerRef}
      className="slide-body slide-body-freeform"
      onPointerDown={onBackgroundPointerDown}
    >
      {slide.textBoxes.map((box) => (
        <SlideTextBoxView
          key={box.id}
          box={box}
          containerRef={containerRef}
          selected={selectedId === box.id}
          editing={editingId === box.id}
          onSelect={() => setSelectedId(box.id)}
          onBeginEdit={() => {
            setSelectedId(box.id);
            setEditingId(box.id);
          }}
          onEndEdit={() => setEditingId(null)}
          onChange={(patch) => updateBox(box.id, patch)}
          onAltDuplicate={beginAltDuplicate}
        />
      ))}

      {selectedId && activeBox && (
        <FloatingToolbar
          box={activeBox}
          onChange={(patch) => updateBox(activeBox.id, patch)}
          settings={settings}
          containerRef={containerRef}
        />
      )}

      <button
        type="button"
        className="slide-body-add-textbox"
        onClick={(e) => {
          e.stopPropagation();
          addNewTextBox();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Add text box"
      >
        + Text
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single text box
// ---------------------------------------------------------------------------

type TextBoxProps = {
  box: SlideTextBox;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onChange: (patch: Partial<SlideTextBox>) => void;
  /**
   * Alt-drag: when a move drag starts with the alt key held, the parent
   * duplicates the source box in-place and returns the *new* box id so the
   * drag continues on the clone (leaving the original untouched).
   */
  onAltDuplicate: (source: SlideTextBox) => string;
};

type ResizeHandleId = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

type DragMode =
  | {
      kind: 'move';
      startX: number;
      startY: number;
      boxX: number;
      boxY: number;
      /** id of the box actually being moved (may be a freshly-cloned alt-drag copy) */
      targetId: string;
    }
  | {
      kind: 'resize';
      handle: ResizeHandleId;
      startX: number;
      startY: number;
      boxX: number;
      boxY: number;
      boxW: number;
      boxH: number;
      shift: boolean;
      aspect: number;
    };

function SlideTextBoxView(props: TextBoxProps) {
  const { box, containerRef, selected, editing, onSelect, onBeginEdit, onEndEdit, onChange, onAltDuplicate } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragMode | null>(null);

  // Move: pointer down on the box (not on handles, not in edit mode).
  const beginMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    // Option/Alt held at drag-start: duplicate this box in place and reassign
    // the drag target to the newly-added clone. Original stays put.
    if (e.altKey) {
      const newId = onAltDuplicate(box);
      dragRef.current = {
        kind: 'move',
        startX: e.clientX,
        startY: e.clientY,
        boxX: box.x,
        boxY: box.y,
        targetId: newId,
      };
      // Selection follows the clone (onAltDuplicate already set it, but be explicit).
      e.stopPropagation();
      return;
    }

    dragRef.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      targetId: box.id,
    };
    onSelect();
    e.stopPropagation();
  };

  const beginResize = (e: ReactPointerEvent<HTMLDivElement>, handle: ResizeHandleId) => {
    if (editing) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: 'resize',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.width,
      boxH: box.height,
      shift: e.shiftKey,
      aspect: box.width / Math.max(0.0001, box.height),
    };
    onSelect();
    e.stopPropagation();
  };

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dxPct = ((e.clientX - drag.startX) / rect.width) * 100;
      const dyPct = ((e.clientY - drag.startY) / rect.height) * 100;

      if (drag.kind === 'move') {
        // If we're alt-dragging, the drag target is a different box id than
        // `box`. In that case, only forward the update if this instance owns
        // the target id — otherwise we'd corrupt the source box's coords.
        if (drag.targetId !== box.id) return;
        const newX = clamp(drag.boxX + dxPct, 0, 100 - box.width);
        const newY = clamp(drag.boxY + dyPct, 0, 100 - box.height);
        onChange({ x: newX, y: newY });
        return;
      }

      // resize
      const shift = drag.shift || e.shiftKey;
      const { boxX, boxY, boxW, boxH } = drag;
      let newX = boxX;
      let newY = boxY;
      let newW = boxW;
      let newH = boxH;

      const handle = drag.handle;
      if (handle.includes('e')) newW = boxW + dxPct;
      if (handle.includes('w')) {
        newW = boxW - dxPct;
        newX = boxX + dxPct;
      }
      if (handle.includes('s')) newH = boxH + dyPct;
      if (handle.includes('n')) {
        newH = boxH - dyPct;
        newY = boxY + dyPct;
      }

      if (shift && (handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se')) {
        newH = newW / drag.aspect;
        if (handle.includes('n')) newY = boxY + (boxH - newH);
      }

      newW = Math.max(MIN_WIDTH_PCT, Math.min(newW, 100));
      newH = Math.max(MIN_HEIGHT_PCT, Math.min(newH, 100));
      newX = clamp(newX, 0, 100 - newW);
      newY = clamp(newY, 0, 100 - newH);

      onChange({ x: newX, y: newY, width: newW, height: newH });
    },
    [box.id, box.width, box.height, containerRef, onChange],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const style: CSSProperties = {
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  };

  const innerStyle: CSSProperties = {
    fontFamily: box.fontFamily,
    fontSize: `${box.fontSize}px`,
    fontWeight: box.fontWeight,
    textAlign: box.textAlign,
    fontStyle: box.italic ? 'italic' : 'normal',
    color: box.color,
  };

  const isEmpty = box.text.trim().length === 0;
  const placeholder = 'Text';

  return (
    <div
      ref={boxRef}
      className={`slide-textbox ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`}
      style={style}
      onPointerDown={beginMove}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onBeginEdit();
      }}
    >
      <div className="slide-textbox-frame" />

      <div
        ref={editableRef}
        className={`slide-textbox-content ${isEmpty && !editing ? 'is-placeholder' : ''}`}
        style={innerStyle}
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={editing}
        onPointerDown={(e) => {
          if (editing) e.stopPropagation();
        }}
        onBlur={(e) => {
          const next = (e.currentTarget as HTMLDivElement).innerText;
          if (next !== box.text) onChange({ text: next });
          onEndEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
      >
        {editing ? box.text : isEmpty ? placeholder : box.text}
      </div>

      {selected && !editing && (
        <>
          <ResizeHandle position="nw" onPointerDown={(e) => beginResize(e, 'nw')} />
          <ResizeHandle position="n" onPointerDown={(e) => beginResize(e, 'n')} />
          <ResizeHandle position="ne" onPointerDown={(e) => beginResize(e, 'ne')} />
          <ResizeHandle position="e" onPointerDown={(e) => beginResize(e, 'e')} />
          <ResizeHandle position="se" onPointerDown={(e) => beginResize(e, 'se')} />
          <ResizeHandle position="s" onPointerDown={(e) => beginResize(e, 's')} />
          <ResizeHandle position="sw" onPointerDown={(e) => beginResize(e, 'sw')} />
          <ResizeHandle position="w" onPointerDown={(e) => beginResize(e, 'w')} />
        </>
      )}
    </div>
  );
}

type HandlePos = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function ResizeHandle({
  position,
  onPointerDown,
}: {
  position: HandlePos;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`slide-textbox-handle slide-textbox-handle-${position}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown(e);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------------------
// Floating inspector toolbar (Keynote-style, sits above the selected box)
// ---------------------------------------------------------------------------

type ToolbarProps = {
  box: SlideTextBox;
  onChange: (patch: Partial<SlideTextBox>) => void;
  settings: ProjectSettings;
  containerRef: React.RefObject<HTMLDivElement | null>;
};

function FloatingToolbar({ box, onChange }: ToolbarProps) {
  const centerX = box.x + box.width / 2;
  const dropBelow = box.y < 8;
  const toolbarStyle: CSSProperties = {
    left: `${centerX}%`,
    top: dropBelow ? `${box.y + box.height}%` : `${box.y}%`,
    transform: dropBelow ? 'translate(-50%, 8px)' : 'translate(-50%, calc(-100% - 8px))',
  };

  return (
    <div
      className="slide-textbox-toolbar"
      style={toolbarStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <select
        className="slide-textbox-toolbar-select"
        value={box.fontFamily}
        onChange={(e) => onChange({ fontFamily: e.target.value })}
        title="Font family"
      >
        {SLIDE_FONT_FAMILIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      <div className="slide-textbox-toolbar-size">
        <button
          className="slide-textbox-toolbar-btn"
          onClick={() =>
            onChange({ fontSize: Math.max(4, Math.round(box.fontSize - stepFor(box.fontSize))) })
          }
          title="Decrease size"
        >
          −
        </button>
        <input
          className="slide-textbox-toolbar-size-input"
          type="number"
          min={4}
          max={512}
          step={1}
          value={box.fontSize}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) onChange({ fontSize: Math.max(4, Math.min(512, n)) });
          }}
        />
        <button
          className="slide-textbox-toolbar-btn"
          onClick={() =>
            onChange({ fontSize: Math.min(512, Math.round(box.fontSize + stepFor(box.fontSize))) })
          }
          title="Increase size"
        >
          +
        </button>
        <select
          className="slide-textbox-toolbar-size-preset"
          value=""
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n)) onChange({ fontSize: n });
          }}
          title="Preset sizes"
        >
          <option value="">…</option>
          {SLIDE_FONT_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <select
        className="slide-textbox-toolbar-select"
        value={box.fontWeight}
        onChange={(e) => onChange({ fontWeight: parseInt(e.target.value, 10) as SlideFontWeight })}
        title="Weight"
      >
        {SLIDE_FONT_WEIGHTS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>

      <button
        className={`slide-textbox-toolbar-btn ${box.italic ? 'is-active' : ''}`}
        onClick={() => onChange({ italic: !box.italic })}
        title="Italic"
        style={{ fontStyle: 'italic', fontFamily: 'Georgia, serif' }}
      >
        I
      </button>

      <div className="slide-textbox-toolbar-align">
        {(['left', 'center', 'right'] as SlideTextAlign[]).map((a) => (
          <button
            key={a}
            className={`slide-textbox-toolbar-btn ${box.textAlign === a ? 'is-active' : ''}`}
            onClick={() => onChange({ textAlign: a })}
            title={`Align ${a}`}
          >
            {a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'}
          </button>
        ))}
      </div>

      <label className="slide-textbox-toolbar-color" title="Text color">
        <span
          className="slide-textbox-toolbar-color-swatch"
          style={{ background: box.color }}
        />
        <input
          type="color"
          value={box.color}
          onChange={(e) => onChange({ color: e.target.value })}
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function stepFor(size: number): number {
  if (size < 20) return 1;
  if (size < 48) return 2;
  if (size < 96) return 4;
  return 8;
}

function structuredCloneCompat<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
