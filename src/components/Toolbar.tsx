import { useEffect, useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { exportPdf, loadProject, saveProject } from '../project-io';
import type { DocItem } from '../types';

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenAI: () => void;
  onBackToProjects?: () => void;
  saveStatus?: SaveStatus;
};

function formatSavedAgo(at: number): string {
  const delta = Date.now() - at;
  if (delta < 5000) return 'Saved just now';
  if (delta < 60_000) return `Saved ${Math.floor(delta / 1000)}s ago`;
  if (delta < 3600_000) return `Saved ${Math.floor(delta / 60_000)}m ago`;
  return 'Saved';
}

export function Toolbar({
  state,
  dispatch,
  inspectorOpen,
  onToggleInspector,
  onOpenAI,
  onBackToProjects,
  saveStatus,
}: Props) {
  const openRef = useRef<HTMLInputElement>(null);
  const addImagesRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);

  // Re-render every 15s so the "Saved Ns ago" pill stays honest.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (saveStatus?.kind !== 'saved') return;
    const t = window.setInterval(() => forceTick((n) => n + 1), 15000);
    return () => window.clearInterval(t);
  }, [saveStatus?.kind]);

  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        {onBackToProjects && (
          <button
            type="button"
            className="toolbar-back-btn"
            onClick={onBackToProjects}
            title="Back to Projects"
          >
            ‹ Projects
          </button>
        )}
        <span className="brand-name">Boardfish AI <span style={{ opacity: 0.55, fontSize: '0.75em', fontWeight: 500 }}>v1.0</span></span>
        {saveStatus && saveStatus.kind !== 'idle' && (
          <span
            className={`toolbar-save-status ${saveStatus.kind}`}
            title={saveStatus.kind === 'error' ? saveStatus.message : undefined}
          >
            {saveStatus.kind === 'saved' ? formatSavedAgo(saveStatus.at) : `Save failed — ${saveStatus.message}`}
          </span>
        )}
      </div>
      <div className="toolbar-project">
        <input
          type="text"
          value={state.settings.projectName}
          onChange={(e) => dispatch({ type: 'UPDATE_SETTINGS', patch: { projectName: e.target.value } })}
          className="project-name-input"
          spellCheck={false}
        />
      </div>
      <div className="toolbar-actions">
        <button
          className="toolbar-ai-btn"
          onClick={onOpenAI}
          title="AI Director — script to storyboard"
        >
          ✨ AI Director
        </button>
        <button
          onClick={async () => {
            // Insert a blank panel into the best-guess target storyboard.
            // Priority: (1) storyboard owning current selection, (2) selected item
            // if it's a storyboard, (3) first storyboard in the doc.
            const { newPanel } = await import('../types');
            let targetId: string | null = null;
            const primary = state.selectedPanelIds[0];
            if (primary) {
              for (const it of state.items) {
                if (it.kind === 'storyboard' && it.panels.some((p) => p.id === primary)) {
                  targetId = it.id;
                  break;
                }
              }
            }
            if (!targetId && state.selectedItemId) {
              const sel = state.items.find((it) => it.id === state.selectedItemId);
              if (sel && sel.kind === 'storyboard') targetId = sel.id;
            }
            if (!targetId) {
              const first = state.items.find((it) => it.kind === 'storyboard');
              if (first) targetId = first.id;
            }
            if (!targetId) return;
            const p = newPanel(state.settings.labels.defaults);
            dispatch({ type: 'ADD_PANELS_TO_ITEM', itemId: targetId, panels: [p] });
            dispatch({ type: 'SELECT_PANEL', id: p.id, modifier: 'set' });
          }}
          title="Add a blank panel (placeholder or AI-gen from description)"
        >
          + Panel
        </button>
        <button
          onClick={() => addImagesRef.current?.click()}
          title="Add images"
        >
          + Images
        </button>
        <input
          ref={addImagesRef}
          type="file"
          multiple
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = e.target.files;
            if (!files || files.length === 0) return;
            // Piggyback on Canvas's handler by dispatching directly here (duplicating a tiny bit of logic
            // is simpler than lifting handleFiles up)
            const { fileToPanelImage } = await import('../store');
            const { newPanel } = await import('../types');
            const loaded = await Promise.all(Array.from(files).map((f) => fileToPanelImage(f)));
            // Find target storyboard: nearest to selection, or first storyboard
            let targetId: string | null = null;
            const primary = state.selectedPanelIds[0];
            if (primary) {
              for (const it of state.items) {
                if (it.kind === 'storyboard' && it.panels.some((p) => p.id === primary)) {
                  targetId = it.id;
                  break;
                }
              }
            }
            if (!targetId && state.selectedItemId) {
              const sel = state.items.find((it) => it.id === state.selectedItemId);
              if (sel && sel.kind === 'storyboard') targetId = sel.id;
            }
            if (!targetId) {
              const first = state.items.find((it) => it.kind === 'storyboard');
              if (first) targetId = first.id;
            }
            if (!targetId) return;
            const targetItem = state.items.find((it) => it.id === targetId);
            if (targetItem && targetItem.kind === 'storyboard') {
              const { resolveStoryboardSettings } = await import('../store');
              const eff = resolveStoryboardSettings(state.settings, targetItem);
              const hasAnyImage = targetItem.panels.some((p) => p.imageDataUrl);
              if (!hasAnyImage && eff.panelAspectLocked && loaded.length > 0) {
                dispatch({
                  type: 'UPDATE_STORYBOARD_OVERRIDES',
                  id: targetItem.id,
                  patch: { panelAspect: { panelAspectRatio: loaded[0].aspect } },
                });
              }
            }
            const newPanels = loaded.map(({ dataUrl, name }) => {
              const p = newPanel(state.settings.labels.defaults);
              p.imageDataUrl = dataUrl;
              p.imageName = name;
              return p;
            });
            dispatch({ type: 'ADD_PANELS_TO_ITEM', itemId: targetId, panels: newPanels });
            if (addImagesRef.current) addImagesRef.current.value = '';
          }}
        />
        <button
          onClick={() =>
            void saveProject(state, {
              downscale: state.settings.storage.downscaleOnSave,
              maxLongEdgePx: state.settings.storage.maxImageLongEdgePx,
            })
          }
        >
          Save Project
        </button>
        <button onClick={() => openRef.current?.click()}>Open…</button>
        <input
          ref={openRef}
          type="file"
          accept=".boardfish,application/zip"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const loaded = await loadProject(file);
              dispatch({ type: 'LOAD_PROJECT', state: { settings: loaded.settings, items: loaded.items } });
            } catch (err) {
              alert(`Could not open project: ${(err as Error).message}`);
            }
            if (openRef.current) openRef.current.value = '';
          }}
        />
        <ExportPdfMenu
          exporting={exporting}
          hasAssetSections={hasAssetSections(state.items)}
          onExport={async (boardsOnly) => {
            if (exporting) return;
            setExporting(true);
            try {
              await exportPdf(state.settings, boardsOnly ? { boardsOnly: true } : undefined);
            } catch (err) {
              console.error(err);
              alert(`PDF export failed: ${(err as Error).message}`);
            } finally {
              setExporting(false);
            }
          }}
        />
        <button
          onClick={() => {
            const anyContent = state.items.some(
              (it) => it.kind === 'slide' || (it.kind === 'storyboard' && it.panels.length > 0),
            );
            if (!anyContent || confirm('Start a new project? Current work will be cleared.')) {
              dispatch({ type: 'RESET' });
            }
          }}
        >
          New
        </button>
        <button
          className="toolbar-inspector-toggle"
          onClick={onToggleInspector}
          title={inspectorOpen ? 'Hide Inspector (⌘\\)' : 'Show Inspector (⌘\\)'}
        >
          {inspectorOpen ? 'Hide Inspector' : 'Show Inspector'}
        </button>
      </div>
    </header>
  );
}

