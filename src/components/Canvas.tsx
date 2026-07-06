import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, BoardfishState } from '../store';
import { fileToPanelImage, panelsToPages } from '../store';
import { newPanel, type Panel } from '../types';
import { PanelView } from './Panel';
import logoBlack from '../assets/logo-black.png';
import logoWhite from '../assets/logo-white.png';

/** Compute relative luminance of a hex color (0..1). Used to auto-pick logo variant. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1; // assume light
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // sRGB relative luminance approximation
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
  const { settings, panels, selectedPanelId } = state;
  const perPage = Math.max(1, settings.panelsHorizontal * settings.panelsVertical);
  const pages = panelsToPages(panels, perPage);

  const [isDropTarget, setIsDropTarget] = useState(false);
  const dragCounter = useRef(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const [pageScale, setPageScale] = useState(0.5);

  // Recompute page scale so page fits comfortably in canvas viewport (leave ~48px padding).
  useEffect(() => {
    function recompute() {
      const el = areaRef.current;
      if (!el) return;
      const availW = el.clientWidth - 96; // horizontal padding
      const availH = el.clientHeight - 80; // vertical padding + label
      const sx = availW / settings.pageSize.widthPx;
      const sy = availH / settings.pageSize.heightPx;
      const s = Math.max(0.1, Math.min(1, Math.min(sx, sy)));
      setPageScale(s);
    }
    recompute();
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.pageSize.widthPx, settings.pageSize.heightPx]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }, // small drag threshold so clicks on textareas still work
    }),
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter(
        (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
      );
      if (imageFiles.length === 0) return;

      const loaded = await Promise.all(imageFiles.map((f) => fileToPanelImage(f)));

      // If aspect is locked-to-first and no image has been added yet, auto-set from first image
      const firstImageAlreadyExists = panels.some((p) => p.imageDataUrl);
      if (!firstImageAlreadyExists && settings.panelAspectLocked && loaded.length > 0) {
        dispatch({ type: 'UPDATE_SETTINGS', patch: { panelAspectRatio: loaded[0].aspect } });
      }

      const newPanels: Panel[] = loaded.map(({ dataUrl, name }) => {
        const p = newPanel(settings.labels.defaults);
        p.imageDataUrl = dataUrl;
        p.imageName = name;
        return p;
      });
      dispatch({ type: 'ADD_PANELS', panels: newPanels });
    },
    [dispatch, panels, settings.labels.defaults, settings.panelAspectLocked],
  );

  const onDragEnd = (evt: DragEndEvent) => {
    const { active, over } = evt;
    if (!over || active.id === over.id) return;
    const ids = panels.map((p) => p.id);
    const oldIdx = ids.indexOf(String(active.id));
    const newIdx = ids.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = ids.slice();
    reordered.splice(oldIdx, 1);
    reordered.splice(newIdx, 0, String(active.id));
    dispatch({ type: 'REORDER_PANELS', ids: reordered });
  };

  const stripe: React.CSSProperties = {
    background: settings.colors.canvasBg,
  };

  const areaStyle: React.CSSProperties = {
    ...stripe,
    ['--page-scale' as never]: String(pageScale),
    ['--page-width-px' as never]: `${settings.pageSize.widthPx}px`,
    ['--page-height-px' as never]: `${settings.pageSize.heightPx}px`,
  };

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
      onDragOver={(e) => {
        e.preventDefault();
      }}
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
        if (e.dataTransfer?.files?.length) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="canvas-scroll">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={panels.map((p) => p.id)} strategy={rectSortingStrategy}>
            {pages.map((pagePanels, pageIdx) => (
              <PageView
                key={pageIdx}
                pageIndex={pageIdx}
                totalPages={pages.length}
                pagePanels={pagePanels}
                settings={state.settings}
                selectedPanelId={selectedPanelId}
                dispatch={dispatch}
              />
            ))}
          </SortableContext>
        </DndContext>

        {panels.length === 0 && (
          <div className="empty-hint">
            <div className="empty-hint-title">Drop Images Here</div>
            <div className="empty-hint-sub">JPEG or PNG. Auto-arranged into pages of {perPage}.</div>
          </div>
        )}
      </div>
    </div>
  );
}

type PageProps = {
  pageIndex: number;
  totalPages: number;
  pagePanels: Panel[];
  settings: BoardfishState['settings'];
  selectedPanelId: string | null;
  dispatch: React.Dispatch<Action>;
};

function PageView({ pageIndex, totalPages, pagePanels, settings, selectedPanelId, dispatch }: PageProps) {
  const cols = settings.panelsHorizontal;
  const rows = settings.panelsVertical;

  // Page renders at fixed logical pixel dimensions (settings.pageSize.widthPx/heightPx) so PDF export can
  // rasterize/print it 1:1. On screen, CSS `transform: scale()` inside a wrapper handles fit-to-viewport.
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
    height: `calc(100% - 40px)`, // leave room for footer strip
  };

  return (
    <div className="page-wrapper">
      <div className="page-label">
        Page {pageIndex + 1} of {totalPages}
      </div>
      <div className="page" data-page-index={pageIndex} style={pageStyle}>
        <div style={gridStyle}>
          {pagePanels.map((panel) => (
            <PanelView
              key={panel.id}
              panel={panel}
              selected={panel.id === selectedPanelId}
              settings={settings}
              dispatch={dispatch}
            />
          ))}
          {Array.from({ length: Math.max(0, cols * rows - pagePanels.length) }).map((_, i) => (
            <div key={`empty-${i}`} className="panel-empty-slot" />
          ))}
        </div>
        <PageFooter pageIndex={pageIndex} totalPages={totalPages} settings={settings} />
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
  // Priority: user-uploaded logo > auto-picked default logo > (nothing if auto disabled and no upload)
  let logoSrc: string | null = null;
  if (settings.footer.logoDataUrl) {
    logoSrc = settings.footer.logoDataUrl;
  } else if (settings.footer.logoAutoTheme) {
    logoSrc = pickDefaultLogo(settings.colors.pageBg);
  }

  return (
    <div className="page-footer" style={{ color: settings.colors.text }}>
      <div className="footer-left">{settings.footer.showProjectName ? settings.projectName : ''}</div>
      <div className="footer-center">
        {settings.footer.showPageNumber ? `${pageIndex + 1} / ${totalPages}` : ''}
      </div>
      <div className="footer-right">
        {logoSrc ? <img src={logoSrc} alt="logo" /> : null}
      </div>
    </div>
  );
}
