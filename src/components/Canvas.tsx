import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, BoardfishState, LaidOutPage } from '../store';
import { fileToPanelImage, itemsToPages, panelNumberMap, resolveStoryboardSettings } from '../store';
import { newPanel, type Panel, type Slide } from '../types';
import { PanelView } from './Panel';
import { SlideView } from './Slide';
import logoBlack from '../assets/logo-black.png';
import logoWhite from '../assets/logo-white.png';

/** Compute relative luminance of a hex color (0..1). */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function pickDefaultLogo(pageBg: string): string {
  return luminance(pageBg) > 0.5 ? logoBlack : logoWhite;
}

type Props = {
  state: BoardfishState;
  dispatch: React.Dispatch<Action>;
  onOpenNodeEditor?: (panelId: string) => void;
};

export function Canvas({ state, dispatch, onOpenNodeEditor }: Props) {
  const { settings, items, selectedPanelIds } = state;
  const selectedSet = new Set(selectedPanelIds);
  const pages = itemsToPages(items, settings);
  const numbers = panelNumberMap(items, settings.panelNumbering);

  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragCounter = useRef(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(0.5);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    function recompute() {
      const el = areaRef.current;
      if (!el) return;
      const availW = el.clientWidth - 96;
      const availH = el.clientHeight - 80;
      const sx = availW / settings.pageSize.widthPx;
      const sy = availH / settings.pageSize.heightPx;
      const s = Math.max(0.05, Math.min(1, Math.min(sx, sy)));
      setFitScale(s);
    }
    recompute();
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.pageSize.widthPx, settings.pageSize.heightPx]);

  const pageScale = fitScale * zoom;

  // Zoom focal-point tracking.
  //
  // When the user zooms in/out, we want a specific point in the content to
  // stay put in the viewport. Two focal-point strategies:
  //   - If a panel is selected: keep the selected panel's *center* under the
  //     viewport center (zoom-toward-selection).
  //   - Otherwise: keep whatever is currently at the viewport center under
  //     the viewport center (zoom-toward-center of view).
  //
  // Because .page-wrapper uses transform-origin: top left with an
  // explicitly-sized layout box (width = page-px * scale), the scaled visual
  // position of any content point (x, y) in *scale=1 content coordinates* is
  // simply (x * scale, y * scale) inside .canvas-scroll's scrollable content.
  // So to keep content point (cx, cy) at viewport pixel (vx, vy):
  //     scrollLeft = cx * newScale - vx
  //     scrollTop  = cy * newScale - vy
  // We call adjustZoom() instead of setZoom() everywhere that changes zoom.

  function findSelectedPanelContentCenter(): { x: number; y: number } | null {
    const scroll = scrollRef.current;
    if (!scroll) return null;
    const primary = state.selectedPanelIds[0];
    if (!primary) return null;
    const el = scroll.querySelector<HTMLElement>(`[data-panel-id="${primary}"]`);
    if (!el) return null;
    const panelRect = el.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    // Panel center in viewport pixels
    const vx = panelRect.left + panelRect.width / 2 - scrollRect.left;
    const vy = panelRect.top + panelRect.height / 2 - scrollRect.top;
    // Convert viewport pixel to content pixel at current scale
    const cx = (vx + scroll.scrollLeft) / pageScale;
    const cy = (vy + scroll.scrollTop) / pageScale;
    return { x: cx, y: cy };
  }

  function adjustZoom(compute: (z: number) => number) {
    const scroll = scrollRef.current;
    if (!scroll) { setZoom((z) => compute(z)); return; }

    const oldScale = pageScale;
    // Focal point in content (unscaled) coordinates.
    const selCenter = findSelectedPanelContentCenter();
    const viewportCx = scroll.clientWidth / 2;
    const viewportCy = scroll.clientHeight / 2;
    const focal = selCenter ?? {
      x: (scroll.scrollLeft + viewportCx) / oldScale,
      y: (scroll.scrollTop + viewportCy) / oldScale,
    };

    const newZoom = Math.min(4, Math.max(0.1, +compute(zoom).toFixed(3)));
    setZoom(newZoom);

    // Recentre on the next frame after React commits the new width/height.
    requestAnimationFrame(() => {
      const s = scrollRef.current;
      if (!s) return;
      const newScale = fitScale * newZoom;
      const targetScrollLeft = focal.x * newScale - viewportCx;
      const targetScrollTop = focal.y * newScale - viewportCy;
      // clamp to valid scroll range (clientWidth+scrollWidth already reflect the new size)
      s.scrollLeft = Math.max(0, Math.min(targetScrollLeft, s.scrollWidth - s.clientWidth));
      s.scrollTop = Math.max(0, Math.min(targetScrollTop, s.scrollHeight - s.clientHeight));
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        adjustZoom((z) => Math.min(4, z * 1.15));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        adjustZoom((z) => Math.max(0.1, z / 1.15));
      } else if (e.key === '0') {
        e.preventDefault();
        adjustZoom(() => 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedPanelIds, zoom, fitScale]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY;
      adjustZoom((z) => z * (1 + delta / 500));
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedPanelIds, zoom, fitScale]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter(
        (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
      );
      if (imageFiles.length === 0) return;

      const loaded = await Promise.all(imageFiles.map((f) => fileToPanelImage(f)));

      // Determine target storyboard: nearest to selection, or first storyboard, or create one
      let targetId: string | null = null;
      const primary = state.selectedPanelIds[0];
      if (primary) {
        for (const it of state.items) {
          if (it.kind === 'storyboard' && it.panels.some((p) => p.id === primary)) {
            targetId = it.id;
            break;
          }
        }
      }
      if (!targetId && state.selectedItemId) {
        const sel = state.items.find((it) => it.id === state.selectedItemId);
        if (sel && sel.kind === 'storyboard') targetId = sel.id;
      }
      if (!targetId) {
        const first = state.items.find((it) => it.kind === 'storyboard');
        if (first) targetId = first.id;
      }
      if (!targetId) return; // no storyboard to accept

      // If this storyboard's effective aspect is locked-to-first and it has no images yet, seed its aspect override
      const targetItem = state.items.find((it) => it.id === targetId);
      if (targetItem && targetItem.kind === 'storyboard') {
        const eff = resolveStoryboardSettings(settings, targetItem);
        const hasAnyImage = targetItem.panels.some((p) => p.imageDataUrl);
        if (!hasAnyImage && eff.panelAspectLocked && loaded.length > 0) {
          const seededAspect = loaded[0].aspect;
          // Write into the item's overrides so we don't stomp the global default
          dispatch({
            type: 'UPDATE_STORYBOARD_OVERRIDES',
            id: targetItem.id,
            patch: { panelAspect: { panelAspectRatio: seededAspect } },
          });
        }
      }

      const newPanels: Panel[] = loaded.map(({ dataUrl, name }) => {
        const p = newPanel(settings.labels.defaults);
        p.imageDataUrl = dataUrl;
        p.imageName = name;
        return p;
      });
      dispatch({ type: 'ADD_PANELS_TO_ITEM', itemId: targetId, panels: newPanels });
    },
    [dispatch, settings, state.items, state.selectedItemId, state.selectedPanelIds],
  );

  const onDragEnd = (evt: DragEndEvent) => {
    const { active, over } = evt;
    if (!over || active.id === over.id) return;

    // Only reorder within the same storyboard item (cross-item panel moves would be confusing)
    for (const it of state.items) {
      if (it.kind !== 'storyboard') continue;
      const ids = it.panels.map((p) => p.id);
      const oldIdx = ids.indexOf(String(active.id));
      const newIdx = ids.indexOf(String(over.id));
      if (oldIdx < 0 || newIdx < 0) continue;
      const reordered = ids.slice();
      reordered.splice(oldIdx, 1);
      reordered.splice(newIdx, 0, String(active.id));
      dispatch({ type: 'REORDER_PANELS_WITHIN_ITEM', itemId: it.id, ids: reordered });
      return;
    }
  };

  const stripe: React.CSSProperties = { background: settings.colors.canvasBg };
  const areaStyle: React.CSSProperties = {
    ...stripe,
    ['--page-scale' as never]: String(pageScale),
    ['--page-width-px' as never]: `${settings.pageSize.widthPx}px`,
    ['--page-height-px' as never]: `${settings.pageSize.heightPx}px`,
  };

  const zoomPct = Math.round(zoom * 100);
  const allPanelIds = state.items.flatMap((it) => (it.kind === 'storyboard' ? it.panels.map((p) => p.id) : []));

  return (
    <div
      ref={areaRef}
      className={`canvas-area ${isDropTarget ? 'canvas-drop' : ''}`}
      style={areaStyle}
      onClick={() => dispatch({ type: 'CLEAR_PANEL_SELECTION' })}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current += 1;
        setIsDropTarget(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setIsDropTarget(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setIsDropTarget(false);
        if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="canvas-scroll" ref={scrollRef}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={allPanelIds} strategy={rectSortingStrategy}>
            {pages.map((page, pageIdx) => (
              <PageWrapper
                key={`${page.itemId}-${pageIdx}`}
                page={page}
                pageIndex={pageIdx}
                totalPages={pages.length}
                numbers={numbers}
                settings={settings}
                items={items}
                selectedSet={selectedSet}
                dispatch={dispatch}
                onOpenNodeEditor={onOpenNodeEditor}
              />
            ))}
          </SortableContext>
        </DndContext>

        {items.every((it) => it.kind === 'slide' || (it.kind === 'storyboard' && it.panels.length === 0)) &&
          items.length > 0 && (
            <div className="empty-hint">
              <div className="empty-hint-title">Drop Images Here</div>
              <div className="empty-hint-sub">JPEG or PNG. Auto-arranged into a grid.</div>
            </div>
          )}
      </div>
      <div className="zoom-hud">
        <button title="Zoom out (⌘-)" onClick={() => adjustZoom((z) => Math.max(0.1, z / 1.15))}>−</button>
        <button title="Reset zoom (⌘0)" onClick={() => adjustZoom(() => 1)}>{zoomPct}%</button>
        <button title="Zoom in (⌘+)" onClick={() => adjustZoom((z) => Math.min(4, z * 1.15))}>+</button>
      </div>
    </div>
  );
}

type PageWrapperProps = {
  page: LaidOutPage;
  pageIndex: number;
  totalPages: number;
  numbers: Map<string, number>;
  settings: BoardfishState['settings'];
  items: BoardfishState['items'];
  selectedSet: Set<string>;
  dispatch: React.Dispatch<Action>;
  onOpenNodeEditor?: (panelId: string) => void;
};

function PageWrapper({
  page,
  pageIndex,
  totalPages,
  numbers,
  settings,
  items,
  selectedSet,
  dispatch,
  onOpenNodeEditor,
}: PageWrapperProps) {
  if (page.kind === 'slide') {
    return (
      <SlidePageView
        slide={page.slide}
        itemId={page.itemId}
        pageIndex={pageIndex}
        totalPages={totalPages}
        settings={settings}
        dispatch={dispatch}
      />
    );
  }
  // Resolve per-item effective settings so overrides win over global
  const item = items.find((it) => it.id === page.itemId);
  const eff =
    item && item.kind === 'storyboard' ? resolveStoryboardSettings(settings, item) : null;
  return (
    <StoryboardPageView
      panels={page.panels}
      pageIndex={pageIndex}
      totalPages={totalPages}
      numbers={numbers}
      settings={settings}
      effective={eff}
      selectedSet={selectedSet}
      dispatch={dispatch}
      onOpenNodeEditor={onOpenNodeEditor}
    />
  );
}

type StoryboardPageProps = {
  panels: Panel[];
  pageIndex: number;
  totalPages: number;
  numbers: Map<string, number>;
  settings: BoardfishState['settings'];
  effective: ReturnType<typeof resolveStoryboardSettings> | null;
  selectedSet: Set<string>;
  dispatch: React.Dispatch<Action>;
  onOpenNodeEditor?: (panelId: string) => void;
};

function StoryboardPageView({
  panels,
  pageIndex,
  totalPages,
  numbers,
  settings,
  effective,
  selectedSet,
  dispatch,
  onOpenNodeEditor,
}: StoryboardPageProps) {
  const eff = effective ?? {
    panelsHorizontal: settings.panelsHorizontal,
    panelsVertical: settings.panelsVertical,
    marginPx: settings.marginPx,
    gutterHorizontalPx: settings.gutterHorizontalPx,
    gutterVerticalPx: settings.gutterVerticalPx,
    panelAspectRatio: settings.panelAspectRatio,
    panelAspectLocked: settings.panelAspectLocked,
    imageFit: settings.imageFit,
    fieldLabels: settings.labels.defaults,
  };
  const cols = eff.panelsHorizontal;
  const rows = eff.panelsVertical;

  const pageStyle: React.CSSProperties = {
    width: settings.pageSize.widthPx,
    height: settings.pageSize.heightPx,
    background: settings.colors.pageBg,
    color: settings.colors.text,
    padding: eff.marginPx,
    boxSizing: 'border-box',
    position: 'relative',
  };

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
    columnGap: eff.gutterHorizontalPx,
    rowGap: eff.gutterVerticalPx,
    width: '100%',
    height: `calc(100% - 40px)`,
  };

  // Panel needs its own view of aspect + fit so per-storyboard overrides render right
  const panelViewSettings = {
    ...settings,
    panelAspectRatio: eff.panelAspectRatio,
    imageFit: eff.imageFit,
  };

  return (
    <div className="page-frame">
      <div className="page-wrapper">
        <div className="page" data-page-index={pageIndex} style={pageStyle}>
          <div style={gridStyle}>
            {panels.map((panel) => (
              <PanelView
                key={panel.id}
                panel={panel}
                index={numbers.get(panel.id) ?? 1}
                selected={selectedSet.has(panel.id)}
                settings={panelViewSettings}
                dispatch={dispatch}
                onOpenNodeEditor={onOpenNodeEditor}
              />
            ))}
            {Array.from({ length: Math.max(0, cols * rows - panels.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="panel-empty-slot" />
            ))}
          </div>
          <PageFooter pageIndex={pageIndex} totalPages={totalPages} settings={settings} />
        </div>
      </div>
    </div>
  );
}

type SlidePageProps = {
  slide: Slide;
  itemId: string;
  pageIndex: number;
  totalPages: number;
  settings: BoardfishState['settings'];
  dispatch: React.Dispatch<Action>;
};

function SlidePageView({ slide, itemId, pageIndex, totalPages, settings, dispatch }: SlidePageProps) {
  const pageStyle: React.CSSProperties = {
    width: settings.pageSize.widthPx,
    height: settings.pageSize.heightPx,
    background: settings.colors.pageBg,
    color: settings.colors.text,
    padding: settings.marginPx,
    boxSizing: 'border-box',
    position: 'relative',
    fontFamily: settings.fonts.family,
  };

  return (
    <div className="page-frame">
      <div
        className="page-wrapper slide-page-wrapper"
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ type: 'SELECT_ITEM', id: itemId });
        }}
      >
        <div className="page slide-page" data-page-index={pageIndex} style={pageStyle}>
          <SlideView slide={slide} settings={settings} dispatch={dispatch} />
          {slide.showFooter && <PageFooter pageIndex={pageIndex} totalPages={totalPages} settings={settings} />}
        </div>
      </div>
    </div>
  );
}

