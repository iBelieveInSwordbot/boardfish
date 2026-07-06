import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Toolbar } from './components/Toolbar';
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
      } else if (e.key === 'Escape') {
        dispatch({ type: 'SELECT_PANEL', id: null });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.selectedPanelId]);

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
    </div>
  );
}

export default App;
