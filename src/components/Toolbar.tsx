import { useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { exportPdf, loadProject, saveProject } from '../project-io';

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  outlinerOpen: boolean;
  onToggleOutliner: () => void;
};

export function Toolbar({ state, dispatch, inspectorOpen, onToggleInspector, outlinerOpen, onToggleOutliner }: Props) {
  const openRef = useRef<HTMLInputElement>(null);
  const addImagesRef = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);

  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <span className="brand-name">Boardfish 3.0</span>
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
        <button onClick={() => void saveProject(state)}>Save Project</button>
        <button
          className="toolbar-inspector-toggle"
          onClick={onToggleOutliner}
          title={outlinerOpen ? 'Hide Outline (⌘⇧O)' : 'Show Outline (⌘⇧O)'}
          style={{ marginRight: 8 }}
        >
          {outlinerOpen ? 'Hide Outline' : 'Show Outline'}
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
        <button
          onClick={async () => {
            if (exporting) return;
            setExporting(true);
            try {
              await exportPdf(state.settings);
            } catch (err) {
              console.error(err);
              alert(`PDF export failed: ${(err as Error).message}`);
            } finally {
              setExporting(false);
            }
          }}
          disabled={exporting}
        >
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
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
