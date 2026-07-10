// Freeform Keynote-style section title slide: two draggable, resizable, styleable
// text boxes. No image UI. Coordinates are stored as PERCENTAGES of the slide-body
// container so slides render correctly at any zoom or page size.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type {
  ProjectSettings,
  Slide,
  SlideFontWeight,
  SlideTextAlign,
  SlideTextBox,
} from '../types';
import { SLIDE_FONT_FAMILIES, SLIDE_FONT_SIZES, SLIDE_FONT_WEIGHTS } from '../types';
import type { Action } from '../store';

type Props = {
  slide: Slide;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
};

type Which = 'title' | 'subtitle';

const MIN_WIDTH_PCT = 5;
const MIN_HEIGHT_PCT = 3;

/**
 * The container has `.slide-body` (100% of the page minus footer). Text boxes
 * are absolutely positioned inside it using percentages, so we do a single
 * bounding-rect measurement per drag/resize to convert pixels→percent.
 */
export function SlideView({ slide, settings, dispatch }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Which | null>(null);
  const [editing, setEditing] = useState<Which | null>(null);

  // Deselect when clicking the empty part of the slide.
  const onBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSelected(null);
      setEditing(null);
    }
  };

  // Cmd/Ctrl click anywhere in the app deselects too (spec).
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // If the click landed outside our container, drop selection.
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setSelected(null);
        setEditing(null);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // Escape exits edit mode, then exits selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editing) {
        setEditing(null);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (selected) {
        setSelected(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, selected]);

  const updateBox = useCallback(
    (which: Which, patch: Partial<SlideTextBox>) => {
      dispatch({ type: 'UPDATE_SLIDE_TEXTBOX', slideId: slide.id, which, patch });
    },
    [dispatch, slide.id],
  );

  const activeBox = selected ? (selected === 'title' ? slide.titleBox : slide.subtitleBox) : null;

  return (
    <div
      ref={containerRef}
      className="slide-body slide-body-freeform"
      onPointerDown={onBackgroundPointerDown}
    >
      <SlideTextBoxView
        which="title"
        box={slide.titleBox}
        containerRef={containerRef}
        selected={selected === 'title'}
        editing={editing === 'title'}
        onSelect={() => setSelected('title')}
        onBeginEdit={() => {
          setSelected('title');
          setEditing('title');
        }}
        onEndEdit={() => setEditing(null)}
        onChange={(patch) => updateBox('title', patch)}
      />
      <SlideTextBoxView
        which="subtitle"
        box={slide.subtitleBox}
        containerRef={containerRef}
        selected={selected === 'subtitle'}
        editing={editing === 'subtitle'}
        onSelect={() => setSelected('subtitle')}
        onBeginEdit={() => {
          setSelected('subtitle');
          setEditing('subtitle');
        }}
        onEndEdit={() => setEditing(null)}
        onChange={(patch) => updateBox('subtitle', patch)}
      />

      {selected && activeBox && (
        <FloatingToolbar
          box={activeBox}
          onChange={(patch) => updateBox(selected, patch)}
          settings={settings}
          containerRef={containerRef}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single text box
// ---------------------------------------------------------------------------

type TextBoxProps = {
  which: Which;
  box: SlideTextBox;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selected: boolean;
  editing: boolean;
  onSelect: () => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onChange: (patch: Partial<SlideTextBox>) => void;
};

type ResizeHandleId = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

type DragMode =
  | { kind: 'move'; startX: number; startY: number; boxX: number; boxY: number }
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
  const { box, containerRef, selected, editing, onSelect, onBeginEdit, onEndEdit, onChange } = props;
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
    dragRef.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      boxX: box.x,
      boxY: box.y,
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
        const newX = clamp(drag.boxX + dxPct, 0, 100 - box.width);
        const newY = clamp(drag.boxY + dyPct, 0, 100 - box.height);
        onChange({ x: newX, y: newY });
        return;
      }

      // resize
      const shift = drag.shift || e.shiftKey;
      let { boxX, boxY, boxW, boxH } = drag;
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
        // Preserve aspect ratio: pick the larger of the two deltas (in % of container)
        // and derive the other. Simpler: lock height off of width.
        newH = newW / drag.aspect;
        if (handle.includes('n')) newY = boxY + (boxH - newH);
      }

      // Clamp: keep the min sizes and keep the box on-screen.
      newW = Math.max(MIN_WIDTH_PCT, Math.min(newW, 100));
      newH = Math.max(MIN_HEIGHT_PCT, Math.min(newH, 100));
      newX = clamp(newX, 0, 100 - newW);
      newY = clamp(newY, 0, 100 - newH);

      onChange({ x: newX, y: newY, width: newW, height: newH });
    },
    [box.width, box.height, containerRef, onChange],
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

  // Focus + select-all when entering edit mode
  useLayoutEffect(() => {
    if (!editing) return;
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    // Select all text on entry so a quick retype replaces the placeholder
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
  const placeholder = props.which === 'title' ? 'Section Title' : 'Subtitle (optional)';

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
      {/* Selection frame (drawn behind text so it doesn't interfere with editing). */}
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
        // Stop bubbling FIRST so the text-box's move-handler never fires
        // for this pointer down. `beginResize` is expected to also call
        // stopPropagation (harmless if it does).
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
  // Position: horizontally centered on the box, sitting just above it. If the
  // box hugs the top of the slide, we drop it just below instead.
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

// +/- step scales with current size so nudging feels natural at both 12px and 128px.
function stepFor(size: number): number {
  if (size < 20) return 1;
  if (size < 48) return 2;
  if (size < 96) return 4;
  return 8;
}
