import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Outliner } from './components/Outliner';
import { Toolbar } from './components/Toolbar';
import { PanelLightbox } from './components/PanelLightbox';
import { AIDrawer } from './components/AIDrawer';
import { NodeEditor } from './components/NodeEditor';
import { seedDefaultGraph } from './nodes/types';
import type { NodeGraph } from './nodes/types';
import { ratioToLabel } from './ai/client';
import { allStoryboardPanels, primarySelectedPanelId, useBoardfish } from './store';
import { styleSuffix } from './types';
import './App.css';
import './components/NodeEditor.css';

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
  // Panel id currently opened in the node editor (null = closed).
  const [nodeEditorPanelId, setNodeEditorPanelId] = useState<string | null>(null);
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
      // If the node editor is open, it owns all keyboard input. Bailing here
      // prevents Backspace/Delete from wiping the panel while the user is
      // deleting a node, Space from opening the lightbox on top of the node
      // fullscreen preview, ⌘X from cutting panels while cutting a node, etc.
      if (nodeEditorPanelId) return;

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
  }, [dispatch, state.selectedPanelIds, state.items, lightboxOpen, fullscreen, flatPanels, state, nodeEditorPanelId]);

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
        <Canvas
          state={state}
          dispatch={dispatch}
          onOpenNodeEditor={(panelId) => setNodeEditorPanelId(panelId)}
        />
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
      {nodeEditorPanelId && (() => {
        const editing = flatPanels.find((p) => p.id === nodeEditorPanelId);
        if (!editing) return null;
        const rawSeedPrompt =
          editing.aiPrompt ??
          editing.fields.find((f) => f.label.toLowerCase() === 'description')?.value ??
          editing.fields.map((f) => f.value).filter(Boolean).join('. ');
        // Bake the style suffix into what the Text Prompt node shows the user.
        // Panel.tsx previously appended the style tag invisibly at gen time
        // (see fireGenerate → finalPrompt = rawPrompt + styleSuffix(mode)),
        // but the node editor bypasses that path, so opening the editor
        // silently dropped the style AND — worse — image-to-image with the
        // panel's current styled image kept the old aesthetic no matter what
        // the user typed. Solution: show the full effective prompt, exactly
        // what will be sent to FAL, in the Text Prompt node.
        const seedPrompt = (rawSeedPrompt + styleSuffix(editing.styleMode)).trim();
        // Seed a fresh graph from the effective prompt AND — if the panel
        // already has an image — pre-wire that image as the ImageGen `ref`
        // input so double-click restore behaves like image-to-image out of
        // the box (the behaviour that regressed when style-bleed got fixed).
        // Explicit override still wins: if the user saved a graph on this
        // panel, use that verbatim.
        const savedGraph =
          (editing.nodeGraph as NodeGraph | undefined) ??
          seedDefaultGraph(seedPrompt, editing.imageDataUrl ?? undefined);
        return (
          <NodeEditor
            initialGraph={savedGraph}
            panelPrompt={seedPrompt}
            panelAspect={ratioToLabel(state.settings.panelAspectRatio)}
            availablePanels={flatPanels
              .filter((p) => p.id !== editing.id)
              .map((p, i) => ({
                id: p.id,
                label: `Panel ${i + 1}` + (p.fields[0]?.value ? ` — ${p.fields[0].value.slice(0, 40)}` : ''),
                imageDataUrl: p.imageDataUrl ?? undefined,
                thumbUrl: p.imageDataUrl ?? undefined,
              }))}
            onSave={(nextGraph, outMedia) => {
              // Persist the graph on the panel.
              dispatch({ type: 'SET_PANEL_NODE_GRAPH', panelId: editing.id, graph: nextGraph });
              // Apply the Out node's result to the panel.
              if (outMedia?.kind === 'image') {
                dispatch({
                  type: 'APPLY_AI_IMAGE',
                  panelId: editing.id,
                  dataUrl: outMedia.dataUrl,
                  imageName: `Node ${new Date().toISOString().slice(0, 10)} ${editing.id.slice(0, 6)}.jpg`,
                  prompt: seedPrompt,
                  generatedAt: Date.now(),
                });
                // Clear any prior video attachment (this Out is a still now).
                dispatch({ type: 'UPDATE_PANEL', id: editing.id, patch: { videoDataUrl: null } });
              } else if (outMedia?.kind === 'video') {
                // Use the extracted first-frame poster (or the existing panel
                // image as a last-resort fallback) so the storyboard grid
                // and PDF export have a still to render.
                const poster = outMedia.posterDataUrl ?? editing.imageDataUrl ?? '';
                if (poster) {
                  dispatch({
                    type: 'APPLY_AI_IMAGE',
                    panelId: editing.id,
                    dataUrl: poster,
                    imageName: `Node ${new Date().toISOString().slice(0, 10)} ${editing.id.slice(0, 6)}.jpg`,
                    prompt: seedPrompt,
                    generatedAt: Date.now(),
                  });
                }
                dispatch({
                  type: 'UPDATE_PANEL',
                  id: editing.id,
                  patch: { videoDataUrl: outMedia.dataUrl },
                });
              }
              setNodeEditorPanelId(null);
            }}
            onClose={() => setNodeEditorPanelId(null)}
          />
        );
      })()}
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
