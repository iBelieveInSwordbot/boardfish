/**
 * StyleTagsPopup
 *
 * Replaces the horizontal grid of ~8 "style" buttons that used to sit
 * inline in the AI Director and Panel AI editor. It's a single pill
 * button that opens a portal-mounted popup listing the style presets.
 *
 * Pattern mirrors TileMoreMenu in ProjectsDashboard:
 *  - Portal to <body> so no parent overflow clips it
 *  - `position: fixed` anchored to the trigger's bounding rect
 *  - Click-outside + Escape dismiss
 *  - Scroll / resize collapses the menu (cheaper than re-positioning)
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type StyleTag = { key: string; label: string; tag?: string };

type Props = {
  /** Ordered list of style presets to show. */
  styles: StyleTag[];
  /** Currently selected key. Falls back to first if not found. */
  value: string;
  onChange: (nextKey: string) => void;
  /** Optional label rendered above the button (e.g. "Visual style"). */
  label?: string;
  /** Compact = smaller pill (Panel editor uses this). */
  compact?: boolean;
  /** Trigger title/tooltip. */
  title?: string;
  /** aria-label override for the trigger. */
  ariaLabel?: string;
};

export function StyleTagsPopup({
  styles,
  value,
  onChange,
  label,
  compact = false,
  title,
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = styles.find((s) => s.key === value) || styles[0];

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Menu width: at least the button, capped so long tag names still fit.
    const menuWidth = Math.max(r.width, 220);
    // Prefer opening below; if there's no room below, flip above.
    const spaceBelow = window.innerHeight - r.bottom;
    const menuHeightEstimate = Math.min(styles.length * 34 + 12, 320);
    const top = spaceBelow >= menuHeightEstimate + 8
      ? r.bottom + 4
      : Math.max(8, r.top - menuHeightEstimate - 4);
    setPos({ top, left: r.left, width: menuWidth });
  }, [open, styles.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const btnClass = compact ? 'style-tags-btn compact' : 'style-tags-btn';

  return (
    <div className="style-tags-popup">
      {label && <label className="ai-label">{label}</label>}
      <button
        ref={btnRef}
        type="button"
        className={`${btnClass}${open ? ' is-open' : ''}`}
        title={title || selected?.tag || 'Pick a style'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel || 'Style tag picker'}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="style-tags-btn-label">{selected?.label || 'Style…'}</span>
        <span className="style-tags-caret" aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="style-tags-menu"
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            minWidth: pos.width,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {styles.map((s) => {
            const active = s.key === value;
            return (
              <button
                key={s.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`style-tags-menu-item${active ? ' active' : ''}`}
                title={s.tag || 'No style directive appended'}
                onClick={() => {
                  onChange(s.key);
                  setOpen(false);
                }}
              >
                <span className="style-tags-menu-check">{active ? '✓' : ''}</span>
                <span className="style-tags-menu-label">{s.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
