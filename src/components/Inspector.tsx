// Inspector: two tabs — Global (project-wide defaults) and Item (selected slide / storyboard override / panel).

import { useEffect, useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { resolveStoryboardSettings } from '../store';
import { FONT_FAMILIES, PAGE_SIZES, PANEL_ASPECT_RATIOS, type ImageFit } from '../types';

type Props = { state: BoardfishState; dispatch: React.Dispatch<Action> };

type OpenState = Record<string, boolean>;
const DEFAULT_OPEN_GLOBAL: OpenState = {
  project: true,
  page: true,
  gridGlobal: true,
  panelAspectGlobal: true,
  theme: true,
  colors: false,
  fonts: false,
  fieldsGlobal: true,
  badges: true,
  footer: false,
};
const DEFAULT_OPEN_ITEM: OpenState = {
  gridItem: true,
  panelAspectItem: true,
  fieldsItem: true,
  slide: true,
  panel: true,
};

export function Inspector({ state, dispatch }: Props) {
  // Primary selection (first in multi-select) drives the Inspector item tab context
  const primaryId = state.selectedPanelIds[0] ?? null;
  const selectedCount = state.selectedPanelIds.length;
  const selectedPanel = state.items
    .flatMap((it) => (it.kind === 'storyboard' ? it.panels : []))
    .find((p) => p.id === primaryId);
  const selectedItem = state.items.find((it) => it.id === state.selectedItemId);
  const contextStoryboard = (() => {
    if (primaryId) {
      for (const it of state.items) {
        if (it.kind === 'storyboard' && it.panels.some((p) => p.id === primaryId)) return it;
      }
    }
    if (selectedItem && selectedItem.kind === 'storyboard') return selectedItem;
    return null;
  })();
  const contextSlide = selectedItem && selectedItem.kind === 'slide' ? selectedItem : null;
  const itemTabAvailable = Boolean(contextStoryboard || contextSlide || selectedPanel);

  const [tab, setTab] = useState<'global' | 'item'>('global');
  useEffect(() => {
    // Auto-switch to Item tab when the user selects a panel; leave alone otherwise so global-editing flow isn't disrupted
    if (primaryId) setTab('item');
  }, [primaryId]);
  const [globalOpen, setGlobalOpen] = useState<OpenState>(DEFAULT_OPEN_GLOBAL);
  const [itemOpen, setItemOpen] = useState<OpenState>(DEFAULT_OPEN_ITEM);
  const toggleGlobal = (k: string) => setGlobalOpen((o) => ({ ...o, [k]: !o[k] }));
  const toggleItem = (k: string) => setItemOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <aside className="inspector">
      <div className="inspector-tabs2">
        <button
          className={tab === 'global' ? 'active' : ''}
          onClick={() => setTab('global')}
          title="Project-wide defaults"
        >
          Global
        </button>
        <button
          className={tab === 'item' ? 'active' : ''}
          onClick={() => setTab('item')}
          disabled={!itemTabAvailable}
          title={itemTabAvailable ? 'Selected item overrides' : 'Select a slide, storyboard, or panel'}
        >
          {contextSlide ? 'Slide' : contextStoryboard ? 'Storyboard' : 'Item'}
        </button>
      </div>
      <div className="inspector-body">
        {tab === 'global' ? (
          <GlobalTab state={state} dispatch={dispatch} open={globalOpen} toggle={toggleGlobal} />
        ) : (
          <ItemTab
            state={state}
            dispatch={dispatch}
            storyboard={contextStoryboard}
            slide={contextSlide}
            selectedPanel={selectedPanel}
            selectedCount={selectedCount}
            open={itemOpen}
            toggle={toggleItem}
          />
        )}
      </div>
    </aside>
  );
}

// ---- Global tab ---------------------------------------------------------

