// Spacebar-triggered full-screen preview of the currently-selected panel.
// Image renders at same crop/fit settings as canvas; captions can be toggled;
// arrow keys navigate prev/next PANEL (never variations); Esc closes.
//
// Modes:
//   single  — the classic closeup preview (current image + optional captions)
//   grid    — thumbnail grid of the panel's imageHistory + current; click to pick,
//             double-click to jump back to single view on that version
//   compare — side-by-side of picked versions, each zoomable (wheel) + pannable

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Panel, PanelImageVersion, ProjectSettings } from '../types';
import type { Action } from '../store';

type Props = {
  panel: Panel;
  panelIndex: number; // 1-based global index
  totalPanels: number;
  settings: ProjectSettings;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
  onNavigate: (dir: 1 | -1) => void;
};

type LightboxMode = 'single' | 'grid' | 'compare';

/**
 * Build the frame list for grid/compare from a panel's history + current.
 * Order: current first, then imageHistory newest→oldest.
 * (Matches NodeEditor's fullscreen convention: index 0 = current.)
 *
 * Both image and video versions are included. `videoDataUrl` on the synthetic
 * `current` entry is populated when the panel currently has a video.
 */
function framesFor(panel: Panel): PanelImageVersion[] {
  const out: PanelImageVersion[] = [];
  if (panel.videoDataUrl) {
    out.push({
      id: 'current',
      dataUrl: panel.imageDataUrl ?? '',
      videoDataUrl: panel.videoDataUrl,
      kind: 'video',
      prompt: panel.aiPrompt ?? '',
      generatedAt: 0,
      seq: panel.currentImageSeq,
    });
  } else if (panel.imageDataUrl) {
    out.push({
      id: 'current',
      dataUrl: panel.imageDataUrl,
      kind: 'image',
      prompt: panel.aiPrompt ?? '',
      generatedAt: 0,
      seq: panel.currentImageSeq,
    });
  }
  const hist = Array.isArray(panel.imageHistory) ? panel.imageHistory : [];
  // Newest → oldest so v(N) shows near the top.
  const sorted = [...hist].sort((a, b) => b.generatedAt - a.generatedAt);
  out.push(...sorted);
  return out;
}

/**
 * Resolve a stable version number for each frame. If a frame already has
 * `seq`, use it. Otherwise backfill unsequenced entries by their
 * `generatedAt` order so legacy panels get consistent v1..vN labels. The
 * synthetic `current` frame's `generatedAt` is 0; we treat it as the
 * newest for backfill purposes so it always lands on the highest number.
 */
function resolveVersionSeqs(frames: PanelImageVersion[]): number[] {
  const taken = new Set<number>();
  for (const f of frames) {
    if (typeof f.seq === 'number' && Number.isFinite(f.seq)) taken.add(f.seq);
  }
  // Sort unsequenced entries by generatedAt ascending so the oldest gets
  // the lowest backfill number.
  const unseqIdx = frames
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !(typeof f.seq === 'number' && Number.isFinite(f.seq)))
    .sort((a, b) => {
      // Treat id === 'current' as "newest" (higher ts) for backfill purposes
      // so it doesn't collide with a real history entry's timestamp of 0.
      const at = a.f.id === 'current' ? Number.POSITIVE_INFINITY : a.f.generatedAt;
      const bt = b.f.id === 'current' ? Number.POSITIVE_INFINITY : b.f.generatedAt;
      return at - bt;
    });
  const backfill = new Map<number, number>();
  let next = 1;
  for (const { i } of unseqIdx) {
    while (taken.has(next)) next += 1;
    backfill.set(i, next);
    taken.add(next);
    next += 1;
  }
  return frames.map((f, i) => {
    if (typeof f.seq === 'number' && Number.isFinite(f.seq)) return f.seq;
    return backfill.get(i) ?? i + 1;
  });
}

