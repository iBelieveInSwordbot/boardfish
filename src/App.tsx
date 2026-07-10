import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Outliner } from './components/Outliner';
import { Toolbar } from './components/Toolbar';
import { PanelLightbox } from './components/PanelLightbox';
import { AIDrawer } from './components/AIDrawer';
import { allStoryboardPanels, primarySelectedPanelId, useBoardfish } from './store';
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
  const [aiOpen, setAiOpen] = useState(false);

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
      // ⌘K opens the AI Director drawer
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAiOpen((v) => !v);
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

      const hasSelection = state.selectedPanelIds.length > 0;
      const primary = primarySelectedPanelId(state);
      const isArrowNav = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && flatPanels.length > 0;

      // ⌘A — Select all storyboard panels in the document
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'a' && flatPanels.length > 0) {
        e.preventDefault();
        dispatch({ type: 'SELECT_ALL_PANELS' });
        return;
      }
      // ⌘S — Save Project (prevent browser's default save-page)
      if (meta && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void (async () => {
          const { saveProject } = await import('./project-io');
          try {
            await saveProject(state, {
              downscale: state.settings.storage.downscaleOnSave,
              maxLongEdgePx: state.settings.storage.maxImageLongEdgePx,
            });
          } catch (err) {
            console.error(err);
            alert(`Save failed: ${(err as Error).message}`);
          }
        })();
        return;
      }
      // ⌘D — Duplicate selected panels
      if (meta && !e.shiftKey && e.key.toLowerCase() === 'd' && hasSelection) {
        e.preventDefault();
        dispatch({ type: 'DUPLICATE_PANELS', ids: state.selectedPanelIds });
        return;
      }

      if (!hasSelection && !(meta && e.key.toLowerCase() === 'v') && !isArrowNav) return;

      if (meta && e.key.toLowerCase() === 'x' && hasSelection) {
        e.preventDefault();
        dispatch({ type: 'CUT_PANELS', ids: state.selectedPanelIds });
      } else if (meta && e.key.toLowerCase() === 'c' && hasSelection) {
        e.preventDefault();
        dispatch({ type: 'COPY_PANELS', ids: state.selectedPanelIds });
      } else if (meta && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        dispatch({ type: 'PASTE_PANELS' });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
        e.preventDefault();
        dispatch({ type: 'DELETE_PANELS', ids: state.selectedPanelIds });
      } else if (e.key === ' ' && primary) {
        e.preventDefault();
        setLightboxOpen((v) => !v);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !lightboxOpen) {
        if (flatPanels.length === 0) return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        // Arrow-key nav operates on single selection; use the primary of any current multi-selection
        const idx = primary ? flatPanels.findIndex((p) => p.id === primary) : -1;
        const next =
          idx < 0
            ? dir === 1 ? 0 : flatPanels.length - 1
            : (idx + dir + flatPanels.length) % flatPanels.length;
        dispatch({ type: 'SELECT_PANEL', id: flatPanels[next].id, modifier: 'set' });
      } else if (e.key === 'Escape') {
        if (lightboxOpen) setLightboxOpen(false);
        else if (fullscreen) setFullscreen(false);
        else dispatch({ type: 'CLEAR_PANEL_SELECTION' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.selectedPanelIds, state.items, lightboxOpen, fullscreen, flatPanels, state]);

  const primaryId = primarySelectedPanelId(state);
  useEffect(() => {
    if (!primaryId && lightboxOpen) setLightboxOpen(false);
  }, [primaryId, lightboxOpen]);

  const selectedPanel = flatPanels.find((p) => p.id === primaryId);
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
          onOpenAI={() => setAiOpen(true)}
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
      {aiOpen && (
        <AIDrawer state={state} dispatch={dispatch} onClose={() => setAiOpen(false)} />
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
            const idx = flatPanels.findIndex((p) => p.id === primaryId);
            if (idx < 0) return;
            const next = (idx + dir + flatPanels.length) % flatPanels.length;
            dispatch({ type: 'SELECT_PANEL', id: flatPanels[next].id, modifier: 'set' });
          }}
        />
      )}
    </div>
  );
}

export default App;
