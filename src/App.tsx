import { useEffect, useState } from 'react';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { Outliner } from './components/Outliner';
import { Toolbar } from './components/Toolbar';
import { PanelLightbox } from './components/PanelLightbox';
import { AIDrawer } from './components/AIDrawer';
import { NodeEditor } from './components/NodeEditor';
import { ProjectsDashboard } from './components/ProjectsDashboard';
import { seedDefaultGraph } from './nodes/types';
import type { NodeGraph } from './nodes/types';
import { ratioToLabel } from './ai/client';
import { allStoryboardPanels, primarySelectedPanelId, resolveStoryboardSettings, useBoardfish } from './store';
import { styleSuffix } from './types';
import {
  getCurrentProjectId,
  maybeMigrateLegacyAutosave,
  setCurrentProjectId,
} from './app-shell';
import { useProjectPersistence } from './project-persistence';
import './App.css';
import './components/NodeEditor.css';

function App() {
  const { state, dispatch } = useBoardfish();

  // Currently open project id (server-backed). null means "show the
  // projects dashboard". Persisted in localStorage so a page refresh
  // stays in whatever project the user was editing.
  const [currentProjectId, setCurrentProjectIdState] = useState<string | null>(() =>
    getCurrentProjectId(),
  );
  const [bootReady, setBootReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    { kind: 'idle' } | { kind: 'saved'; at: number } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  // One-time boot: if we don't have a current project id, migrate the
  // legacy IDB autosave into the server store (if there's anything worth
  // saving) and auto-open the migrated project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (currentProjectId) {
        setBootReady(true);
        return;
      }
      const migratedId = await maybeMigrateLegacyAutosave();
      if (cancelled) return;
      if (migratedId) {
        setCurrentProjectId(migratedId);
        setCurrentProjectIdState(migratedId);
      }
      setBootReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally empty deps — runs once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useProjectPersistence(currentProjectId, state, dispatch, {
    onSaved: (info) => setSaveStatus({ kind: 'saved', at: info.modified }),
    onError: (err) => setSaveStatus({ kind: 'error', message: err.message }),
  });

  function openProject(id: string) {
    setCurrentProjectId(id);
    setCurrentProjectIdState(id);
    setSaveStatus({ kind: 'idle' });
  }

  function backToProjects() {
    setCurrentProjectId(null);
    setCurrentProjectIdState(null);
  }

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
  // Node editor keep-alive stack. Each entry is a mounted NodeEditor.
  // `detached: true` means it's still finishing gens in the background
  // but the user has "closed" it and returned to the storyboard — the
  // editor stays mounted (hidden) so FAL results still land on the panel.
  // The most-recently-opened NON-detached entry is visible; everything
  // else renders hidden. When a detached entry's last gen finishes,
  // onDetachedFinish auto-saves and removes it from the stack.
  type NodeEditorEntry = { panelId: string; detached: boolean };
  const [nodeEditorStack, setNodeEditorStack] = useState<NodeEditorEntry[]>([]);
  // Which panel ids currently have background gens running in their node
  // editor. Passed to Canvas so it can overlay a spinner on those panels
  // (both when the editor is detached AND when it's visible — the tile
  // spinner is always accurate).
  const [generatingPanelIds, setGeneratingPanelIds] = useState<Set<string>>(new Set());
  const visibleEditorPanelId = (() => {
    // Walk from the end; the last non-detached entry is visible.
    for (let i = nodeEditorStack.length - 1; i >= 0; i--) {
      if (!nodeEditorStack[i].detached) return nodeEditorStack[i].panelId;
    }
    return null;
  })();
  const nodeEditorPanelId = visibleEditorPanelId;
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

  // Boot gate: don't flash the editor while we're doing the one-time
  // migration check. Once ready, show the dashboard OR the editor.
  if (!bootReady) {
    return (
      <div className="app-boot" style={{
        position: 'fixed', inset: 0, background: '#0f0f10',
        color: '#8a8a92', display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 14,
      }}>
        Loading Boardfish AI…
      </div>
    );
  }

  if (!currentProjectId) {
    return <ProjectsDashboard onOpen={openProject} />;
  }

  return (
    <div className={`app-root ${bodyClasses}`}>
      {!fullscreen && (
        <Toolbar
          state={state}
          dispatch={dispatch}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          onOpenAI={() => setAiOpen(true)}
          onBackToProjects={backToProjects}
          saveStatus={saveStatus}
        />
      )}
      <div className="app-body">
        {effectiveOutlinerOpen && (
          <Outliner state={state} dispatch={dispatch} onClose={() => setOutlinerOpen(false)} />
        )}
        <Canvas
          state={state}
          dispatch={dispatch}
          generatingPanelIds={generatingPanelIds}
          onOpenNodeEditor={(panelId) => {
            setNodeEditorStack((prev) => {
              // If this panel is already mounted (visible or detached), bring
              // it back to the top as non-detached instead of adding a
              // duplicate instance. Its ongoing gens continue seamlessly.
              const existing = prev.filter((e) => e.panelId !== panelId);
              return [...existing, { panelId, detached: false }];
            });
          }}
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

      {/* Detached-gens pill: shows in the storyboard when one or more node
          editors are running gens in the background. Clicking a chip reopens
          the paused editor for that panel. */}
      {(() => {
        const detachedEntries = nodeEditorStack.filter((e) => e.detached);
        if (detachedEntries.length === 0 || fullscreen) return null;
        return (
          <div className="detached-gens-pill" title="Node editors still running gens in the background">
            <span className="detached-gens-pill-dot" />
            <span className="detached-gens-pill-label">
              {detachedEntries.length === 1 ? '1 panel generating' : `${detachedEntries.length} panels generating`}
            </span>
            {detachedEntries.map((e) => {
              const idx = flatPanels.findIndex((p) => p.id === e.panelId);
              const label = idx >= 0 ? `Panel ${idx + 1}` : e.panelId.slice(0, 6);
              return (
                <button
                  key={e.panelId}
                  type="button"
                  className="detached-gens-pill-chip"
                  title={`Reopen ${label}`}
                  onClick={() => {
                    setNodeEditorStack((prev) => {
                      const rest = prev.filter((x) => x.panelId !== e.panelId);
                      return [...rest, { panelId: e.panelId, detached: false }];
                    });
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        );
      })()}
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
      {/* Node editor stack — the LAST non-detached entry is visible; other
          entries (either earlier or detached) render hidden but still receive
          FAL results so gens survive bouncing back to the storyboard. */}
      {nodeEditorStack.map((entry) => {
        const { panelId, detached } = entry;
        const isVisible = panelId === visibleEditorPanelId && !detached;
        const editing = flatPanels.find((p) => p.id === panelId);
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
        // When we seed a fresh default graph, also carry the panel's prior
        // AI generations into the ImageGen node's history so opening the
        // node editor shows all the versions the user made in storyboard.
        // Ordered oldest→newest per graph-utils convention. Videos are
        // skipped (ImageGen history is image-only in the node view).
        const seedImageGenHistory = (editing.imageHistory ?? [])
          .filter((v) => v.kind !== 'video' && v.dataUrl)
          .slice()
          .sort((a, b) => a.generatedAt - b.generatedAt)
          .map((v) => ({
            kind: 'image' as const,
            dataUrl: v.dataUrl,
            mime: 'image/jpeg',
            generatedAt: v.generatedAt || Date.now(),
          }));
        const savedGraph =
          (editing.nodeGraph as NodeGraph | undefined) ??
          seedDefaultGraph(
            seedPrompt,
            editing.imageDataUrl ?? undefined,
            seedImageGenHistory.length > 0 ? seedImageGenHistory : undefined,
          );
        // Shared save handler so detached-finish and explicit save both
        // land the graph + Out media the same way.
        function applyNodeEditorSave(nextGraph: NodeGraph, outMedia:
          | { kind: 'image'; dataUrl: string; mime: string }
          | { kind: 'video'; dataUrl: string; mime: string; posterDataUrl: string | null }
          | null) {
          dispatch({ type: 'SET_PANEL_NODE_GRAPH', panelId: editing!.id, graph: nextGraph });
          if (outMedia?.kind === 'image') {
            dispatch({
              type: 'APPLY_AI_IMAGE',
              panelId: editing!.id,
              dataUrl: outMedia.dataUrl,
              imageName: `Node ${new Date().toISOString().slice(0, 10)} ${editing!.id.slice(0, 6)}.jpg`,
              prompt: seedPrompt,
              generatedAt: Date.now(),
            });
            dispatch({ type: 'UPDATE_PANEL', id: editing!.id, patch: { videoDataUrl: null } });
          } else if (outMedia?.kind === 'video') {
            const poster = outMedia.posterDataUrl ?? editing!.imageDataUrl ?? '';
            dispatch({
              type: 'APPLY_AI_VIDEO',
              panelId: editing!.id,
              videoDataUrl: outMedia.dataUrl,
              posterDataUrl: poster,
              prompt: seedPrompt,
              generatedAt: Date.now(),
            });
          }
        }
        return (
          <NodeEditor
            key={panelId}
            hidden={!isVisible}
            initialGraph={savedGraph}
            panelPrompt={seedPrompt}
            panelAspect={ratioToLabel(state.settings.panelAspectRatio)}
            availablePanels={(() => {
              // Group panels by their parent storyboard so the Panel Ref
              // picker can render one grid per storyboard (matching the
              // Outliner). Panel index is 1-based within its storyboard.
              // Each panel carries its storyboard's effective aspect ratio
              // so the picker can render non-square tiles that don't crop.
              const opts: import('./nodes/registry').PanelRefOption[] = [];
              let sbCount = 0;
              for (const it of state.items) {
                if (it.kind !== 'storyboard') continue;
                sbCount += 1;
                const sbLabel =
                  it.overrides?.name?.trim() || `Storyboard ${sbCount}`;
                const sbSettings = resolveStoryboardSettings(state.settings, it);
                const ar = sbSettings.panelAspectRatio > 0
                  ? sbSettings.panelAspectRatio
                  : 1;
                it.panels.forEach((p, i) => {
                  if (p.id === editing!.id) return;
                  const promptSnippet = p.fields[0]?.value
                    ? ` — ${p.fields[0].value.slice(0, 40)}`
                    : '';
                  opts.push({
                    id: p.id,
                    label: `${sbLabel} · Panel ${i + 1}${promptSnippet}`,
                    imageDataUrl: p.imageDataUrl ?? undefined,
                    thumbUrl: p.imageDataUrl ?? undefined,
                    storyboardId: it.id,
                    storyboardLabel: sbLabel,
                    panelIndex: i + 1,
                    aspectRatio: ar,
                  });
                });
              }
              return opts;
            })()}
            availableActors={(() => {
              // Text Prompt v2 Dialogue field picker source. Scan the
              // project's "Actors" storyboard (matched by name, same rule
              // as Canvas.computeSectionKind) and expose each panel as an
              // actor option: name = first field, description = second
              // field, thumb = current panel image.
              const acts: import('./nodes/registry').ActorRefOption[] = [];
              for (const it of state.items) {
                if (it.kind !== 'storyboard') continue;
                const name = (it.overrides?.name || '').trim().toLowerCase();
                if (name !== 'actors') continue;
                for (const p of it.panels) {
                  const actorName = (p.fields[0]?.value || '').trim();
                  if (!actorName) continue;
                  acts.push({
                    id: p.id,
                    name: actorName,
                    description: (p.fields[1]?.value || '').trim() || undefined,
                    thumbUrl: p.imageDataUrl ?? undefined,
                  });
                }
              }
              return acts;
            })()}
            onSave={(nextGraph, outMedia) => {
              // Persist only; unmounting is owned by onClose /
              // onDetachedFinish so keep-alive detach can survive an
              // explicit ⌘S while gens are still running.
              applyNodeEditorSave(nextGraph, outMedia);
            }}
            onClose={() => {
              // Idle close: unmount this editor.
              setNodeEditorStack((prev) => prev.filter((e) => e.panelId !== panelId));
              setGeneratingPanelIds((prev) => {
                if (!prev.has(panelId)) return prev;
                const next = new Set(prev);
                next.delete(panelId);
                return next;
              });
            }}
            onCloseWhileBusy={() => {
              // In-flight close: flip this entry to detached so it stays
              // mounted (hidden) and continues to receive FAL results.
              setNodeEditorStack((prev) =>
                prev.map((e) => (e.panelId === panelId ? { ...e, detached: true } : e)),
              );
              return true;
            }}
            onDetachedFinish={(nextGraph, outMedia) => {
              applyNodeEditorSave(nextGraph, outMedia);
              setNodeEditorStack((prev) => prev.filter((e) => e.panelId !== panelId));
              // Clear the spinner for this panel when its editor unmounts.
              setGeneratingPanelIds((prev) => {
                if (!prev.has(panelId)) return prev;
                const next = new Set(prev);
                next.delete(panelId);
                return next;
              });
            }}
            onBusyChange={(isBusy) => {
              setGeneratingPanelIds((prev) => {
                const has = prev.has(panelId);
                if (isBusy && !has) {
                  const next = new Set(prev);
                  next.add(panelId);
                  return next;
                }
                if (!isBusy && has) {
                  const next = new Set(prev);
                  next.delete(panelId);
                  return next;
                }
                return prev;
              });
            }}
          />
        );
      })}
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
