import { useEffect } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Toolbar } from './components/Toolbar';
import { useBoardfish } from './store';
import './App.css';

function App() {
  const { state, dispatch } = useBoardfish();

  // Global keyboard shortcuts for cut/copy/paste/delete of selected panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      // Don't hijack when user is typing in a field
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const meta = e.metaKey || e.ctrlKey;
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
    <div className="app-root">
      <Toolbar state={state} dispatch={dispatch} />
      <div className="app-body">
        <Canvas state={state} dispatch={dispatch} />
        <Inspector state={state} dispatch={dispatch} />
      </div>
    </div>
  );
}

export default App;
