import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Outliner } from './components/Outliner';
import { Toolbar } from './components/Toolbar';
import { PanelLightbox } from './components/PanelLightbox';
import { allStoryboardPanels, useBoardfish } from './store';
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
  const [outlinerOpen, setOutlinerOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('boardfish:outlinerOpen');
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('boardfish:inspectorOpen', String(inspectorOpen));
    } catch {
      // ignore
    }
  }, [inspectorOpen]);
  useEffect(() => {
    try {
      localStorage.setItem('boardfish:outlinerOpen', String(outlinerOpen));
    } catch {
      // ignore
    }
  }, [outlinerOpen]);

  // Flattened storyboard panels across all items — used for lightbox nav + canvas arrow-key nav
  const flatPanels = allStoryboardPanels(state.items);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const meta = e.metaKey || e.ctrlKey;

      if (meta && (e.key === '\\' || e.key === '|')) {
        e.preventDefault();
        setInspectorOpen((v) => !v);
        return;
      }
      // ⌘⇧O toggles the outliner
      if (meta && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setOutlinerOpen((v) => !v);
        return;
      }
      // F toggles full-screen storyboard view (only when no modifier)
      if (!meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFullscreen((v) => !v);
        return;
      }

      const isArrowNav = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && flatPanels.length > 0;
      if (!state.selectedPanelId && !(meta && e.key.toLowerCase() === 'v') && !isArrowNav) return;

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
        e.preventDefault();
        setLightboxOpen((v) => !v);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !lightboxOpen) {
        if (flatPanels.length === 0) return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const idx = state.selectedPanelId
          ? flatPanels.findIndex((p) => p.id === state.selectedPanelId)
          : -1;
        const next =
          idx < 0
            ? dir === 1 ? 0 : flatPanels.length - 1
            : (idx + dir + flatPanels.length) % flatPanels.length;
        dispatch({ type: 'SELECT_PANEL', id: flatPanels[next].id });
      } else if (e.key === 'Escape') {
        if (lightboxOpen) setLightboxOpen(false);
        else if (fullscreen) setFullscreen(false);
        else dispatch({ type: 'SELECT_PANEL', id: null });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.selectedPanelId, lightboxOpen, fullscreen, flatPanels]);

  useEffect(() => {
    if (!state.selectedPanelId && lightboxOpen) setLightboxOpen(false);
  }, [state.selectedPanelId, lightboxOpen]);

  const selectedPanel = flatPanels.find((p) => p.id === state.selectedPanelId);
  const selectedPanelIndex = selectedPanel
    ? flatPanels.findIndex((p) => p.id === selectedPanel.id) + 1
    : 0;

  // Full-screen mode implicitly hides toolbar + inspector + outliner
  const effectiveOutlinerOpen = outlinerOpen && !fullscreen;
  const effectiveInspectorOpen = inspectorOpen && !fullscreen;

  const bodyClasses = [
    effectiveOutlinerOpen ? 'outliner-visible' : 'outliner-hidden',
    effectiveInspectorOpen ? 'inspector-visible' : 'inspector-hidden',
    fullscreen ? 'fullscreen' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={`app-root ${bodyClasses}`}>
      {!fullscreen && (
        <Toolbar
          state={state}
          dispatch={dispatch}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          outlinerOpen={outlinerOpen}
          onToggleOutliner={() => setOutlinerOpen((v) => !v)}
        />
      )}
      <div className="app-body">
        {effectiveOutlinerOpen && (
          <Outliner state={state} dispatch={dispatch} onClose={() => setOutlinerOpen(false)} />
        )}
        <Canvas state={state} dispatch={dispatch} />
        {effectiveInspectorOpen && <Inspector state={state} dispatch={dispatch} />}
      </div>
      {!effectiveOutlinerOpen && !fullscreen && (
        <button className="outliner-reopen" title="Show Outline (⌘⇧O)" onClick={() => setOutlinerOpen(true)}>
          Outline ›
        </button>
      )}
      {!effectiveInspectorOpen && !fullscreen && (
        <button className="inspector-reopen" title="Show Inspector (⌘\)" onClick={() => setInspectorOpen(true)}>
          ‹ Inspector
        </button>
      )}
      {fullscreen && (
        <button
          className="fullscreen-exit"
          title="Exit full screen (F or Esc)"
          onClick={() => setFullscreen(false)}
        >
          Exit Full Screen  ·  F
        </button>
      )}
      {lightboxOpen && selectedPanel && (
        <PanelLightbox
          panel={selectedPanel}
          panelIndex={selectedPanelIndex}
          totalPanels={flatPanels.length}
          settings={state.settings}
          dispatch={dispatch}
          onClose={() => setLightboxOpen(false)}
          onNavigate={(dir) => {
            const idx = flatPanels.findIndex((p) => p.id === state.selectedPanelId);
            if (idx < 0) return;
            const next = (idx + dir + flatPanels.length) % flatPanels.length;
            dispatch({ type: 'SELECT_PANEL', id: flatPanels[next].id });
          }}
        />
      )}
    </div>
  );
}

export default App;