function GlobalTab({
  state,
  dispatch,
  open,
  toggle,
}: {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  open: OpenState;
  toggle: (k: string) => void;
}) {
  const s = state.settings;
  const patch = (p: Partial<typeof s>) => dispatch({ type: 'UPDATE_SETTINGS', patch: p });
  const patchColors = (c: Partial<typeof s.colors>) => patch({ colors: { ...s.colors, ...c } });
  const patchFonts = (f: Partial<typeof s.fonts>) => patch({ fonts: { ...s.fonts, ...f } });
  const patchFooter = (f: Partial<typeof s.footer>) => patch({ footer: { ...s.footer, ...f } });
  const patchBadges = (b: Partial<typeof s.panelBadges>) => patch({ panelBadges: { ...s.panelBadges, ...b } });
  const logoRef = useRef<HTMLInputElement>(null);

  return (
    <div>
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

      <Section title="Grid (default)" openKey="gridGlobal" open={open} toggle={toggle}>
        <div className="section-hint">Applies to storyboards without their own grid override.</div>
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
          <input type="number" value={s.marginPx} onChange={(e) => patch({ marginPx: Number(e.target.value) || 0 })} />
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

      <Section title="Panel Aspect Ratio (default)" openKey="panelAspectGlobal" open={open} toggle={toggle}>
        <div className="section-hint">Applies to storyboards without their own aspect override.</div>
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
        <Row label="Canvas BG"><input type="color" value={s.colors.canvasBg} onChange={(e) => patchColors({ canvasBg: e.target.value })} /></Row>
        <Row label="Page BG"><input type="color" value={s.colors.pageBg} onChange={(e) => patchColors({ pageBg: e.target.value })} /></Row>
        <Row label="Panel BG"><input type="color" value={s.colors.panelBg} onChange={(e) => patchColors({ panelBg: e.target.value })} /></Row>
        <Row label="Field BG"><input type="color" value={s.colors.fieldBg} onChange={(e) => patchColors({ fieldBg: e.target.value })} /></Row>
        <Row label="Field text"><input type="color" value={s.colors.fieldText} onChange={(e) => patchColors({ fieldText: e.target.value })} /></Row>
        <Row label="Footer text"><input type="color" value={s.colors.text} onChange={(e) => patchColors({ text: e.target.value })} /></Row>
        <Row label="Panel label"><input type="color" value={s.colors.panelLabel} onChange={(e) => patchColors({ panelLabel: e.target.value })} /></Row>
        <Row label="Accent"><input type="color" value={s.colors.accent} onChange={(e) => patchColors({ accent: e.target.value })} /></Row>
      </Section>

      <Section title="Fonts" openKey="fonts" open={open} toggle={toggle}>
        <Row label="Family">
          <select value={s.fonts.family} onChange={(e) => patchFonts({ family: e.target.value })}>
            {FONT_FAMILIES.map((f) => (<option key={f.label} value={f.value}>{f.label}</option>))}
          </select>
        </Row>
        <Row label="Caption Font Size">
          <div className="size-and-style">
            <input type="number" min={6} max={48} value={s.fonts.fieldSizePx}
              onChange={(e) => patchFonts({ fieldSizePx: Math.max(6, Number(e.target.value) || 13) })} />
            <button className={`style-chip ${s.fonts.captionBold ? 'active' : ''}`} onClick={() => patchFonts({ captionBold: !s.fonts.captionBold })} title="Bold"><b>B</b></button>
            <button className={`style-chip ${s.fonts.captionItalic ? 'active' : ''}`} onClick={() => patchFonts({ captionItalic: !s.fonts.captionItalic })} title="Italic"><i>I</i></button>
          </div>
        </Row>
        <Row label="Footer Font Size">
          <div className="size-and-style">
            <input type="number" min={6} max={48} value={s.fonts.footerSizePx}
              onChange={(e) => patchFonts({ footerSizePx: Math.max(6, Number(e.target.value) || 15) })} />
            <button className={`style-chip ${s.fonts.footerBold ? 'active' : ''}`} onClick={() => patchFonts({ footerBold: !s.fonts.footerBold })} title="Bold"><b>B</b></button>
            <button className={`style-chip ${s.fonts.footerItalic ? 'active' : ''}`} onClick={() => patchFonts({ footerItalic: !s.fonts.footerItalic })} title="Italic"><i>I</i></button>
          </div>
        </Row>
        <Row label="Panel Label Font Size">
          <div className="size-and-style">
            <input type="number" min={6} max={48} value={s.fonts.panelLabelSizePx}
              onChange={(e) => patchFonts({ panelLabelSizePx: Math.max(6, Number(e.target.value) || 10) })} />
            <button className={`style-chip ${s.fonts.panelLabelBold ? 'active' : ''}`} onClick={() => patchFonts({ panelLabelBold: !s.fonts.panelLabelBold })} title="Bold"><b>B</b></button>
            <button className={`style-chip ${s.fonts.panelLabelItalic ? 'active' : ''}`} onClick={() => patchFonts({ panelLabelItalic: !s.fonts.panelLabelItalic })} title="Italic"><i>I</i></button>
          </div>
        </Row>
      </Section>

      <Section title="Fields (default)" openKey="fieldsGlobal" open={open} toggle={toggle}>
        <div className="section-hint">Applies to storyboards without their own field override.</div>
        <div className="label-list">
          {s.labels.defaults.map((label) => (
            <div className="label-row" key={label}>
              <input
                type="text"
                defaultValue={label}
                onBlur={(e) => {
                  const nl = e.target.value.trim();
                  if (nl && nl !== label) dispatch({ type: 'RENAME_FIELD_LABEL_GLOBAL', oldLabel: label, newLabel: nl });
                  else if (!nl) e.target.value = label;
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <button title="Remove field" onClick={() => dispatch({ type: 'REMOVE_FIELD_GLOBAL', label })}>✕</button>
            </div>
          ))}
          <button className="add-label" onClick={() => {
            const label = prompt('New field label:');
            if (label && label.trim()) dispatch({ type: 'ADD_FIELD_GLOBAL', label: label.trim() });
          }}>+ Add field</button>
        </div>
      </Section>

      <Section title="Panel labels" openKey="badges" open={open} toggle={toggle}>
        <Row label="Numbering">
          <select
            value={s.panelNumbering}
            onChange={(e) => patch({ panelNumbering: e.target.value as 'continuous' | 'per-storyboard' })}
          >
            <option value="continuous">Continuous (across doc)</option>
            <option value="per-storyboard">Reset each storyboard</option>
          </select>
        </Row>
        <Row label="Show panel number (left)">
          <input type="checkbox" checked={s.panelBadges.showNumber}
            onChange={(e) => patchBadges({ showNumber: e.target.checked })} />
        </Row>
        <Row label="Prefix panel number">
          <input type="checkbox" checked={s.panelBadges.useNumberPrefix}
            onChange={(e) => patchBadges({ useNumberPrefix: e.target.checked })} />
        </Row>
        {s.panelBadges.useNumberPrefix && (
          <Row label="Number prefix text">
            <input type="text" value={s.panelBadges.numberPrefix} placeholder="Panel "
              onChange={(e) => patchBadges({ numberPrefix: e.target.value })} />
          </Row>
        )}
        <Row label="Show corner note (right)">
          <input type="checkbox" checked={s.panelBadges.showCornerNote}
            onChange={(e) => patchBadges({ showCornerNote: e.target.checked })} />
        </Row>
        <Row label="Prefix corner note">
          <input type="checkbox" checked={s.panelBadges.useCornerNotePrefix}
            onChange={(e) => patchBadges({ useCornerNotePrefix: e.target.checked })} />
        </Row>
        {s.panelBadges.useCornerNotePrefix && (
          <Row label="Note prefix text">
            <input type="text" value={s.panelBadges.cornerNotePrefix} placeholder="e.g. Note: "
              onChange={(e) => patchBadges({ cornerNotePrefix: e.target.value })} />
          </Row>
        )}
      </Section>

      <Section title="Footer & Logo" openKey="footer" open={open} toggle={toggle}>
        <Row label="Show project name">
          <input type="checkbox" checked={s.footer.showProjectName}
            onChange={(e) => patchFooter({ showProjectName: e.target.checked })} />
        </Row>
        <Row label="Show page number">
          <input type="checkbox" checked={s.footer.showPageNumber}
            onChange={(e) => patchFooter({ showPageNumber: e.target.checked })} />
        </Row>
        <Row label="Company logo">
          <div className="logo-controls">
            <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/svg+xml" style={{ display: 'none' }}
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
              }} />
            <button onClick={() => logoRef.current?.click()}>Choose…</button>
            {s.footer.logoDataUrl && (
              <button onClick={() => patchFooter({ logoDataUrl: null, logoAutoTheme: true })}>Reset to default</button>
            )}
          </div>
        </Row>
        <Row label="Auto-switch logo">
          <input type="checkbox" checked={s.footer.logoAutoTheme}
            onChange={(e) => patchFooter({ logoAutoTheme: e.target.checked })} />
        </Row>
        <Row label={`Logo scale (${s.footer.logoScale.toFixed(2)}×)`}>
          <input type="range" min={0.25} max={3} step={0.05} value={s.footer.logoScale}
            onChange={(e) => patchFooter({ logoScale: Number(e.target.value) })} />
        </Row>
      </Section>
    </div>
  );
}

