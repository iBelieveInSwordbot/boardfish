import { useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { FONT_FAMILIES, PAGE_SIZES, PANEL_ASPECT_RATIOS, type ImageFit } from '../types';

type Props = { state: BoardfishState; dispatch: React.Dispatch<Action> };

/** Sections collapsible state kept locally; not part of project data. */
type OpenState = Record<string, boolean>;

const DEFAULT_OPEN: OpenState = {
  project: true,
  page: true,
  grid: true,
  panelAspect: true,
  theme: true,
  colors: false,
  fonts: false,
  fields: true,
  badges: true,
  footer: false,
  selected: true,
};

export function Inspector({ state, dispatch }: Props) {
  const s = state.settings;
  const [open, setOpen] = useState<OpenState>(DEFAULT_OPEN);
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const patch = (p: Partial<typeof s>) => dispatch({ type: 'UPDATE_SETTINGS', patch: p });
  const patchColors = (c: Partial<typeof s.colors>) => patch({ colors: { ...s.colors, ...c } });
  const patchFonts = (f: Partial<typeof s.fonts>) => patch({ fonts: { ...s.fonts, ...f } });
  const patchFooter = (f: Partial<typeof s.footer>) => patch({ footer: { ...s.footer, ...f } });
  const patchBadges = (b: Partial<typeof s.panelBadges>) => patch({ panelBadges: { ...s.panelBadges, ...b } });

  const logoRef = useRef<HTMLInputElement>(null);
  const selectedPanel = state.panels.find((p) => p.id === state.selectedPanelId);

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-title">Inspector</div>
      </div>
      <div className="inspector-body">
        <Section title="Project" openKey="project" open={open} toggle={toggle}>
          <Row label="Name">
            <input type="text" value={s.projectName} onChange={(e) => patch({ projectName: e.target.value })} />
          </Row>
        </Section>

        <Section title="Page Size" openKey="page" open={open} toggle={toggle}>
          <Row label="Preset">
            <select
              value={s.pageSize.name}
              onChange={(e) => {
                const found = PAGE_SIZES.find((p) => p.name === e.target.value);
                if (found) patch({ pageSize: found });
              }}
            >
              {PAGE_SIZES.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Width (px)">
            <input
              type="number"
              value={s.pageSize.widthPx}
              onChange={(e) => patch({ pageSize: { ...s.pageSize, widthPx: Number(e.target.value) || 1 } })}
            />
          </Row>
          <Row label="Height (px)">
            <input
              type="number"
              value={s.pageSize.heightPx}
              onChange={(e) => patch({ pageSize: { ...s.pageSize, heightPx: Number(e.target.value) || 1 } })}
            />
          </Row>
        </Section>

        <Section title="Grid" openKey="grid" open={open} toggle={toggle}>
          <Row label="Horizontal panels">
            <input
              type="number"
              min={1}
              max={12}
              value={s.panelsHorizontal}
              onChange={(e) => patch({ panelsHorizontal: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Row>
          <Row label="Vertical panels">
            <input
              type="number"
              min={1}
              max={12}
              value={s.panelsVertical}
              onChange={(e) => patch({ panelsVertical: Math.max(1, Number(e.target.value) || 1) })}
            />
          </Row>
          <Row label="Margin (px)">
            <input
              type="number"
              value={s.marginPx}
              onChange={(e) => patch({ marginPx: Number(e.target.value) || 0 })}
            />
          </Row>
          <Row label="Horizontal gutter (px)">
            <input
              type="number"
              value={s.gutterHorizontalPx}
              onChange={(e) => patch({ gutterHorizontalPx: Number(e.target.value) || 0 })}
            />
          </Row>
          <Row label="Vertical gutter (px)">
            <input
              type="number"
              value={s.gutterVerticalPx}
              onChange={(e) => patch({ gutterVerticalPx: Number(e.target.value) || 0 })}
            />
          </Row>
        </Section>

        <Section title="Panel Aspect Ratio" openKey="panelAspect" open={open} toggle={toggle}>
          <Row label="Preset">
            <select
              value={String(s.panelAspectRatio)}
              onChange={(e) => patch({ panelAspectRatio: Number(e.target.value), panelAspectLocked: false })}
            >
              <option value={String(s.panelAspectRatio)}>Current ({s.panelAspectRatio.toFixed(3)})</option>
              {PANEL_ASPECT_RATIOS.map((r) => (
                <option key={r.label} value={String(r.ratio)}>
                  {r.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Lock to 1st image">
            <input
              type="checkbox"
              checked={s.panelAspectLocked}
              onChange={(e) => patch({ panelAspectLocked: e.target.checked })}
            />
          </Row>
          <Row label="Image fit">
            <select value={s.imageFit} onChange={(e) => patch({ imageFit: e.target.value as ImageFit })}>
              <option value="fit">Fit (contain, letterbox)</option>
              <option value="fill">Fill (stretch)</option>
              <option value="crop">Crop (cover)</option>
            </select>
          </Row>
        </Section>

        <Section title="Theme" openKey="theme" open={open} toggle={toggle}>
          <div className="theme-buttons">
            <button className="theme-btn theme-btn-light" onClick={() => dispatch({ type: 'APPLY_THEME', theme: 'light' })}>
              Light layout
            </button>
            <button className="theme-btn theme-btn-dark" onClick={() => dispatch({ type: 'APPLY_THEME', theme: 'dark' })}>
              Dark layout
            </button>
          </div>
          <div className="theme-hint">Applies preset colors. Fine-tune below.</div>
        </Section>

        <Section title="Colors" openKey="colors" open={open} toggle={toggle}>
          <Row label="Canvas BG">
            <input type="color" value={s.colors.canvasBg} onChange={(e) => patchColors({ canvasBg: e.target.value })} />
          </Row>
          <Row label="Page BG">
            <input type="color" value={s.colors.pageBg} onChange={(e) => patchColors({ pageBg: e.target.value })} />
          </Row>
          <Row label="Panel BG">
            <input type="color" value={s.colors.panelBg} onChange={(e) => patchColors({ panelBg: e.target.value })} />
          </Row>
          <Row label="Field BG">
            <input type="color" value={s.colors.fieldBg} onChange={(e) => patchColors({ fieldBg: e.target.value })} />
          </Row>
          <Row label="Field text">
            <input type="color" value={s.colors.fieldText} onChange={(e) => patchColors({ fieldText: e.target.value })} />
          </Row>
          <Row label="Footer text">
            <input type="color" value={s.colors.text} onChange={(e) => patchColors({ text: e.target.value })} />
          </Row>
          <Row label="Panel label">
            <input
              type="color"
              value={s.colors.panelLabel}
              onChange={(e) => patchColors({ panelLabel: e.target.value })}
            />
          </Row>
          <Row label="Accent">
            <input type="color" value={s.colors.accent} onChange={(e) => patchColors({ accent: e.target.value })} />
          </Row>
        </Section>

        <Section title="Fonts" openKey="fonts" open={open} toggle={toggle}>
          <Row label="Family">
            <select value={s.fonts.family} onChange={(e) => patchFonts({ family: e.target.value })}>
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Caption Font Size">
            <input
              type="number"
              min={6}
              max={48}
              value={s.fonts.fieldSizePx}
              onChange={(e) => patchFonts({ fieldSizePx: Math.max(6, Number(e.target.value) || 13) })}
            />
          </Row>
          <Row label="Footer Font Size">
            <input
              type="number"
              min={6}
              max={48}
              value={s.fonts.footerSizePx}
              onChange={(e) => patchFonts({ footerSizePx: Math.max(6, Number(e.target.value) || 15) })}
            />
          </Row>
          <Row label="Panel Label Font Size">
            <input
              type="number"
              min={6}
              max={48}
              value={s.fonts.panelLabelSizePx}
              onChange={(e) => patchFonts({ panelLabelSizePx: Math.max(6, Number(e.target.value) || 10) })}
            />
          </Row>
        </Section>

        <Section title="Fields (all panels)" openKey="fields" open={open} toggle={toggle}>
          <div className="label-list">
            {s.labels.defaults.map((label) => (
              <div className="label-row" key={label}>
                <input
                  type="text"
                  defaultValue={label}
                  onBlur={(e) => {
                    const newLabel = e.target.value.trim();
                    if (newLabel && newLabel !== label) {
                      dispatch({ type: 'RENAME_FIELD_LABEL_GLOBAL', oldLabel: label, newLabel });
                    } else if (!newLabel) {
                      e.target.value = label;
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
                <button
                  title="Remove field from all panels"
                  onClick={() => dispatch({ type: 'REMOVE_FIELD_GLOBAL', label })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="add-label"
              onClick={() => {
                const label = prompt('New field label:');
                if (label && label.trim()) dispatch({ type: 'ADD_FIELD_GLOBAL', label: label.trim() });
              }}
            >
              + Add field
            </button>
          </div>
        </Section>

        <Section title="Panel labels" openKey="badges" open={open} toggle={toggle}>
          <div className="section-hint">Small text shown above each panel image.</div>
          <Row label="Show panel number (left)">
            <input
              type="checkbox"
              checked={s.panelBadges.showNumber}
              onChange={(e) => patchBadges({ showNumber: e.target.checked })}
            />
          </Row>
          <Row label="Prefix panel number">
            <input
              type="checkbox"
              checked={s.panelBadges.useNumberPrefix}
              onChange={(e) => patchBadges({ useNumberPrefix: e.target.checked })}
            />
          </Row>
          {s.panelBadges.useNumberPrefix && (
            <Row label="Number prefix text">
              <input
                type="text"
                value={s.panelBadges.numberPrefix}
                placeholder="Panel "
                onChange={(e) => patchBadges({ numberPrefix: e.target.value })}
              />
            </Row>
          )}
          <Row label="Show corner note (right)">
            <input
              type="checkbox"
              checked={s.panelBadges.showCornerNote}
              onChange={(e) => patchBadges({ showCornerNote: e.target.checked })}
            />
          </Row>
          <Row label="Prefix corner note">
            <input
              type="checkbox"
              checked={s.panelBadges.useCornerNotePrefix}
              onChange={(e) => patchBadges({ useCornerNotePrefix: e.target.checked })}
            />
          </Row>
          {s.panelBadges.useCornerNotePrefix && (
            <Row label="Note prefix text">
              <input
                type="text"
                value={s.panelBadges.cornerNotePrefix}
                placeholder="e.g. Note: "
                onChange={(e) => patchBadges({ cornerNotePrefix: e.target.value })}
              />
            </Row>
          )}
        </Section>

        <Section title="Footer & Logo" openKey="footer" open={open} toggle={toggle}>
          <Row label="Show project name">
            <input
              type="checkbox"
              checked={s.footer.showProjectName}
              onChange={(e) => patchFooter({ showProjectName: e.target.checked })}
            />
          </Row>
          <Row label="Show page number">
            <input
              type="checkbox"
              checked={s.footer.showPageNumber}
              onChange={(e) => patchFooter({ showPageNumber: e.target.checked })}
            />
          </Row>
          <Row label="Company logo">
            <div className="logo-controls">
              <input
                ref={logoRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const dataUrl = await new Promise<string>((resolve, reject) => {
                    const r = new FileReader();
                    r.onload = () => resolve(r.result as string);
                    r.onerror = () => reject(r.error);
                    r.readAsDataURL(file);
                  });
                  patchFooter({ logoDataUrl: dataUrl, logoAutoTheme: false });
                  if (logoRef.current) logoRef.current.value = '';
                }}
              />
              <button onClick={() => logoRef.current?.click()}>Choose…</button>
              {s.footer.logoDataUrl && (
                <button onClick={() => patchFooter({ logoDataUrl: null, logoAutoTheme: true })}>
                  Reset to default
                </button>
              )}
            </div>
          </Row>
          <Row label="Auto-switch logo">
            <input
              type="checkbox"
              checked={s.footer.logoAutoTheme}
              onChange={(e) => patchFooter({ logoAutoTheme: e.target.checked })}
            />
          </Row>
          <Row label={`Logo scale (${s.footer.logoScale.toFixed(2)}×)`}>
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.05}
              value={s.footer.logoScale}
              onChange={(e) => patchFooter({ logoScale: Number(e.target.value) })}
            />
          </Row>
        </Section>

        {selectedPanel && (
          <Section title="Selected panel" openKey="selected" open={open} toggle={toggle}>
            <div className="button-row">
              <button onClick={() => dispatch({ type: 'CUT_PANEL', id: selectedPanel.id })}>Cut</button>
              <button onClick={() => dispatch({ type: 'COPY_PANEL', id: selectedPanel.id })}>Copy</button>
              <button onClick={() => dispatch({ type: 'PASTE_PANEL' })} disabled={!state.clipboard}>
                Paste
              </button>
              <button onClick={() => dispatch({ type: 'DELETE_PANEL', id: selectedPanel.id })}>Delete</button>
            </div>
            <div className="hint">⌘X / ⌘C / ⌘V / Del also work when a panel is selected.</div>
          </Section>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  openKey,
  open,
  toggle,
  children,
}: {
  title: string;
  openKey: string;
  open: OpenState;
  toggle: (k: string) => void;
  children: React.ReactNode;
}) {
  const isOpen = open[openKey] ?? true;
  return (
    <div className={`section ${isOpen ? 'section-open' : 'section-closed'}`}>
      <button className="section-title" onClick={() => toggle(openKey)}>
        <span className="section-chevron">{isOpen ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
      {isOpen && <div className="section-body">{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className="row-control">{children}</span>
    </label>
  );
}