function PageFooter({
  pageIndex,
  totalPages,
  settings,
}: {
  pageIndex: number;
  totalPages: number;
  settings: BoardfishState['settings'];
}) {
  let logoSrc: string | null = null;
  if (settings.footer.logoDataUrl) {
    logoSrc = settings.footer.logoDataUrl;
  } else if (settings.footer.logoAutoTheme) {
    logoSrc = pickDefaultLogo(settings.colors.pageBg);
  }

  const footerStyle: React.CSSProperties = {
    color: settings.colors.text,
    fontFamily: settings.fonts.family,
    fontSize: settings.fonts.footerSizePx,
    fontWeight: settings.fonts.footerBold ? 700 : 400,
    fontStyle: settings.fonts.footerItalic ? 'italic' : 'normal',
  };
  const logoStyle: React.CSSProperties = {
    maxHeight: 28 * settings.footer.logoScale,
    maxWidth: 120 * settings.footer.logoScale,
    display: 'block',
    marginLeft: 'auto',
  };

  return (
    <div className="page-footer" style={footerStyle}>
      <div className="footer-left">{settings.footer.showProjectName ? settings.projectName : ''}</div>
      <div className="footer-center">
        {settings.footer.showPageNumber ? `Page ${pageIndex + 1} / ${totalPages}` : ''}
      </div>
      <div className="footer-right">
        {logoSrc ? <img src={logoSrc} alt="logo" style={logoStyle} className="footer-logo" /> : null}
      </div>
    </div>
  );
}