// ---- Item tab -----------------------------------------------------------

function ItemTab({
  state,
  dispatch,
  storyboard,
  slide,
  selectedPanel,
  selectedCount,
  open,
  toggle,
}: {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  storyboard: Extract<BoardfishState['items'][number], { kind: 'storyboard' }> | null;
  slide: Extract<BoardfishState['items'][number], { kind: 'slide' }> | null;
  selectedPanel: import('../types').Panel | undefined;
  selectedCount: number;
  open: OpenState;
  toggle: (k: string) => void;
}) {
  if (!storyboard && !slide && !selectedPanel) {
    return <div className="tab-empty">Select a slide, storyboard, or panel to see item options.</div>;
  }

  return (
    <div>
      {slide && <SlideOverrides slide={slide} dispatch={dispatch} open={open} toggle={toggle} />}
      {storyboard && (
        <StoryboardOverridesUI
          state={state}
          storyboard={storyboard}
          dispatch={dispatch}
          open={open}
          toggle={toggle}
        />
      )}
      {selectedPanel && (
        <Section
          title={selectedCount > 1 ? `Selected panels (${selectedCount})` : 'Selected panel'}
          openKey="panel"
          open={open}
          toggle={toggle}
        >
          <div className="button-row">
            <button onClick={() => dispatch({ type: 'CUT_PANELS', ids: state.selectedPanelIds })}>Cut</button>
            <button onClick={() => dispatch({ type: 'COPY_PANELS', ids: state.selectedPanelIds })}>Copy</button>
            <button onClick={() => dispatch({ type: 'PASTE_PANELS' })} disabled={state.clipboard.length === 0}>Paste</button>
            <button onClick={() => dispatch({ type: 'DUPLICATE_PANELS', ids: state.selectedPanelIds })}>Duplicate</button>
            <button onClick={() => dispatch({ type: 'DELETE_PANELS', ids: state.selectedPanelIds })}>Delete</button>
          </div>
          <div className="hint">⌘X / ⌘C / ⌘V / ⌘D / Del also work. Click + ⌘-click / Shift-click / ⌘A for multi-select.</div>
        </Section>
      )}
    </div>
  );
}

