// AI Director modal — Boardfish 6 asset-first flow.
//
// The wizard is a three-stage process:
//   1) Read the script (paste OR upload PDF / .txt / .fdx) + settings.
//   2) Ronan produces a shot list AND actor / location / prop asset lists.
//      The user reviews / edits both, then approves.
//   3) Boardfish builds the full project skeleton in one atomic dispatch:
//        - "Actors" title slide  → 6×2 storyboard, 2:3 panels, Name/Description
//        - "Locations" title slide → 3×2 storyboard, 16:9 panels, Name/Description
//        - "Props" title slide → 5×2 storyboard, 1:1 panels, Prop/Description
//        - "Storyboards" title slide → 3×2 storyboard, panels seeded from shots
//      Then asset images are generated (concurrent). Once assets exist, final
//      storyboard panels are generated with matched asset dataUrls wired in as
//      Nano Banana Pro image_urls refs (up to 6 per shot; props drop first).
//      Each final panel also gets a saved nodeGraph containing the PanelRef
//      nodes → ImageGen chain so opening the node editor shows the wiring.
//
// The panel's default 2-caption shape (Name + Description) already fits the
// spec — `Panel.fields` is a free list of `{label, value}` items.

import { useEffect, useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { resolveStoryboardSettings } from '../store';
import type { DocItem, Panel, Slide, SlideTextBox, StoryboardOverrides } from '../types';
import { newSlide } from '../types';
import {
  generatePanelImage,
  generateShotList,
  healthCheck,
  importScriptFile,
  listStyles,
  ratioToLabel,
  runFalJob,
  extractImageUrl,
  urlToDataUrl,
} from '../ai/client';
import type { StylePreset } from '../ai/client';
import type { AssetSpec, Shot, ShotList } from '../ai/types';
import { seedFinalStoryboardGraph } from '../ai/scripted-flow';

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
};

const DEFAULT_STYLE_FALLBACK: StylePreset[] = [
  { key: 'pencil-sketch', label: 'Pencil sketch', tag: '' },
  { key: 'ink-wash', label: 'Ink wash', tag: '' },
  { key: 'photoreal', label: 'Photoreal', tag: '' },
  { key: 'noir', label: 'Film noir', tag: '' },
  { key: 'anime', label: 'Anime', tag: '' },
  { key: 'watercolor', label: 'Watercolor', tag: '' },
  { key: 'comic-ink', label: 'Comic book ink', tag: '' },
  { key: 'none', label: 'No style directive', tag: '' },
];

// Section configs — used to build the "Actors / Locations / Props" storyboard
// blocks. These correspond exactly to the layout Matt specified. `aspect` is a
// panel aspect ratio (width/height); the storyboard override applies it to
// every panel in that section.
const SECTION_CONFIG = {
  actors: {
    title: 'Actors',
    grid: { h: 6, v: 2 },
    aspect: 2 / 3,
    aspectLabel: '2:3',
    fieldLabels: ['Name', 'Description'],
    // Actor gens: full-body character studies against light grey.
    styleSuffix: ', full-body character reference on a light grey (#e5e5e5) seamless studio background, neutral flat lighting, entire figure visible head to toe, standing pose, no props',
  },
  locations: {
    title: 'Locations',
    grid: { h: 3, v: 2 },
    aspect: 16 / 9,
    aspectLabel: '16:9',
    fieldLabels: ['Name', 'Description'],
    styleSuffix: ', establishing shot of the location, no people, wide angle',
  },
  props: {
    title: 'Props',
    grid: { h: 5, v: 2 },
    aspect: 1,
    aspectLabel: '1:1',
    fieldLabels: ['Prop', 'Description'],
    styleSuffix: ', product-style close-up of the object on a clean neutral background, no people, sharp focus',
  },
} as const;

type SectionKey = keyof typeof SECTION_CONFIG;

type Stage =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'proxy-down' }
  | { kind: 'importing' }
  | { kind: 'thinking' } // Ronan is working
  | { kind: 'preview'; shotList: ShotList; sessionId: string | null }
  | {
      kind: 'generating';
      phase: 'assets' | 'storyboard';
      done: number;
      total: number;
      label: string;
    };

function cryptoRandomId(): string {
  return (
    (crypto as unknown as { randomUUID?: () => string }).randomUUID?.() ??
    Math.random().toString(36).slice(2)
  );
}