/**
 * Split-button for PDF export. Main click exports the full document; the
 * chevron opens a small menu with "Boards only" when the doc has asset
 * sections (Actors / Locations / Props tagged by the AI Director wizard).
 */
function ExportPdfMenu({
  exporting,
  hasAssetSections,
  onExport,
}: {
  exporting: boolean;
  hasAssetSections: boolean;
  onExport: (boardsOnly: boolean) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="export-pdf-split" ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => onExport(false)}
        disabled={exporting}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
      >
        {exporting ? 'Exporting…' : 'Export PDF'}
      </button>
      {hasAssetSections && (
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={exporting}
          title="More export options"
          style={{
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            borderLeft: '1px solid rgba(255,255,255,0.15)',
            padding: '0 8px',
          }}
        >
          ▾
        </button>
      )}
      {open && hasAssetSections && (
        <div
          className="export-pdf-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: '#1a1a1e',
            border: '1px solid #2e2e34',
            borderRadius: 4,
            padding: 4,
            minWidth: 220,
            zIndex: 100,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          <button
            onClick={() => {
              setOpen(false);
              onExport(false);
            }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
          >
            Full document (boards + assets)
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onExport(true);
            }}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
          >
            Boards only (no actors / locations / props)
          </button>
        </div>
      )}
    </div>
  );
}

/** True when the document contains at least one AI-tagged asset section. */
function hasAssetSections(items: DocItem[]): boolean {
  for (const it of items) {
    if (it.kind === 'storyboard') {
      const n = (it.overrides?.name || '').trim().toLowerCase();
      if (n === 'actors' || n === 'locations' || n === 'props') return true;
    } else if (it.kind === 'slide') {
      const t = (it.slide.textBoxes?.[0]?.text || '').trim().toLowerCase();
      if (t === 'actors' || t === 'locations' || t === 'props') return true;
    }
  }
  return false;
}