function SlideOverrides({
  slide: slideItem,
  dispatch,
  open,
  toggle,
}: {
  slide: Extract<BoardfishState['items'][number], { kind: 'slide' }>;
  dispatch: React.Dispatch<Action>;
  open: OpenState;
  toggle: (k: string) => void;
}) {
  const sl = slideItem.slide;
  return (
    <Section title="Slide" openKey="slide" open={open} toggle={toggle}>
      <Row label="Show footer">
        <input type="checkbox" checked={sl.showFooter}
          onChange={(e) => dispatch({ type: 'UPDATE_SLIDE', id: sl.id, patch: { showFooter: e.target.checked } })} />
      </Row>
      <Row label="Title">
        <input type="text" value={sl.title}
          onChange={(e) => dispatch({ type: 'UPDATE_SLIDE', id: sl.id, patch: { title: e.target.value } })} />
      </Row>
      <Row label="Subtitle">
        <input type="text" value={sl.subtitle}
          onChange={(e) => dispatch({ type: 'UPDATE_SLIDE', id: sl.id, patch: { subtitle: e.target.value } })} />
      </Row>
      <div className="button-row" style={{ marginTop: 8 }}>
        <button onClick={() => dispatch({ type: 'REMOVE_ITEM', id: slideItem.id })}>Delete slide</button>
      </div>
    </Section>
  );
}

