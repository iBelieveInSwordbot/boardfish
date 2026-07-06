import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Toolbar } from './components/Toolbar';
import { PanelLightbox } from './components/PanelLightbox';
import { useBoardfish } from './store';
import './App.css';

function App() {
  const { state, dispatch } = useBoardfish();
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('boardfish:inspectorOpen');
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('boardfish:inspectorOpen', String(inspectorOpen));
    } catch {
      // ignore
    }
  }, [inspectorOpen]);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const meta = e.metaKey || e.ctrlKey;

      // ⌘\ toggles inspector (Photoshop-ish; ⌘⌥I also common)
      if (meta && (e.key === '\\' || e.key === '|')) {
        e.preventDefault();
        setInspectorOpen((v) => !v);
        return;
      }

      if (!state.selectedPanelId && !(meta && e.key.toLowerCase() === 'v')) return;

      if (meta && e.key.toLowerCase() === 'x' && state.selectedPanelId) {
        e.preventDefault();
        dispatch({ type: 'CUT_PANEL', id: state.selectedPanelId });
      } else if (meta && e.key.toLowerCase() === 'c' && state.selectedPanelId) {
        e.preventDefault();
        dispatch({ type: 'COPY_PANEL', id: state.selectedPanelId });
      } else if (meta && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        dispatch({ type: 'PASTE_PANEL' });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedPanelId) {
        e.preventDefault();
        dispatch({ type: 'DELETE_PANEL', id: state.selectedPanelId });
      } else if (e.key === ' ' && state.selectedPanelId) {
        // Spacebar: toggle lightbox for selected panel
        e.preventDefault();
        setLightboxOpen((v) => !v);
      } else if (e.key === 'Escape') {
        if (lightboxOpen) setLightboxOpen(false);
        else dispatch({ type: 'SELECT_PANEL', id: null });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.selectedPanelId, lightboxOpen]);

  // Ensure lightbox closes if the selected panel goes away (deleted, cut, etc.)
  useEffect(() => {
    if (!state.selectedPanelId && lightboxOpen) setLightboxOpen(false);
  }, [state.selectedPanelId, lightboxOpen]);

  const selectedPanel = state.panels.find((p) => p.id === state.selectedPanelId);
  const selectedPanelIndex = selectedPanel
    ? state.panels.findIndex((p) => p.id === selectedPanel.id) + 1
    : 0;

  return (
    <div className={`app-root ${inspectorOpen ? 'inspector-visible' : 'inspector-hidden'}`}>
      <Toolbar
        state={state}
        dispatch={dispatch}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />
      <div className="app-body">
        <Canvas state={state} dispatch={dispatch} />
        {inspectorOpen && <Inspector state={state} dispatch={dispatch} />}
      </div>
      {!inspectorOpen && (
        <button
          className="inspector-reopen"
          title="Show Inspector (⌘\)"
          onClick={() => setInspectorOpen(true)}
        >
          ‹ Inspector
        </button>
      )}
      {lightboxOpen && selectedPanel && (
        <PanelLightbox
          panel={selectedPanel}
          panelIndex={selectedPanelIndex}
          settings={state.settings}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
