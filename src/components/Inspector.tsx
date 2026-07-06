import { useRef } from 'react';
import type { Action, BoardfishState } from '../store';
import { PAGE_SIZES, PANEL_ASPECT_RATIOS, type ImageFit } from '../types';

type Props = { state: BoardfishState; dispatch: React.Dispatch<Action> };

export function Inspector({ state, dispatch }: Props) {
  const { inspectorTab } = state;
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button
          className={inspectorTab === 'page' ? 'active' : ''}
          onClick={() => dispatch({ type: 'SET_INSPECTOR_TAB', tab: 'page' })}
        >
          Page
        </button>
        <button
          className={inspectorTab === 'panel' ? 'active' : ''}
          onClick={() => dispatch({ type: 'SET_INSPECTOR_TAB', tab: 'panel' })}
          disabled={!state.selectedPanelId}
        >
          Panel
        </button>
      </div>
      <div className="inspector-body">
        {inspectorTab === 'page' ? <PageTab state={state} dispatch={dispatch} /> : <PanelTab state={state} dispatch={dispatch} />}
      </div>
    </aside>
  );
}

function PageTab({ state, dispatch }: Props) {
  const s = state.settings;

  const patch = (p: Partial<typeof s>) => dispatch({ type: 'UPDATE_SETTINGS', patch: p });
  const patchColors = (c: Partial<typeof s.colors>) => patch({ colors: { ...s.colors, ...c } });

  const logoRef = useRef<HTMLInputElement>(null);

  return (
    <div className="tab">
      <Section title="Project">
        <Row label="Name">
          <input type="text" value={s.projectName} onChange={(e) => patch({ projectName: e.target.value })} />
        </Row>
      </Section>

      <Section title="Page Size">
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

      <Section title="Grid">
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

      <Section title="Panel Aspect Ratio">
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
            <option value="fit">Fit (contain)</option>
            <option value="fill">Fill</option>
            <option value="crop">Crop</option>
          </select>
        </Row>
      </Section>

      <Section title="Colors">
        <Row label="Canvas BG">
          <input type="color" value={s.colors.canvasBg} onChange={(e) => patchColors({ canvasBg: e.target.value })} />
        </Row>
        <Row label="Page BG">
          <input type="color" value={s.colors.pageBg} onChange={(e) => patchColors({ pageBg: e.target.value })} />
        </Row>
        <Row label="Panel BG">
          <input type="color" value={s.colors.panelBg} onChange={(e) => patchColors({ panelBg: e.target.value })} />
        </Row>
        <Row label="Footer text">
          <input type="color" value={s.colors.text} onChange={(e) => patchColors({ text: e.target.value })} />
        </Row>
        <Row label="Field text">
          <input type="color" value={s.colors.fieldText} onChange={(e) => patchColors({ fieldText: e.target.value })} />
        </Row>
        <Row label="Accent">
          <input type="color" value={s.colors.accent} onChange={(e) => patchColors({ accent: e.target.value })} />
        </Row>
      </Section>

      <Section title="Footer">
        <Row label="Show project name">
          <input
            type="checkbox"
            checked={s.footer.showProjectName}
            onChange={(e) => patch({ footer: { ...s.footer, showProjectName: e.target.checked } })}
          />
        </Row>
        <Row label="Show page number">
          <input
            type="checkbox"
            checked={s.footer.showPageNumber}
            onChange={(e) => patch({ footer: { ...s.footer, showPageNumber: e.target.checked } })}
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
                patch({ footer: { ...s.footer, logoDataUrl: dataUrl, logoAutoTheme: false } });
                if (logoRef.current) logoRef.current.value = '';
              }}
            />
            <button onClick={() => logoRef.current?.click()}>Choose…</button>
            {s.footer.logoDataUrl && (
              <button onClick={() => patch({ footer: { ...s.footer, logoDataUrl: null, logoAutoTheme: true } })}>
                Reset to default
              </button>
            )}
          </div>
        </Row>
        <Row label="Auto-switch logo">
          <input
            type="checkbox"
            checked={s.footer.logoAutoTheme}
            title="Automatically use black logo on light backgrounds and white logo on dark backgrounds"
            onChange={(e) => patch({ footer: { ...s.footer, logoAutoTheme: e.target.checked } })}
          />
        </Row>
      </Section>
    </div>
  );
}

function PanelTab({ state, dispatch }: Props) {
  const panel = state.panels.find((p) => p.id === state.selectedPanelId);
  if (!panel) return <div className="tab-empty">Select a panel to edit its fields.</div>;

  // Fields are global — all panels share the same set of labels. Editing here updates every panel.
  const currentLabels = state.settings.labels.defaults;

  return (
    <div className="tab">
      <Section title="Fields (applies to all panels)">
        <div className="label-list">
          {currentLabels.map((label) => (
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

      <Section title="Actions">
        <div className="button-row">
          <button onClick={() => dispatch({ type: 'CUT_PANEL', id: panel.id })}>Cut</button>
          <button onClick={() => dispatch({ type: 'COPY_PANEL', id: panel.id })}>Copy</button>
          <button onClick={() => dispatch({ type: 'PASTE_PANEL' })} disabled={!state.clipboard}>
            Paste
          </button>
          <button onClick={() => dispatch({ type: 'DELETE_PANEL', id: panel.id })}>Delete</button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      <div className="section-body">{children}</div>
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