function compareColsFor(n: number): number {
  if (n <= 1) return 1;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

/** Zoomable/pannable frame — copy of NodeEditor's ZoomableFrame, sized to a cell.
 *  Scroll = zoom to cursor, drag = pan, double-click = reset. */
function ZoomableImage({ url, videoUrl }: { url: string; videoUrl?: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [panning, setPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setScale((s) => {
        const next = Math.min(8, Math.max(1, s * factor));
        if (next === s) return s;
        const ratio = next / s;
        setTx((t) => (t + (cx - t) * (1 - ratio)));
        setTy((t) => (t + (cy - t) * (1 - ratio)));
        if (next <= 1.0001) { setTx(0); setTy(0); }
        return next;
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (scale <= 1.0001) return;
    if (e.button !== 0) return;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    panStart.current = { x: e.clientX, y: e.clientY, tx, ty };
    setPanning(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!panning || !panStart.current) return;
    setTx(panStart.current.tx + (e.clientX - panStart.current.x));
    setTy(panStart.current.ty + (e.clientY - panStart.current.y));
  }
  function endPan(e: React.PointerEvent<HTMLDivElement>) {
    if (!panning) return;
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setPanning(false);
    panStart.current = null;
  }
  function onDoubleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setScale(1); setTx(0); setTy(0);
  }

  const zoomed = scale > 1.0001;
  return (
    <div
      ref={wrapRef}
      className={`ne-fs-compare-frame ${zoomed ? 'is-zoomed' : ''} ${panning ? 'is-panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={onDoubleClick}
    >
      {videoUrl ? (
        <video
          src={videoUrl}
          controls={!zoomed}
          loop
          playsInline
          poster={url || undefined}
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      ) : (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        />
      )}
      <div className="ne-fs-compare-zoom-hud">
        {Math.round(scale * 100)}%
        {zoomed ? ' · drag to pan · dbl-click to reset' : ' · scroll to zoom'}
      </div>
    </div>
  );
}

export function PanelLightbox({
  panel,
  panelIndex,
  totalPanels,
  settings,
  dispatch,
  onClose,
  onNavigate,
}: Props) {
  const objectFit: 'contain' | 'fill' | 'cover' =
    settings.imageFit === 'fill' ? 'fill' : settings.imageFit === 'crop' ? 'cover' : 'contain';

  const badges = settings.panelBadges;
  const numberText = badges.useNumberPrefix
    ? `${badges.numberPrefix}${String(panelIndex).padStart(2, '0')}`
    : String(panelIndex).padStart(2, '0');

  // Local UI state.
  const [showCaptions, setShowCaptions] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('boardfish:lightboxCaptions:v2');
      return raw === null ? false : raw === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try { localStorage.setItem('boardfish:lightboxCaptions:v2', String(showCaptions)); } catch { /* ignore */ }
  }, [showCaptions]);

  const [mode, setMode] = useState<LightboxMode>('single');
  const [gridSize, setGridSize] = useState<number>(220);
  const [picks, setPicks] = useState<Set<string>>(new Set());

  // When the user navigates to a different panel, snap back to single-view and
  // clear picks — different panel has a different set of versions.
  useEffect(() => {
    setMode('single');
    setPicks(new Set());
  }, [panel.id]);

  const frames = useMemo(() => framesFor(panel), [panel]);
  const frameSeqs = useMemo(() => resolveVersionSeqs(frames), [frames]);
  const canCompare = frames.length >= 2;

  // Arrow keys ALWAYS move between panels (never between variations). C toggles
  // captions in single view. G/V switch to grid/single. Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onNavigate(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onNavigate(-1);
      } else if (e.key === 'Escape') {
        // In grid/compare, Escape steps back to single; in single, close.
        if (mode !== 'single') {
          e.preventDefault();
          setMode('single');
        }
        // else: parent handles Escape close via its own listener
      } else if (e.key.toLowerCase() === 'c' && mode === 'single') {
        e.preventDefault();
        setShowCaptions((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate, mode]);

  function togglePick(id: string) {
    setPicks((prev) => {
      const nx = new Set(prev);
      if (nx.has(id)) nx.delete(id);
      else nx.add(id);
      return nx;
    });
  }

  const compareList = mode === 'compare'
    ? frames.filter((f) => picks.has(f.id))
    : [];

  // Backdrop: keep the storyboard canvas background for single view (so panel
  // padding blends), but switch to the fullscreen-editor dark backdrop for
  // grid/compare so it feels like the same viewer as the node editor.
  const backdropBg = mode === 'single' ? settings.colors.canvasBg : 'rgba(6, 6, 8, 0.94)';

  return (
    <div
      className="lightbox-backdrop"
      onClick={onClose}
      style={{
        background: backdropBg,
        // grid/compare need a column layout for the toolbar row + body
        flexDirection: mode === 'single' ? 'row' : 'column',
        alignItems: mode === 'single' ? 'center' : 'stretch',
        justifyContent: mode === 'single' ? 'center' : 'flex-start',
        padding: mode === 'single' ? '5vh 5vw' : 0,
      }}
    >
      {/* Mode toolbar — shown in all modes EXCEPT single-view-with-captions
          (captions area needs the vertical space and would otherwise be
          obscured by the floating pill). Sits as a blurred pill floating
          above the panel in single view; solid row in grid/compare. */}
      {!(mode === 'single' && showCaptions) && (
      <div
        className="ne-fs-toolbar"
        onClick={(e) => e.stopPropagation()}
        style={mode === 'single' ? {
          position: 'fixed',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(20, 20, 24, 0.85)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10,
          minHeight: 0,
          padding: '6px 10px',
          zIndex: 1100,
          backdropFilter: 'blur(8px)',
        } : undefined}
      >
        <div className="ne-fs-toolbar-group">
          <button
            className={`ne-fs-tab ${mode === 'single' ? 'is-active' : ''}`}
            onClick={() => setMode('single')}
            title="Single panel view"
          >
            View
          </button>
          <button
            className={`ne-fs-tab ${mode === 'grid' ? 'is-active' : ''}`}
            onClick={() => setMode('grid')}
            title="Grid of this panel's versions"
            disabled={frames.length < 2}
          >
            ▦ Grid
          </button>
          <button
            className={`ne-fs-tab ${mode === 'compare' ? 'is-active' : ''}`}
            onClick={() => {
              if (!canCompare) return;
              if (picks.size === 0) {
                const seed = new Set<string>();
                frames.slice(0, 2).forEach((f) => seed.add(f.id));
                setPicks(seed);
              }
              setMode('compare');
            }}
            title="Compare selected versions side-by-side"
            disabled={!canCompare}
          >
            ⇔ Compare
            {picks.size > 0 ? <span className="ne-fs-tab-badge">{picks.size}</span> : null}
          </button>
        </div>

        {mode === 'grid' && (
          <div className="ne-fs-toolbar-group">
            <span className="ne-fs-tool-label">Tile size</span>
            <input
              className="ne-fs-slider"
              type="range"
              min={100}
              max={480}
              step={10}
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
            />
            <span className="ne-fs-tool-value">{gridSize}px</span>
            {picks.size > 0 && (
              <button
                className="ne-fs-tab"
                onClick={() => setMode('compare')}
                title="Compare picked versions"
              >
                Compare {picks.size}
              </button>
            )}
          </div>
        )}

        {mode === 'compare' && (
          <div className="ne-fs-toolbar-group">
            <span className="ne-fs-tool-label">{compareList.length} selected</span>
            <button
              className="ne-fs-tab"
              onClick={() => { setPicks(new Set()); setMode('grid'); }}
              title="Back to grid to change selection"
            >
              Change picks
            </button>
          </div>
        )}

        <button
          className="ne-fullscreen-close"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      )}

      {mode === 'single' && (
        <>
          <button
            className="lightbox-nav lightbox-nav-prev"
            title="Previous panel (←)"
            disabled={totalPanels < 2}
            onClick={(e) => { e.stopPropagation(); onNavigate(-1); }}
            aria-label="Previous panel"
          >
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <path d="M20 4 L8 16 L20 28 M8 16 L28 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="lightbox-nav lightbox-nav-next"
            title="Next panel (→)"
            disabled={totalPanels < 2}
            onClick={(e) => { e.stopPropagation(); onNavigate(1); }}
            aria-label="Next panel"
          >
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <path d="M12 4 L24 16 L12 28 M24 16 L4 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <button
            className="lightbox-toggle-captions"
            title={`${showCaptions ? 'Hide' : 'Show'} captions (C)`}
            onClick={(e) => { e.stopPropagation(); setShowCaptions((v) => !v); }}
          >
            {showCaptions ? 'Hide captions' : 'Show captions'}
          </button>

          <div
            className={`lightbox-panel ${showCaptions ? 'with-captions' : 'no-captions'}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: showCaptions ? settings.colors.panelBg : 'transparent',
              color: settings.colors.text,
              fontFamily: settings.fonts.family,
            }}
          >
            {showCaptions && (badges.showNumber || badges.showCornerNote) && (
              <div
                className="panel-header"
                style={{
                  color: settings.colors.panelLabel,
                  fontSize: settings.fonts.panelLabelSizePx * 2.4,
                  fontFamily: settings.fonts.family,
                  fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
                  fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
                  padding: '10px 16px',
                }}
              >
                <div className="panel-header-left">{badges.showNumber ? numberText : ''}</div>
                <div className="panel-header-right">
                  {badges.showCornerNote && (
                    <div className="panel-header-note-wrap">
                      {badges.useCornerNotePrefix && badges.cornerNotePrefix && (
                        <span className="panel-header-note-prefix">{badges.cornerNotePrefix}</span>
                      )}
                      <input
                        className="panel-header-note"
                        style={{
                          color: settings.colors.panelLabel,
                          fontSize: settings.fonts.panelLabelSizePx * 2.4,
                          fontFamily: settings.fonts.family,
                          fontWeight: settings.fonts.panelLabelBold ? 700 : 500,
                          fontStyle: settings.fonts.panelLabelItalic ? 'italic' : 'normal',
                        }}
                        value={panel.cornerNote}
                        placeholder="note"
                        onChange={(e) => dispatch({ type: 'SET_CORNER_NOTE', panelId: panel.id, value: e.target.value })}
                        spellCheck={false}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div
              className="lightbox-image"
              style={{
                aspectRatio: `${settings.panelAspectRatio}`,
                background: showCaptions ? '#000' : 'transparent',
              }}
            >
              {panel.videoDataUrl ? (
                <video
                  key={panel.videoDataUrl}
                  src={panel.videoDataUrl}
                  poster={panel.imageDataUrl ?? undefined}
                  controls
                  autoPlay
                  loop
                  playsInline
                  style={{ objectFit, width: '100%', height: '100%' }}
                />
              ) : panel.imageDataUrl ? (
                <img src={panel.imageDataUrl} alt={panel.imageName ?? ''} style={{ objectFit }} draggable={false} />
              ) : (
                <div className="panel-image-placeholder">no image</div>
              )}
            </div>

            {showCaptions && (
              <div className="lightbox-fields">
                {panel.fields.map((f) => (
                  <div key={f.id} className="lightbox-field" style={{ background: settings.colors.fieldBg }}>
                    <div className="lightbox-field-label" style={{ color: settings.colors.panelLabel }}>
                      {f.label}
                    </div>
                    <textarea
                      className="lightbox-field-input"
                      value={f.value}
                      placeholder={f.label}
                      rows={3}
                      style={{
                        fontSize: settings.fonts.fieldSizePx * 1.5,
                        fontFamily: settings.fonts.family,
                        fontWeight: settings.fonts.captionBold ? 700 : 400,
                        fontStyle: settings.fonts.captionItalic ? 'italic' : 'normal',
                        color: settings.colors.fieldText,
                        background: 'transparent',
                        caretColor: settings.colors.fieldText,
                      }}
                      onChange={(e) =>
                        dispatch({ type: 'UPDATE_FIELD', panelId: panel.id, fieldId: f.id, value: e.target.value })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="lightbox-hint">
            {panelIndex} / {totalPanels}  ·  ← / →  panel  ·  C  captions  ·  ▦ grid  ·  ⇔ compare  ·  Esc  close
          </div>
        </>
      )}

      {mode === 'grid' && (
        <div className="ne-fs-grid-scroll" onClick={(e) => e.stopPropagation()}>
          <div
            className="ne-fs-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridSize}px, 1fr))` }}
          >
            {frames.length === 0 && (
              <div className="ne-fullscreen-empty">
                No image versions on this panel yet.
              </div>
            )}
            {frames.map((f, i) => {
              const picked = picks.has(f.id);
              const isCurrent = f.id === 'current';
              return (
                <div
                  key={f.id}
                  className={`ne-fs-grid-tile ${picked ? 'is-picked' : ''} ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => togglePick(f.id)}
                  title={`${isCurrent ? `● current${frameSeqs[i] ? ` · v${frameSeqs[i]}` : ''}` : `v${frameSeqs[i]}`}${f.generatedAt ? ' · ' + new Date(f.generatedAt).toLocaleString() : ''} — click to pick`}
                >
                  {f.kind === 'video' && f.videoDataUrl ? (
                    <video
                      src={f.videoDataUrl}
                      poster={f.dataUrl || undefined}
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img src={f.dataUrl} alt="" draggable={false} />
                  )}
                  <div className="ne-fs-grid-tile-badges">
                    <span className="ne-fs-grid-tile-num">
                      {isCurrent ? `● current${frameSeqs[i] ? ` · v${frameSeqs[i]}` : ''}` : `v${frameSeqs[i]}`}
                      {f.kind === 'video' ? ' ▶' : ''}
                    </span>
                  </div>
                  <div className="ne-fs-grid-tile-check">{picked ? '✓' : ''}</div>
                </div>
              );
            })}
          </div>
          <div className="lightbox-hint" style={{ position: 'fixed' }}>
            Click to pick · ← / → panel · Esc back to single
          </div>
        </div>
      )}

      {mode === 'compare' && (
        <div className="ne-fs-compare-scroll" onClick={(e) => e.stopPropagation()}>
          <div
            className="ne-fs-compare"
            style={{
              gridTemplateColumns: `repeat(${compareColsFor(compareList.length)}, minmax(0, 1fr))`,
              gridAutoRows: '1fr',
            }}
          >
            {compareList.map((f, i) => {
              const idx = frames.findIndex((x) => x.id === f.id);
              const isCurrent = f.id === 'current';
              return (
                <div key={f.id} className="ne-fs-compare-cell">
                  <ZoomableImage url={f.dataUrl} videoUrl={f.kind === 'video' ? f.videoDataUrl : undefined} />
                  <div className="ne-fs-compare-caption">
                    <span>{isCurrent ? `● current${frameSeqs[idx] ? ` · v${frameSeqs[idx]}` : ''}` : `v${frameSeqs[idx]}`}{f.kind === 'video' ? ' ▶' : ''}</span>
                    {f.generatedAt ? (
                      <span className="ne-fs-compare-time">
                        {new Date(f.generatedAt).toLocaleTimeString()}
                      </span>
                    ) : null}
                    <button
                      className="ne-fs-compare-remove"
                      title="Remove from compare"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPicks((prev) => { const nx = new Set(prev); nx.delete(f.id); return nx; });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  {/* keeps compareList index consumer happy for future */}
                  <span style={{ display: 'none' }}>{i}</span>
                </div>
              );
            })}
            {compareList.length === 0 && (
              <div className="ne-fullscreen-empty">
                Pick versions in Grid, then come back here to compare.
              </div>
            )}
          </div>
          <div className="lightbox-hint" style={{ position: 'fixed' }}>
            Scroll to zoom · Drag to pan · Double-click to reset · ← / → panel · Esc back to single
          </div>
        </div>
      )}
    </div>
  );
}
