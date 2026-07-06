import { useRef } from 'react';
import type { Action, BoardfishState } from '../store';
import { exportPdf, loadProject, saveProject } from '../project-io';

type Props = { state: BoardfishState; dispatch: React.Dispatch<Action> };

export function Toolbar({ state, dispatch }: Props) {
  const openRef = useRef<HTMLInputElement>(null);
  const addImagesRef = useRef<HTMLInputElement>(null);

  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <span className="brand-mark">🎬</span>
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
            const firstImageAlreadyExists = state.panels.some((p) => p.imageDataUrl);
            if (!firstImageAlreadyExists && state.settings.panelAspectLocked && loaded.length > 0) {
              dispatch({ type: 'UPDATE_SETTINGS', patch: { panelAspectRatio: loaded[0].aspect } });
            }
            const newPanels = loaded.map(({ dataUrl, name }) => {
              const p = newPanel(state.settings.labels.defaults);
              p.imageDataUrl = dataUrl;
              p.imageName = name;
              return p;
            });
            dispatch({ type: 'ADD_PANELS', panels: newPanels });
            if (addImagesRef.current) addImagesRef.current.value = '';
          }}
        />
        <button onClick={() => void saveProject(state)}>Save Project</button>
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
              dispatch({ type: 'LOAD_PROJECT', state: loaded });
            } catch (err) {
              alert(`Could not open project: ${(err as Error).message}`);
            }
            if (openRef.current) openRef.current.value = '';
          }}
        />
        <button onClick={() => exportPdf(state.settings)}>Export PDF</button>
        <button
          onClick={() => {
            if (state.panels.length === 0 || confirm('Start a new project? Current work will be cleared.')) {
              dispatch({ type: 'RESET' });
            }
          }}
        >
          New
        </button>
      </div>
    </header>
  );
}