// Aspect ratios exposed in the AI script drawer for the FINAL storyboard.
const ASPECT_OPTIONS: string[] = [
  '16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9',
];

// -----------------------------------------------------------------------
// Panel builders
// -----------------------------------------------------------------------

/** Build a panel for an asset (actor / location / prop). Two captions:
 *  the asset's field labels (from SECTION_CONFIG) filled with name +
 *  description. `aiPrompt` is the concrete text-to-image prompt.
 *  `styleMode: 'none'` because Ronan has already baked the global style tag
 *  into the description; we just add the section-specific framing suffix.
 */
function assetToPanel(asset: AssetSpec, section: SectionKey): Panel {
  const cfg = SECTION_CONFIG[section];
  const prompt = `${asset.description.trim()}${cfg.styleSuffix}`;
  return {
    id: cryptoRandomId(),
    imageDataUrl: null,
    imageName: null,
    cornerNote: '',
    fields: [
      { id: cryptoRandomId(), label: cfg.fieldLabels[0], value: asset.name || '' },
      { id: cryptoRandomId(), label: cfg.fieldLabels[1], value: asset.description || '' },
    ],
    aiPrompt: prompt,
    styleMode: 'none',
  };
}

function shotToPanel(shot: Shot): Panel {
  return {
    id: cryptoRandomId(),
    imageDataUrl: null,
    imageName: null,
    cornerNote: `S${String(shot.shotNumber).padStart(2, '0')}`,
    fields: [
      { id: cryptoRandomId(), label: 'Slug', value: shot.slug || '' },
      { id: cryptoRandomId(), label: 'Action', value: shot.action || '' },
      {
        id: cryptoRandomId(),
        label: 'Camera',
        value: [shot.shotType, shot.cameraMove, shot.angle].filter(Boolean).join(' · '),
      },
      { id: cryptoRandomId(), label: 'Director Note', value: shot.directorNote || '' },
    ],
    aiPrompt: shot.imagePrompt,
    styleMode: 'none',
  };
}

/** Build a title slide with a single centered text box saying `title`. */
function titleSlide(title: string): Slide {
  const s = newSlide();
  // Replace the default text box with one centered vertically + horizontally.
  const box: SlideTextBox = {
    id: cryptoRandomId(),
    text: title,
    x: 5,
    y: 40,
    width: 90,
    height: 20,
    fontFamily: 'Inter, -apple-system, sans-serif',
    fontSize: 128,
    fontWeight: 800,
    textAlign: 'center',
    italic: false,
    color: '#111111',
  };
  s.textBoxes = [box];
  return s;
}

/** Overrides for an asset section — pins the storyboard's grid + panel
 *  aspect + field-label defaults to what the section spec calls for. */
function sectionOverrides(section: SectionKey): StoryboardOverrides {
  const cfg = SECTION_CONFIG[section];
  return {
    name: cfg.title,
    grid: {
      panelsHorizontal: cfg.grid.h,
      panelsVertical: cfg.grid.v,
    },
    panelAspect: {
      panelAspectRatio: cfg.aspect,
      panelAspectLocked: true,
    },
    fields: {
      defaults: [...cfg.fieldLabels],
    },
  };
}

// -----------------------------------------------------------------------
// Reactive editable versions of the ShotList (draft-in-preview)
// -----------------------------------------------------------------------

type Draft = {
  title: string;
  directorNotes: string;
  actors: AssetSpec[];
  locations: AssetSpec[];
  props: AssetSpec[];
  shots: Shot[];
};

function shotListToDraft(sl: ShotList): Draft {
  return {
    title: sl.title || 'AI Storyboard',
    directorNotes: sl.directorNotes || '',
    actors: (sl.actors || []).filter((a) => a && a.name),
    locations: (sl.locations || []).filter((a) => a && a.name),
    props: (sl.props || []).filter((a) => a && a.name),
    shots: sl.shots || [],
  };
}

// -----------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------

