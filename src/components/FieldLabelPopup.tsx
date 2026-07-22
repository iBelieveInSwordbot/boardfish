/**
 * FieldLabelPopup + FieldPresetPopup
 *
 * Sibling popup components for the text-prompt node inspector, built with
 * the same portal-menu pattern as TileMoreMenu (fixed positioning, click-
 * outside, Escape close, scroll dismiss).
 *
 * FieldLabelPopup:
 *   Click the label to open a dropdown of fixed labels + an "Enter custom
 *   label…" option that falls back to a text input.
 *
 * FieldPresetPopup:
 *   Shown next to a field when its label has a curated preset group. Same
 *   auto-fill mechanic as the legacy preset-text field: picking an option
 *   writes its resolved value into the textarea.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FIXED_FIELD_LABELS } from '../nodes/prompt-field-labels';
import {
  PRESET_GROUPS,
  normalizePresetOptions,
  type PresetGroupId,
} from '../nodes/text-prompt-fields';

type LabelPopupProps = {
  value: string;
  onChange: (nextLabel: string) => void;
};

export function FieldLabelPopup({ value, onChange }: LabelPopupProps) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState(value);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const menuWidth = Math.max(r.width, 230);
    const spaceBelow = window.innerHeight - r.bottom;
    const menuHeightEstimate = Math.min(FIXED_FIELD_LABELS.length * 30 + 60, 380);
    const top = spaceBelow >= menuHeightEstimate + 8
      ? r.bottom + 4
      : Math.max(8, r.top - menuHeightEstimate - 4);
    setPos({ top, left: r.left, width: menuWidth });
  }, [open, customMode]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
      setCustomMode(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setCustomMode(false); }
    };
    const onScroll = () => { setOpen(false); setCustomMode(false); };
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

  useEffect(() => {
    if (customMode && customInputRef.current) {
      customInputRef.current.focus();
      customInputRef.current.select();
    }
  }, [customMode]);

  const commitCustom = () => {
    const v = customText.trim();
    if (v.length > 0) onChange(v);
    setOpen(false);
    setCustomMode(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tpv2-field-label-btn${open ? ' is-open' : ''}`}
        title="Rename field"
        onClick={(e) => {
          e.stopPropagation();
          setCustomText(value);
          setCustomMode(false);
          setOpen((v) => !v);
        }}
      >
        <span className="tpv2-field-label-btn-text">{value || 'Untitled'}</span>
        <span className="tpv2-field-label-btn-caret" aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="tpv2-label-menu"
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            minWidth: pos.width,
          }}
        >
          {customMode ? (
            <div className="tpv2-label-menu-custom">
              <input
                ref={customInputRef}
                className="tpv2-label-menu-custom-input"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitCustom(); }
                  if (e.key === 'Escape') { setOpen(false); setCustomMode(false); }
                }}
                placeholder="Type a label…"
              />
              <div className="tpv2-label-menu-custom-actions">
                <button
                  type="button"
                  className="tpv2-label-menu-btn secondary"
                  onClick={() => setCustomMode(false)}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="tpv2-label-menu-btn primary"
                  onClick={commitCustom}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              {FIXED_FIELD_LABELS.map((entry) => {
                const active = entry.label === value;
                return (
                  <button
                    key={entry.label}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`tpv2-label-menu-item${active ? ' active' : ''}`}
                    onClick={() => { onChange(entry.label); setOpen(false); }}
                  >
                    <span className="tpv2-label-menu-check">{active ? '✓' : ''}</span>
                    <span className="tpv2-label-menu-label">{entry.label}</span>
                    {entry.presetGroup && (
                      <span className="tpv2-label-menu-badge" title="Has curated presets">◆</span>
                    )}
                  </button>
                );
              })}
              <div className="tpv2-label-menu-sep" />
              <button
                type="button"
                className="tpv2-label-menu-item"
                onClick={() => {
                  setCustomText(value);
                  setCustomMode(true);
                }}
              >
                <span className="tpv2-label-menu-check" />
                <span className="tpv2-label-menu-label">Enter custom label…</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

type PresetPopupProps = {
  presetGroup: PresetGroupId;
  currentValue: string;
  onPick: (nextValue: string) => void;
};

export function FieldPresetPopup({ presetGroup, currentValue, onPick }: PresetPopupProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const opts = useMemo(
    () => normalizePresetOptions(PRESET_GROUPS[presetGroup]?.options ?? []),
    [presetGroup],
  );

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Style Tags list is tall; give the menu a real width so long labels
    // don't wrap awkwardly. Cap so it never spills off narrow screens.
    const menuWidth = Math.min(320, Math.max(r.width, 260));
    const spaceBelow = window.innerHeight - r.bottom;
    const menuHeightEstimate = Math.min(opts.length * 30 + 12, 420);
    const top = spaceBelow >= menuHeightEstimate + 8
      ? r.bottom + 4
      : Math.max(8, r.top - menuHeightEstimate - 4);
    setPos({ top, left: r.left, width: menuWidth });
  }, [open, opts.length]);

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tpv2-preset-btn${open ? ' is-open' : ''}`}
        title={`Pick a preset (${PRESET_GROUPS[presetGroup]?.label ?? presetGroup})`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        Presets ▾
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="tpv2-preset-menu"
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: pos.width,
          }}
        >
          {opts.map((o, i) => {
            if (o.heading) {
              return (
                <div key={`h-${i}`} className="tpv2-preset-menu-heading">{o.label}</div>
              );
            }
            const active = currentValue === o.value;
            return (
              <button
                key={`o-${i}`}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`tpv2-preset-menu-item${active ? ' active' : ''}`}
                title={o.value !== o.label ? o.value : undefined}
                onClick={() => { onPick(o.value); setOpen(false); }}
              >
                <span className="tpv2-preset-menu-check">{active ? '✓' : ''}</span>
                <span className="tpv2-preset-menu-label">{o.label}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
