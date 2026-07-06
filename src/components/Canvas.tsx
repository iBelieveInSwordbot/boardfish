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
import { fileToPanelImage, itemsToPages, panelNumberMap } from '../store';
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
};

export function Canvas({ state, dispatch }: Props) {
  const { settings, items, selectedPanelId } = state;
  const perPage = Math.max(1, settings.panelsHorizontal * settings.panelsVertical);
  const pages = itemsToPages(items, perPage);
  const numbers = panelNumberMap(items);

  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragCounter = useRef(0);
  const areaRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom((z) => Math.min(4, +(z * 1.15).toFixed(3)));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => Math.max(0.1, +(z / 1.15).toFixed(3)));
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = -e.deltaY;
      setZoom((z) => {
        const next = z * (1 + delta / 500);
        return Math.min(4, Math.max(0.1, +next.toFixed(3)));
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
      if (state.selectedPanelId) {
        for (const it of state.items) {
          if (it.kind === 'storyboard' && it.panels.some((p) => p.id === state.selectedPanelId)) {
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

      // If aspect is locked-to-first and no storyboard-panel has an image yet, seed panelAspectRatio
      const anyPanelWithImage = state.items.some(
        (it) => it.kind === 'storyboard' && it.panels.some((p) => p.imageDataUrl),
      );
      if (!anyPanelWithImage && settings.panelAspectLocked && loaded.length > 0) {
        dispatch({ type: 'UPDATE_SETTINGS', patch: { panelAspectRatio: loaded[0].aspect } });
      }

      const newPanels: Panel[] = loaded.map(({ dataUrl, name }) => {
        const p = newPanel(settings.labels.defaults);
        p.imageDataUrl = dataUrl;
        p.imageName = name;
        return p;
      });
      dispatch({ type: 'ADD_PANELS_TO_ITEM', itemId: targetId, panels: newPanels });
    },
    [dispatch, settings.labels.defaults, settings.panelAspectLocked, state.items, state.selectedItemId, state.selectedPanelId],
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
      onClick={() => dispatch({ type: 'SELECT_PANEL', id: null })}
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
      <div className="canvas-scroll">
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
                selectedPanelId={selectedPanelId}
                dispatch={dispatch}
              />
            ))}
          </SortableContext>
        </DndContext>

        {items.every((it) => it.kind === 'slide' || (it.kind === 'storyboard' && it.panels.length === 0)) &&
          items.length > 0 && (
            <div className="empty-hint">
              <div className="empty-hint-title">Drop Images Here</div>
              <div className="empty-hint-sub">JPEG or PNG. Auto-arranged into pages of {perPage}.</div>
            </div>
          )}
      </div>
      <div className="zoom-hud">
        <button title="Zoom out (⌘-)" onClick={() => setZoom((z) => Math.max(0.1, +(z / 1.15).toFixed(3)))}>−</button>
        <button title="Reset zoom (⌘0)" onClick={() => setZoom(1)}>{zoomPct}%</button>
        <button title="Zoom in (⌘+)" onClick={() => setZoom((z) => Math.min(4, +(z * 1.15).toFixed(3)))}>+</button>
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
  selectedPanelId: string | null;
  dispatch: React.Dispatch<Action>;
};

function PageWrapper({ page, pageIndex, totalPages, numbers, settings, selectedPanelId, dispatch }: PageWrapperProps) {
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
  return (
    <StoryboardPageView
      panels={page.panels}
      pageIndex={pageIndex}
      totalPages={totalPages}
      numbers={numbers}
      settings={settings}
      selectedPanelId={selectedPanelId}
      dispatch={dispatch}
    />
  );
}

type StoryboardPageProps = {
  panels: Panel[];
  pageIndex: number;
  totalPages: number;
  numbers: Map<string, number>;
  settings: BoardfishState['settings'];
  selectedPanelId: string | null;
  dispatch: React.Dispatch<Action>;
};

function StoryboardPageView({ panels, pageIndex, totalPages, numbers, settings, selectedPanelId, dispatch }: StoryboardPageProps) {
  const cols = settings.panelsHorizontal;
  const rows = settings.panelsVertical;

  const pageStyle: React.CSSProperties = {
    width: settings.pageSize.widthPx,
    height: settings.pageSize.heightPx,
    background: settings.colors.pageBg,
    color: settings.colors.text,
    padding: settings.marginPx,
    boxSizing: 'border-box',
    position: 'relative',
  };

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
    columnGap: settings.gutterHorizontalPx,
    rowGap: settings.gutterVerticalPx,
    width: '100%',
    height: `calc(100% - 40px)`,
  };

  return (
    <div className="page-wrapper">
      <div className="page" data-page-index={pageIndex} style={pageStyle}>
        <div style={gridStyle}>
          {panels.map((panel) => (
            <PanelView
              key={panel.id}
              panel={panel}
              index={numbers.get(panel.id) ?? 1}
              selected={panel.id === selectedPanelId}
              settings={settings}
              dispatch={dispatch}
            />
          ))}
          {Array.from({ length: Math.max(0, cols * rows - panels.length) }).map((_, i) => (
            <div key={`empty-${i}`} className="panel-empty-slot" />
          ))}
        </div>
        <PageFooter pageIndex={pageIndex} totalPages={totalPages} settings={settings} />
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