function StoryboardOverridesUI({
  state,
  storyboard,
  dispatch,
  open,
  toggle,
}: {
  state: BoardfishState;
  storyboard: Extract<BoardfishState['items'][number], { kind: 'storyboard' }>;
  dispatch: React.Dispatch<Action>;
  open: OpenState;
  toggle: (k: string) => void;
}) {
  const s = state.settings;
  const eff = resolveStoryboardSettings(s, storyboard);
  const overrides = storyboard.overrides ?? {};
  const hasGrid = Boolean(overrides.grid && Object.keys(overrides.grid).length > 0);
  const hasAspect = Boolean(overrides.panelAspect && Object.keys(overrides.panelAspect).length > 0);
  const hasFields = Boolean(overrides.fields && Object.keys(overrides.fields).length > 0);

  const setGrid = (patch: NonNullable<import('../types').StoryboardOverrides['grid']>) =>
    dispatch({ type: 'UPDATE_STORYBOARD_OVERRIDES', id: storyboard.id, patch: { grid: patch } });
  const setAspect = (patch: NonNullable<import('../types').StoryboardOverrides['panelAspect']>) =>
    dispatch({ type: 'UPDATE_STORYBOARD_OVERRIDES', id: storyboard.id, patch: { panelAspect: patch } });
  const setFieldsOverride = (labels: string[]) =>
    dispatch({
      type: 'UPDATE_STORYBOARD_OVERRIDES',
      id: storyboard.id,
      patch: { fields: { defaults: labels } },
    });

  return (
    <>
      <Section title="Storyboard" openKey="slide" open={open} toggle={toggle}>
        <Row label="Name (optional)">
          <input
            type="text"
            value={overrides.name ?? ''}
            placeholder="e.g. Locations"
            onChange={(e) =>
              dispatch({ type: 'UPDATE_STORYBOARD_OVERRIDES', id: storyboard.id, patch: { name: e.target.value } })
            }
          />
        </Row>
        <div className="hint">
          {storyboard.panels.length} panel{storyboard.panels.length === 1 ? '' : 's'}. Overrides below apply only to this storyboard.
        </div>
      </Section>

      <Section
        title={`Grid ${hasGrid ? '· overridden' : '· inherited'}`}
        openKey="gridItem"
        open={open}
        toggle={toggle}
      >
        <Row label="Horizontal panels">
          <input type="number" min={1} max={12} value={eff.panelsHorizontal}
            onChange={(e) => setGrid({ panelsHorizontal: Math.max(1, Number(e.target.value) || 1) })} />
        </Row>
        <Row label="Vertical panels">
          <input type="number" min={1} max={12} value={eff.panelsVertical}
            onChange={(e) => setGrid({ panelsVertical: Math.max(1, Number(e.target.value) || 1) })} />
        </Row>
        <Row label="Margin (px)">
          <input type="number" value={eff.marginPx}
            onChange={(e) => setGrid({ marginPx: Number(e.target.value) || 0 })} />
        </Row>
        <Row label="Horizontal gutter (px)">
          <input type="number" value={eff.gutterHorizontalPx}
            onChange={(e) => setGrid({ gutterHorizontalPx: Number(e.target.value) || 0 })} />
        </Row>
        <Row label="Vertical gutter (px)">
          <input type="number" value={eff.gutterVerticalPx}
            onChange={(e) => setGrid({ gutterVerticalPx: Number(e.target.value) || 0 })} />
        </Row>
        {hasGrid && (
          <button
            className="add-label"
            onClick={() =>
              dispatch({ type: 'CLEAR_STORYBOARD_OVERRIDE', id: storyboard.id, section: 'grid' })
            }
          >
            ↺ Reset to global grid
          </button>
        )}
      </Section>

      <Section
        title={`Panel Aspect ${hasAspect ? '· overridden' : '· inherited'}`}
        openKey="panelAspectItem"
        open={open}
        toggle={toggle}
      >
        <Row label="Preset">
          <select
            value={String(eff.panelAspectRatio)}
            onChange={(e) => setAspect({ panelAspectRatio: Number(e.target.value), panelAspectLocked: false })}
          >
            <option value={String(eff.panelAspectRatio)}>Current ({eff.panelAspectRatio.toFixed(3)})</option>
            {PANEL_ASPECT_RATIOS.map((r) => (
              <option key={r.label} value={String(r.ratio)}>{r.label}</option>
            ))}
          </select>
        </Row>
        <Row label="Lock to 1st image">
          <input type="checkbox" checked={eff.panelAspectLocked}
            onChange={(e) => setAspect({ panelAspectLocked: e.target.checked })} />
        </Row>
        <Row label="Image fit">
          <select value={eff.imageFit} onChange={(e) => setAspect({ imageFit: e.target.value as ImageFit })}>
            <option value="fit">Fit (contain, letterbox)</option>
            <option value="fill">Fill (stretch)</option>
            <option value="crop">Crop (cover)</option>
          </select>
        </Row>
        {hasAspect && (
          <button
            className="add-label"
            onClick={() =>
              dispatch({ type: 'CLEAR_STORYBOARD_OVERRIDE', id: storyboard.id, section: 'panelAspect' })
            }
          >
            ↺ Reset to global aspect
          </button>
        )}
      </Section>

      <Section
        title={`Fields ${hasFields ? '· overridden' : '· inherited'}`}
        openKey="fieldsItem"
        open={open}
        toggle={toggle}
      >
        <div className="section-hint">
          {hasFields
            ? 'This storyboard has its own field labels.'
            : 'Inherits from Global → Fields. Edit here to override for this storyboard only.'}
        </div>
        <div className="label-list">
          {eff.fieldLabels.map((label, idx) => (
            <div className="label-row" key={`${label}-${idx}`}>
              <input
                type="text"
                defaultValue={label}
                onBlur={(e) => {
                  const nl = e.target.value.trim();
                  if (!nl) { e.target.value = label; return; }
                  if (nl === label) return;
                  const next = [...eff.fieldLabels];
                  next[idx] = nl;
                  setFieldsOverride(next);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <button
                title="Remove field from this storyboard"
                onClick={() => setFieldsOverride(eff.fieldLabels.filter((_, i) => i !== idx))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="add-label"
            onClick={() => {
              const label = prompt('New field label (for this storyboard only):');
              if (label && label.trim()) setFieldsOverride([...eff.fieldLabels, label.trim()]);
            }}
          >
            + Add field
          </button>
          {hasFields && (
            <button
              className="add-label"
              onClick={() =>
                dispatch({ type: 'CLEAR_STORYBOARD_OVERRIDE', id: storyboard.id, section: 'fields' })
              }
            >
              ↺ Reset to global fields
            </button>
          )}
        </div>
      </Section>

      <Section title="Storyboard actions" openKey="panel" open={open} toggle={toggle}>
        <div className="button-row">
          <button onClick={() => dispatch({ type: 'REMOVE_ITEM', id: storyboard.id })}>Delete storyboard</button>
        </div>
      </Section>
    </>
  );
}

// ---- shared helpers -----------------------------------------------------

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