export function AIDrawer({ state, dispatch, onClose }: Props) {
  const [script, setScript] = useState('');
  const [importedFilename, setImportedFilename] = useState<string | null>(null);
  const [constraints, setConstraints] = useState('');
  const [directorRefs, setDirectorRefs] = useState('');
  const [styleKey, setStyleKey] = useState<string>('pencil-sketch');
  const [styles, setStyles] = useState<StylePreset[]>([]);
  const [autoGenerateAssets, setAutoGenerateAssets] = useState(true);
  const [autoGenerateStoryboard, setAutoGenerateStoryboard] = useState(true);
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const projectDefaultAspect = (() => {
    const sel = state.items.find((it) => it.id === state.selectedItemId);
    const sb = sel && sel.kind === 'storyboard' ? sel : null;
    const ratio = sb
      ? resolveStoryboardSettings(state.settings, sb).panelAspectRatio
      : state.settings.panelAspectRatio;
    return ratioToLabel(ratio);
  })();
  const [aspect, setAspect] = useState<string>(projectDefaultAspect);
  const effectiveAspect = aspect;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await healthCheck();
      if (cancelled) return;
      setStage(ok ? { kind: 'idle' } : { kind: 'proxy-down' });
      if (ok) {
        const list = await listStyles();
        if (!cancelled && list.length > 0) setStyles(list);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === 'Escape' &&
        stage.kind !== 'thinking' &&
        stage.kind !== 'generating' &&
        stage.kind !== 'importing'
      ) {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stage.kind]);

  // ------- File import -------

  async function handleImportFile(file: File) {
    setError(null);
    setStage({ kind: 'importing' });
    try {
      const res = await importScriptFile(file);
      setScript((prev) => (prev.trim() ? prev + '\n\n' + res.text : res.text));
      setImportedFilename(res.filename);
      setStage({ kind: 'idle' });
    } catch (err) {
      setError(`Import failed: ${String((err as Error).message || err)}`);
      setStage({ kind: 'idle' });
    }
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleImportFile(file);
    e.target.value = ''; // let the user pick the same file again if needed
  }

  // ------- Ronan: shot list + assets -------

  async function handleGenerateShotList() {
    setError(null);
    setStage({ kind: 'thinking' });
    try {
      const { shotList, sessionId } = await generateShotList({
        script: script.trim(),
        defaultAspect: effectiveAspect,
        constraints: constraints.trim() || undefined,
        directorRefs: directorRefs.trim() || undefined,
        styleKey,
      });
      setStage({ kind: 'preview', shotList, sessionId });
    } catch (err) {
      setError(String((err as Error).message || err));
      setStage({ kind: 'idle' });
    }
  }

  // ------- Build project + generate images -------

  async function handleCreateProject(draft: Draft) {
    // 1) Build every item first so we know the panel ids before we dispatch.
    const actorSlide: DocItem = { id: cryptoRandomId(), kind: 'slide', slide: titleSlide('Actors') };
    const actorPanels: Panel[] = draft.actors.map((a) => assetToPanel(a, 'actors'));
    const actorSb: DocItem = {
      id: cryptoRandomId(),
      kind: 'storyboard',
      panels: actorPanels,
      overrides: sectionOverrides('actors'),
    };

    const locSlide: DocItem = { id: cryptoRandomId(), kind: 'slide', slide: titleSlide('Locations') };
    const locPanels: Panel[] = draft.locations.map((a) => assetToPanel(a, 'locations'));
    const locSb: DocItem = {
      id: cryptoRandomId(),
      kind: 'storyboard',
      panels: locPanels,
      overrides: sectionOverrides('locations'),
    };

    const propSlide: DocItem = { id: cryptoRandomId(), kind: 'slide', slide: titleSlide('Props') };
    const propPanels: Panel[] = draft.props.map((a) => assetToPanel(a, 'props'));
    const propSb: DocItem = {
      id: cryptoRandomId(),
      kind: 'storyboard',
      panels: propPanels,
      overrides: sectionOverrides('props'),
    };

    const storyboardSlide: DocItem = {
      id: cryptoRandomId(),
      kind: 'slide',
      slide: titleSlide('Storyboards'),
    };
    const shotPanels: Panel[] = draft.shots.map(shotToPanel);
    const finalSb: DocItem = {
      id: cryptoRandomId(),
      kind: 'storyboard',
      panels: shotPanels,
      overrides: { name: draft.title || 'Storyboards' },
    };

    // Skip empty sections so we don't clutter the doc with lonely title slides
    // if the script has no props (e.g. dialogue-only scenes).
    const items: DocItem[] = [];
    if (actorPanels.length > 0) items.push(actorSlide, actorSb);
    if (locPanels.length > 0) items.push(locSlide, locSb);
    if (propPanels.length > 0) items.push(propSlide, propSb);
    items.push(storyboardSlide, finalSb);

    dispatch({ type: 'APPEND_ITEMS', items, selectItemId: finalSb.id });

    // 2) Now generate images. Assets first (so refs are ready), then finals.
    const assetJobs: { panelId: string; prompt: string; aspect: string }[] = [];
    for (const p of actorPanels) {
      if (p.aiPrompt) assetJobs.push({ panelId: p.id, prompt: p.aiPrompt, aspect: SECTION_CONFIG.actors.aspectLabel });
    }
    for (const p of locPanels) {
      if (p.aiPrompt) assetJobs.push({ panelId: p.id, prompt: p.aiPrompt, aspect: SECTION_CONFIG.locations.aspectLabel });
    }
    for (const p of propPanels) {
      if (p.aiPrompt) assetJobs.push({ panelId: p.id, prompt: p.aiPrompt, aspect: SECTION_CONFIG.props.aspectLabel });
    }

    // Track produced asset dataUrls so we can wire them into final storyboard
    // Nano Banana calls. Keyed by asset NAME (normalized) so shot.refs entries
    // can find them regardless of case / whitespace.
    const assetIndex = new Map<string, { panelId: string; dataUrl: string; kind: SectionKey }>();
    const assetNameByPanelId = new Map<string, { name: string; kind: SectionKey }>();
    for (const [kind, panels, list] of [
      ['actors', actorPanels, draft.actors] as const,
      ['locations', locPanels, draft.locations] as const,
      ['props', propPanels, draft.props] as const,
    ]) {
      panels.forEach((p, i) => {
        const name = list[i]?.name;
        if (name) assetNameByPanelId.set(p.id, { name, kind: kind as SectionKey });
      });
    }

    if (autoGenerateAssets && assetJobs.length > 0) {
      setStage({
        kind: 'generating',
        phase: 'assets',
        done: 0,
        total: assetJobs.length,
        label: `generating ${assetJobs.length} asset${assetJobs.length === 1 ? '' : 's'}…`,
      });
      let done = 0;
      const CONCURRENCY = 5;
      await runWithConcurrency(assetJobs, CONCURRENCY, async (job) => {
        try {
          const img = await generatePanelImage({ prompt: job.prompt, aspectRatio: job.aspect });
          dispatch({
            type: 'APPLY_AI_IMAGE',
            panelId: job.panelId,
            dataUrl: img.dataUrl,
            imageName: `AI asset ${job.panelId.slice(0, 6)}.jpg`,
            prompt: job.prompt,
            generatedAt: Date.now(),
          });
          const meta = assetNameByPanelId.get(job.panelId);
          if (meta) {
            assetIndex.set(normalizeName(meta.name), {
              panelId: job.panelId,
              dataUrl: img.dataUrl,
              kind: meta.kind,
            });
          }
        } catch (err) {
          console.warn('[ai] asset image gen failed', job.panelId, err);
        } finally {
          done += 1;
          setStage({
            kind: 'generating',
            phase: 'assets',
            done,
            total: assetJobs.length,
            label: `${done} of ${assetJobs.length} assets`,
          });
        }
      });
    }

    // 3) Final storyboard panels — each pulls matched assets in as refs.
    if (autoGenerateStoryboard) {
      const shotJobs = draft.shots
        .map((shot, i) => ({ shot, panel: shotPanels[i] }))
        .filter((j) => j.panel.aiPrompt);
      setStage({
        kind: 'generating',
        phase: 'storyboard',
        done: 0,
        total: shotJobs.length,
        label: `generating ${shotJobs.length} storyboard panel${shotJobs.length === 1 ? '' : 's'}…`,
      });
      let done = 0;
      const CONCURRENCY = 5;
      await runWithConcurrency(shotJobs, CONCURRENCY, async ({ shot, panel }) => {
        try {
          const refs = pickRefsForShot(shot, assetIndex);
          const graph = seedFinalStoryboardGraph({
            prompt: panel.aiPrompt!,
            aspectRatio: effectiveAspect,
            refs: refs.map((r) => ({ panelId: r.panelId, imageDataUrl: r.dataUrl, label: r.name })),
          });
          let dataUrl: string;
          if (refs.length > 0) {
            // Reference edit endpoint — Nano Banana Pro /edit.
            const result = await runFalJob('fal-ai/nano-banana-pro/edit', {
              prompt: panel.aiPrompt!,
              aspect_ratio: effectiveAspect,
              num_images: 1,
              output_format: 'png',
              image_urls: refs.map((r) => r.dataUrl),
            });
            const url = extractImageUrl(result.result);
            if (!url) throw new Error('no image url in fal result');
            const { dataUrl: du } = await urlToDataUrl(url);
            dataUrl = du;
          } else {
            const img = await generatePanelImage({ prompt: panel.aiPrompt!, aspectRatio: effectiveAspect });
            dataUrl = img.dataUrl;
          }
          dispatch({
            type: 'APPLY_AI_IMAGE',
            panelId: panel.id,
            dataUrl,
            imageName: `AI storyboard ${panel.id.slice(0, 6)}.png`,
            prompt: panel.aiPrompt!,
            generatedAt: Date.now(),
          });
          // Also stash the seeded node graph so opening the node editor
          // shows the PanelRef → ImageGen wiring already in place.
          dispatch({ type: 'SET_PANEL_NODE_GRAPH', panelId: panel.id, graph });
        } catch (err) {
          console.warn('[ai] storyboard image gen failed', panel.id, err);
        } finally {
          done += 1;
          setStage({
            kind: 'generating',
            phase: 'storyboard',
            done,
            total: shotJobs.length,
            label: `${done} of ${shotJobs.length} storyboard panels`,
          });
        }
      });
    }

    setTimeout(() => onClose(), 700);
  }

  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = items.slice();
    const workers: Promise<void>[] = [];
    const step = async (): Promise<void> => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        await fn(next);
      }
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(step());
    await Promise.all(workers);
  }

  // ------- Generating HUD -------

  if (stage.kind === 'generating') {
    return (
      <GeneratingHUD
        phase={stage.phase}
        done={stage.done}
        total={stage.total}
        label={stage.label}
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className="ai-drawer-backdrop"
      onClick={(e) => {
        if (
          e.target === e.currentTarget &&
          stage.kind !== 'thinking' &&
          stage.kind !== 'importing'
        )
          onClose();
      }}
    >
      <div className="ai-drawer" style={{ maxWidth: 960 }}>
        <div className="ai-drawer-header">
          <h2>AI Director · Ronan</h2>
          <button
            className="ai-drawer-close"
            onClick={onClose}
            disabled={stage.kind === 'thinking' || stage.kind === 'importing'}
          >
            ✕
          </button>
        </div>

        {stage.kind === 'checking' && (
          <div className="ai-drawer-body">
            <p className="ai-muted">Checking AI proxy…</p>
          </div>
        )}

        {stage.kind === 'proxy-down' && (
          <div className="ai-drawer-body">
            <p className="ai-error">AI proxy isn't running.</p>
            <p className="ai-muted">Start it in a terminal:</p>
            <pre className="ai-code">cd ai-proxy && npm start</pre>
            <p className="ai-muted">Then reopen this dialog.</p>
          </div>
        )}

        {stage.kind === 'importing' && (
          <div className="ai-drawer-body">
            <p className="ai-muted">Extracting text from your file…</p>
          </div>
        )}

        {stage.kind === 'idle' && (
          <div className="ai-drawer-body">
            <div className="ai-row">
              <label className="ai-label" style={{ flex: 1 }}>
                Script <span className="ai-muted small">— paste OR import</span>
              </label>
              <button
                type="button"
                className="ai-btn-secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                📄 Import PDF / .txt / .fdx…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.fdx,.fountain,.md,application/pdf,text/plain"
                style={{ display: 'none' }}
                onChange={onFileChosen}
              />
            </div>
            {importedFilename && (
              <p className="ai-muted small" style={{ marginTop: -4 }}>
                Imported: <code>{importedFilename}</code>
              </p>
            )}
            <textarea
              className="ai-textarea"
              rows={12}
              placeholder="Paste your script here, or import a PDF / .txt / .fdx above. Ronan will read it, then extract actors, locations, and props before drafting the shot list."
              value={script}
              onChange={(e) => setScript(e.target.value)}
            />
            <label className="ai-label">Director / artist references (optional)</label>
            <input
              className="ai-input"
              type="text"
              placeholder="e.g. Wes Anderson, Roger Deakins, Sofia Coppola, Miyazaki…"
              value={directorRefs}
              onChange={(e) => setDirectorRefs(e.target.value)}
            />
            <label className="ai-label">Visual style</label>
            <div className="ai-style-picker">
              {(styles.length > 0 ? styles : DEFAULT_STYLE_FALLBACK).map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={`ai-style-btn ${styleKey === s.key ? 'active' : ''}`}
                  title={s.tag || 'No style directive appended'}
                  onClick={() => setStyleKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="ai-muted small" style={{ marginTop: -4 }}>
              The same style is applied to actors, locations, props, AND the final storyboards. Change it later per-panel from the AI editor.
            </p>
            <label className="ai-label">Storyboard aspect ratio</label>
            <div className="ai-style-picker">
              {ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`ai-style-btn ${aspect === opt ? 'active' : ''}`}
                  title={`Render final storyboard panels at ${opt}${opt === projectDefaultAspect ? ' (project default)' : ''}`}
                  onClick={() => setAspect(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
            <p className="ai-muted small" style={{ marginTop: -4 }}>
              Assets have fixed aspects: actors 2:3, locations 16:9, props 1:1.
            </p>
            <label className="ai-label">
              Optional direction (e.g. “more Hitchcock,” “color, not b&w,” “handheld throughout”)
            </label>
            <input
              className="ai-input"
              type="text"
              placeholder="leave blank for Ronan's own call"
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
            />
            <div className="ai-row">
              <label className="ai-checkbox">
                <input
                  type="checkbox"
                  checked={autoGenerateAssets}
                  onChange={(e) => setAutoGenerateAssets(e.target.checked)}
                />
                Auto-generate asset images (actors, locations, props)
              </label>
            </div>
            <div className="ai-row">
              <label className="ai-checkbox">
                <input
                  type="checkbox"
                  checked={autoGenerateStoryboard}
                  onChange={(e) => setAutoGenerateStoryboard(e.target.checked)}
                />
                Auto-generate final storyboard panels using assets as references
              </label>
            </div>
            {error && <p className="ai-error">{error}</p>}
            <div className="ai-actions">
              <button className="ai-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="ai-btn-primary"
                onClick={handleGenerateShotList}
                disabled={!script.trim()}
              >
                Generate shot list + assets
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'thinking' && (
          <div className="ai-drawer-body">
            <p>🎬 Ronan is reading the script and thinking through the coverage…</p>
            <p className="ai-muted small">
              (10–40 seconds. He's identifying the cast, locations, key props, and picking camera language.)
            </p>
          </div>
        )}

        {stage.kind === 'preview' && (
          <PreviewPane
            initialDraft={shotListToDraft(stage.shotList)}
            onBack={() => setStage({ kind: 'idle' })}
            onCreate={(draft) => handleCreateProject(draft)}
            autoAssets={autoGenerateAssets}
            autoStoryboard={autoGenerateStoryboard}
          />
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Preview: editable draft of everything Ronan produced
// -----------------------------------------------------------------------

function PreviewPane({
  initialDraft,
  onBack,
  onCreate,
  autoAssets,
  autoStoryboard,
}: {
  initialDraft: Draft;
  onBack: () => void;
  onCreate: (draft: Draft) => void;
  autoAssets: boolean;
  autoStoryboard: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [tab, setTab] = useState<'shots' | 'actors' | 'locations' | 'props'>('shots');

  function updateAsset(key: 'actors' | 'locations' | 'props', idx: number, patch: Partial<AssetSpec>) {
    setDraft((d) => ({
      ...d,
      [key]: d[key].map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    }));
  }
  function removeAsset(key: 'actors' | 'locations' | 'props', idx: number) {
    setDraft((d) => ({ ...d, [key]: d[key].filter((_, i) => i !== idx) }));
  }
  function addAsset(key: 'actors' | 'locations' | 'props') {
    setDraft((d) => ({ ...d, [key]: [...d[key], { name: '', description: '' }] }));
  }

  function updateShot(idx: number, patch: Partial<Shot>) {
    setDraft((d) => ({
      ...d,
      shots: d.shots.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  }

  const createLabel = (() => {
    const bits: string[] = ['Create project'];
    if (autoAssets) bits.push('+ generate assets');
    if (autoStoryboard) bits.push('+ storyboard');
    return bits.join(' ');
  })();

  return (
    <div className="ai-drawer-body">
      <h3 className="ai-h3">{draft.title}</h3>
      <p className="ai-muted">{draft.directorNotes}</p>

      <div className="ai-preview-tabs">
        {(['shots', 'actors', 'locations', 'props'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`ai-preview-tab ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
          >
            {k === 'shots'
              ? `Shots (${draft.shots.length})`
              : k === 'actors'
                ? `Actors (${draft.actors.length})`
                : k === 'locations'
                  ? `Locations (${draft.locations.length})`
                  : `Props (${draft.props.length})`}
          </button>
        ))}
      </div>

      {tab === 'shots' && (
        <div className="ai-shot-list">
          {draft.shots.map((s, i) => (
            <ShotRow key={s.shotNumber} shot={s} onChange={(next) => updateShot(i, next)} />
          ))}
        </div>
      )}

      {(tab === 'actors' || tab === 'locations' || tab === 'props') && (
        <AssetEditor
          section={tab}
          assets={draft[tab]}
          onChange={(idx, patch) => updateAsset(tab, idx, patch)}
          onRemove={(idx) => removeAsset(tab, idx)}
          onAdd={() => addAsset(tab)}
        />
      )}

      <div className="ai-actions">
        <button className="ai-btn-secondary" onClick={onBack}>
          Back / new script
        </button>
        <button className="ai-btn-primary" onClick={() => onCreate(draft)}>
          {createLabel}
        </button>
      </div>
    </div>
  );
}

function AssetEditor({
  section,
  assets,
  onChange,
  onRemove,
  onAdd,
}: {
  section: 'actors' | 'locations' | 'props';
  assets: AssetSpec[];
  onChange: (idx: number, patch: Partial<AssetSpec>) => void;
  onRemove: (idx: number) => void;
  onAdd: () => void;
}) {
  const cfg = SECTION_CONFIG[section];
  return (
    <div className="ai-asset-editor">
      <p className="ai-muted small" style={{ marginTop: 0 }}>
        {cfg.grid.h}×{cfg.grid.v} grid · {cfg.aspectLabel} panels ·{' '}
        {cfg.fieldLabels.join(' + ')}
      </p>
      <div className="ai-asset-list">
        {assets.map((a, i) => (
          <div key={i} className="ai-asset-row">
            <input
              className="ai-input"
              type="text"
              placeholder={cfg.fieldLabels[0]}
              value={a.name}
              onChange={(e) => onChange(i, { name: e.target.value })}
              style={{ maxWidth: 200 }}
            />
            <textarea
              className="ai-textarea small"
              rows={2}
              placeholder={cfg.fieldLabels[1]}
              value={a.description}
              onChange={(e) => onChange(i, { description: e.target.value })}
            />
            <button
              type="button"
              className="ai-btn-secondary ai-btn-icon"
              title="Remove"
              onClick={() => onRemove(i)}
            >
              ✕
            </button>
          </div>
        ))}
        {assets.length === 0 && (
          <p className="ai-muted small">
            No {section} extracted. Click “+ Add” if you want any.
          </p>
        )}
      </div>
      <button type="button" className="ai-btn-secondary" onClick={onAdd}>
        + Add {section.slice(0, -1)}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------
// Ref matching
// -----------------------------------------------------------------------

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s._-]+/g, ' ');
}

/**
 * Given a shot and the asset index, produce the ref list to pass to Nano
 * Banana Pro's /edit endpoint. Rules:
 *   - Nano Banana Pro image_urls cap: 6. If more matched, drop props first,
 *     then extra locations, then extra actors (keeping earlier entries).
 *   - Prefer refs from shot.refs (Ronan's own extraction). If that's empty,
 *     do a case-insensitive substring match against the shot's prompt +
 *     action text against every asset name.
 */
function pickRefsForShot(
  shot: Shot,
  assetIndex: Map<string, { panelId: string; dataUrl: string; kind: SectionKey }>,
): { panelId: string; dataUrl: string; kind: SectionKey; name: string }[] {
  const chosen: { panelId: string; dataUrl: string; kind: SectionKey; name: string }[] = [];
  const seen = new Set<string>();

  function add(name: string) {
    const key = normalizeName(name);
    if (seen.has(key)) return;
    const hit = assetIndex.get(key);
    if (!hit) return;
    seen.add(key);
    chosen.push({ ...hit, name });
  }

  const refs = shot.refs || {};
  for (const n of refs.actors || []) add(n);
  for (const n of refs.locations || []) add(n);
  for (const n of refs.props || []) add(n);

  if (chosen.length === 0) {
    // Fallback: fuzzy scan the prompt/action text.
    const hay = `${shot.imagePrompt || ''} ${shot.action || ''}`.toLowerCase();
    for (const [normName, hit] of assetIndex) {
      // Word-boundary-ish match — avoid matching "Al" inside "Alarm".
      const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(normName)}([^a-z0-9]|$)`, 'i');
      if (re.test(hay)) {
        seen.add(normName);
        chosen.push({ ...hit, name: normName });
      }
    }
  }

  // Cap at 6 — drop props first, then extra locations, keeping actors.
  if (chosen.length > 6) {
    const actors = chosen.filter((c) => c.kind === 'actors');
    const locations = chosen.filter((c) => c.kind === 'locations');
    const props = chosen.filter((c) => c.kind === 'props');
    const out: typeof chosen = [];
    for (const a of actors) if (out.length < 6) out.push(a);
    for (const l of locations) if (out.length < 6) out.push(l);
    for (const p of props) if (out.length < 6) out.push(p);
    return out;
  }
  return chosen;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------
// Generating HUD
// -----------------------------------------------------------------------

function GeneratingHUD({
  phase,
  done,
  total,
  label,
  onClose,
}: {
  phase: 'assets' | 'storyboard';
  done: number;
  total: number;
  label: string;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 20, y: 80 });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    setPos({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  const pct = Math.round((done / Math.max(1, total)) * 100);
  const phaseLabel = phase === 'assets' ? '🎨 Generating assets' : '🎬 Generating storyboard';

  return (
    <div
      className="ai-generating-hud"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="ai-generating-hud-head">
        <span>{phaseLabel}</span>
        <button
          type="button"
          className="ai-generating-hud-close"
          title="Hide (generation continues in background)"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ✕
        </button>
      </div>
      <div className="ai-generating-hud-progress-wrap">
        <div className="ai-generating-hud-progress" style={{ width: `${pct}%` }} />
      </div>
      <div className="ai-generating-hud-status">
        <span>
          {done} / {total}
        </span>
        <span className="ai-generating-hud-label">{label}</span>
      </div>
      <div className="ai-generating-hud-hint">
        Drag to move · scroll the storyboard to watch panels fill in live
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Shot row (reused from v5)
// -----------------------------------------------------------------------

function ShotRow({ shot, onChange }: { shot: Shot; onChange: (next: Shot) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ai-shot-row">
      <div className="ai-shot-row-head" onClick={() => setExpanded((v) => !v)}>
        <span className="ai-shot-num">{String(shot.shotNumber).padStart(2, '0')}</span>
        <span className="ai-shot-slug">{shot.slug}</span>
        <span className="ai-shot-tags">
          {shot.shotType && <span className="ai-tag">{shot.shotType}</span>}
          {shot.cameraMove && <span className="ai-tag">{shot.cameraMove}</span>}
          {shot.aspectRatio && <span className="ai-tag">{shot.aspectRatio}</span>}
          {shot.refs && [
            ...(shot.refs.actors || []),
            ...(shot.refs.locations || []),
            ...(shot.refs.props || []),
          ].slice(0, 3).map((n) => (
            <span key={n} className="ai-tag ai-tag-ref" title="Referenced asset">
              🔗 {n}
            </span>
          ))}
        </span>
        <span className="ai-shot-toggle">{expanded ? '−' : '+'}</span>
      </div>
      <div className="ai-shot-action">{shot.action}</div>
      {expanded && (
        <div className="ai-shot-detail">
          <label className="ai-label">Image prompt (edit before create)</label>
          <textarea
            className="ai-textarea small"
            rows={3}
            value={shot.imagePrompt}
            onChange={(e) => onChange({ ...shot, imagePrompt: e.target.value })}
          />
          {shot.directorNote && <p className="ai-muted small">🎬 {shot.directorNote}</p>}
        </div>
      )}
    </div>
  );
}
