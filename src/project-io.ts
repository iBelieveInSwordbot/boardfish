// Save/load .boardfish files (zipped JSON + images) and PDF export via html2canvas + jsPDF

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import type { BoardfishState } from './store';
import { itemsFromLegacyPanels } from './store';
import type { DocItem, Panel, ProjectSettings, SlideTextBox } from './types';
import { migrateSlideFromV3 } from './types';

// v1: legacy flat panels[] (pre-outliner, up to 2026-07-05 evening)
type SavedPanelV1 = {
  id: string;
  imageName: string | null;
  imagePath: string | null; // path inside zip
  videoPath?: string | null; // path to the panel video (mp4) if any
  cornerNote?: string;
  fields: { id: string; label: string; value: string }[];
  aiPrompt?: string;
  // AI history: prior generations. Each entry stores its image inside the zip
  // under images/history/<panelId>/<versionId>.<ext>. Loaded as PanelImageVersion.
  // Extended in 2026-07-12: `kind` + `videoPath` support video versions.
  imageHistory?: {
    id: string;
    imagePath: string;
    prompt: string;
    generatedAt: number;
    kind?: 'image' | 'video';
    videoPath?: string; // when kind='video'
  }[];
  // Broadened in Boardfish 5 to match the extended PanelStyleMode set.
  // Older files (v3 with only 'pencil-sketch' | 'none') still validate.
  styleMode?: 'pencil-sketch' | 'ink-wash' | 'photoreal' | 'noir' | 'anime' | 'watercolor' | 'comic-ink' | 'none';
};
type SavedProjectV1 = {
  version: 1;
  savedAt: string;
  settings: ProjectSettings;
  panels: SavedPanelV1[];
  logoPath: string | null;
};

// v2: outliner items[] (slides + storyboards). v3 adds per-storyboard overrides.
// v3 slide shape (title/subtitle strings + optional image on disk).
type SavedSlideV3 = {
  id: string;
  imageName: string | null;
  imagePath: string | null;
  title: string;
  subtitle: string;
  showFooter: boolean;
};
// v4 slide shape: two floating text boxes, no image. `titleBox`/`subtitleBox`
// serialize directly (percent-based positions + styling).
type SavedSlideV4 = {
  id: string;
  titleBox: SlideTextBox;
  subtitleBox: SlideTextBox;
  showFooter: boolean;
};
// v5 slide shape: arbitrary array of text boxes on a slide (Keynote-style).
// The subtitle field is gone entirely; on load, v4 saves migrate to
// `textBoxes: [titleBox]` (subtitle is dropped).
type SavedSlideV5 = {
  id: string;
  textBoxes: SlideTextBox[];
  showFooter: boolean;
};
type SavedItemV2 =
  | {
      id: string;
      kind: 'slide';
      slide: SavedSlideV3 | SavedSlideV4 | SavedSlideV5;
    }
  | {
      id: string;
      kind: 'storyboard';
      panels: SavedPanelV1[];
      overrides?: import('./types').StoryboardOverrides;
    };
type SavedProjectV2 = {
  version: 2 | 3 | 4 | 5;
  savedAt: string;
  settings: ProjectSettings;
  items: SavedItemV2[];
  logoPath: string | null;
};

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function extForDataUrl(dataUrl: string): string {
  const m = /^data:([^;]+);base64,/.exec(dataUrl);
  return (m ? IMAGE_MIME_EXT[m[1]] : null) ?? 'bin';
}

function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Downscale an image data URL so its long edge is at most `maxLongEdgePx`.
 * Preserves PNG (with alpha) or converts opaque images to JPEG at the given quality.
 * Returns the original data URL if it already fits within bounds and format is fine.
 */
async function downscaleImageDataUrl(
  dataUrl: string,
  maxLongEdgePx: number,
  jpegQuality = 0.9,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      const longEdge = Math.max(w, h);
      // If already small enough, don't touch it (avoid recompression artifacts on small assets)
      if (longEdge <= maxLongEdgePx) {
        resolve(dataUrl);
        return;
      }
      const scale = maxLongEdgePx / longEdge;
      const targetW = Math.round(w * scale);
      const targetH = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl); // fall back to original
        return;
      }
      // High-quality resampling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, targetW, targetH);
      // Preserve PNG only if source was PNG (to keep transparency support). Otherwise JPEG for size.
      const isPng = /^data:image\/png/i.test(dataUrl);
      const out = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', jpegQuality);
      resolve(out);
    };
    img.onerror = () => reject(new Error('Downscale failed to load image'));
    img.src = dataUrl;
  });
}

/** Optionally downscale a data URL; returns the possibly-shrunk data URL. */
async function maybeDownscale(dataUrl: string | null, enabled: boolean, maxLongEdgePx: number): Promise<string | null> {
  if (!dataUrl || !enabled) return dataUrl;
  try {
    return await downscaleImageDataUrl(dataUrl, maxLongEdgePx);
  } catch {
    return dataUrl;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function saveProject(
  state: BoardfishState,
  options: { downscale?: boolean; maxLongEdgePx?: number } = {},
): Promise<void> {
  const downscale = options.downscale ?? true;
  const maxLongEdgePx = options.maxLongEdgePx ?? 2400;

  const zip = new JSZip();
  const images = zip.folder('images')!;

  let panelSerial = 0;

  // Note: we process items sequentially to keep memory usage bounded (large data URLs)
  const savedItems: SavedItemV2[] = [];
  for (const it of state.items) {
    if (it.kind === 'slide') {
      // v5 saves the full textBoxes[] verbatim; slide images / subtitle field
      // are gone as of v5 and are intentionally not round-tripped.
      savedItems.push({
        id: it.id,
        kind: 'slide',
        slide: {
          id: it.slide.id,
          textBoxes: it.slide.textBoxes,
          showFooter: it.slide.showFooter,
        },
      });
      continue;
    }
    // storyboard
    const savedPanels: SavedPanelV1[] = [];
    for (const p of it.panels) {
      let imagePath: string | null = null;
      if (p.imageDataUrl) {
        const dataUrl = (await maybeDownscale(p.imageDataUrl, downscale, maxLongEdgePx)) as string;
        const ext = extForDataUrl(dataUrl);
        imagePath = `images/panel-${panelSerial.toString().padStart(4, '0')}-${p.id}.${ext}`;
        images.file(imagePath.replace(/^images\//, ''), dataUrlToBlob(dataUrl));
      }
      // Video attachment (from Movie Gen → Out). Stored under videos/ so
      // load-side can restore panel.videoDataUrl. We don't downscale it —
      // video re-encoding in-browser would be brutal; just persist as-is.
      let videoPath: string | null = null;
      if (p.videoDataUrl) {
        const ext = p.videoDataUrl.startsWith('data:video/webm') ? 'webm' : 'mp4';
        videoPath = `videos/panel-${panelSerial.toString().padStart(4, '0')}-${p.id}.${ext}`;
        zip.file(videoPath, dataUrlToBlob(p.videoDataUrl));
      }
      // AI image/video history: save each version under images/history/<panelId>/
      // and, for video kinds, additionally save the video payload under
      // videos/history/<panelId>/.
      let savedHistory: NonNullable<SavedPanelV1['imageHistory']> | undefined;
      if (p.imageHistory && p.imageHistory.length > 0) {
        savedHistory = [];
        for (const v of p.imageHistory) {
          // Poster / image data-url: always saved (for video kinds this is the poster frame).
          let vImagePath = '';
          if (v.dataUrl) {
            const vUrl = (await maybeDownscale(v.dataUrl, downscale, maxLongEdgePx)) as string;
            const vExt = extForDataUrl(vUrl);
            vImagePath = `images/history/${p.id}/${v.id}.${vExt}`;
            zip.file(vImagePath, dataUrlToBlob(vUrl));
          }
          let vVideoPath: string | undefined;
          if (v.kind === 'video' && v.videoDataUrl) {
            const vExt = v.videoDataUrl.startsWith('data:video/webm') ? 'webm' : 'mp4';
            vVideoPath = `videos/history/${p.id}/${v.id}.${vExt}`;
            zip.file(vVideoPath, dataUrlToBlob(v.videoDataUrl));
          }
          savedHistory.push({
            id: v.id,
            imagePath: vImagePath,
            prompt: v.prompt,
            generatedAt: v.generatedAt,
            kind: v.kind,
            videoPath: vVideoPath,
          });
        }
      }
      panelSerial += 1;
      savedPanels.push({
        id: p.id,
        imageName: p.imageName,
        imagePath,
        videoPath,
        cornerNote: p.cornerNote,
        fields: p.fields.map((f) => ({ id: f.id, label: f.label, value: f.value })),
        aiPrompt: p.aiPrompt,
        imageHistory: savedHistory,
        styleMode: p.styleMode,
      });
    }
    savedItems.push({ id: it.id, kind: 'storyboard', panels: savedPanels, overrides: it.overrides });
  }

  let logoPath: string | null = null;
  if (state.settings.footer.logoDataUrl) {
    // Logo generally small; downscale to a lower ceiling (600px long edge is plenty for print footer)
    const logoUrl = (await maybeDownscale(state.settings.footer.logoDataUrl, downscale, Math.min(maxLongEdgePx, 600))) as string;
    const ext = extForDataUrl(logoUrl);
    logoPath = `logo.${ext}`;
    zip.file(logoPath, dataUrlToBlob(logoUrl));
  }

  const settingsForSave: ProjectSettings = {
    ...state.settings,
    footer: { ...state.settings.footer, logoDataUrl: null },
  };

  const manifest: SavedProjectV2 = {
    version: 5, // v5 = v4 + slide holds `textBoxes: SlideTextBox[]` (subtitle box removed)
    savedAt: new Date().toISOString(),
    settings: settingsForSave,
    items: savedItems,
    logoPath,
  };
  zip.file('project.json', JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob' });
  const filename = `${sanitize(state.settings.projectName || 'boardfish-project')}.boardfish`;
  saveAs(blob, filename);
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9-_. ]/gi, '_').trim() || 'boardfish-project';
}

export async function loadProject(
  file: File,
): Promise<{ settings: ProjectSettings; items: DocItem[] }> {
  const zip = await JSZip.loadAsync(file);
  const manifestEntry = zip.file('project.json');
  if (!manifestEntry) throw new Error('Not a valid .boardfish file (missing project.json)');
  const manifestRaw = JSON.parse(await manifestEntry.async('string')) as SavedProjectV1 | SavedProjectV2;

  const loadImage = async (imagePath: string | null): Promise<string | null> => {
    if (!imagePath) return null;
    const entry = zip.file(imagePath);
    if (!entry) return null;
    const blob = await entry.async('blob');
    return blobToDataUrl(blob);
  };

  const loadVideo = async (videoPath: string | null | undefined): Promise<string | null> => {
    if (!videoPath) return null;
    const entry = zip.file(videoPath);
    if (!entry) return null;
    const blob = await entry.async('blob');
    return blobToDataUrl(blob);
  };

  let items: DocItem[];

  if (
    manifestRaw.version === 2 ||
    manifestRaw.version === 3 ||
    manifestRaw.version === 4 ||
    manifestRaw.version === 5
  ) {
    items = await Promise.all(
      manifestRaw.items.map(async (it): Promise<DocItem> => {
        if (it.kind === 'slide') {
          const raw = it.slide as SavedSlideV3 & Partial<SavedSlideV4> & Partial<SavedSlideV5>;
          // v5: textBoxes[] present — take them as-is.
          if (Array.isArray(raw.textBoxes)) {
            return {
              id: it.id,
              kind: 'slide',
              slide: {
                id: raw.id,
                textBoxes: raw.textBoxes,
                showFooter: raw.showFooter,
              },
            };
          }
          // v4: two text boxes present — migrate to textBoxes = [titleBox] (drop subtitle).
          if (raw.titleBox) {
            return {
              id: it.id,
              kind: 'slide',
              slide: {
                id: raw.id,
                textBoxes: [raw.titleBox],
                showFooter: raw.showFooter,
              },
            };
          }
          // v2/v3 legacy: convert title/subtitle strings into default-positioned text boxes.
          // Old slide image (if any) is discarded per Matt's v4 spec.
          return {
            id: it.id,
            kind: 'slide',
            slide: migrateSlideFromV3({
              id: raw.id,
              title: raw.title,
              subtitle: raw.subtitle,
              showFooter: raw.showFooter,
              imageDataUrl: null,
              imageName: raw.imageName,
            }),
          };
        }
        const panels: Panel[] = await Promise.all(
          it.panels.map(async (mp) => ({
            id: mp.id,
            imageDataUrl: await loadImage(mp.imagePath),
            imageName: mp.imageName,
            videoDataUrl: await loadVideo(mp.videoPath ?? null),
            cornerNote: mp.cornerNote ?? '',
            fields: mp.fields.map((f) => ({ ...f })),
            aiPrompt: mp.aiPrompt,
            imageHistory: mp.imageHistory
              ? (await Promise.all(
                  mp.imageHistory.map(async (v) => {
                    const dataUrl = (await loadImage(v.imagePath)) ?? '';
                    const videoDataUrl = v.videoPath ? (await loadVideo(v.videoPath)) : null;
                    // Skip entries with no recoverable media.
                    if (!dataUrl && !videoDataUrl) return null;
                    const entry: import('./types').PanelImageVersion = {
                      id: v.id,
                      dataUrl,
                      prompt: v.prompt,
                      generatedAt: v.generatedAt,
                      kind: v.kind,
                    };
                    if (videoDataUrl) entry.videoDataUrl = videoDataUrl;
                    return entry;
                  }),
                )).filter((x): x is import('./types').PanelImageVersion => x !== null)
              : undefined,
            styleMode: mp.styleMode,
          })),
        );
        return { id: it.id, kind: 'storyboard', panels, overrides: it.overrides ?? {} };
      }),
    );
  } else if (manifestRaw.version === 1) {
    // Legacy: flat panels[] → wrap in a single storyboard item
    const panels: Panel[] = await Promise.all(
      manifestRaw.panels.map(async (mp) => ({
        id: mp.id,
        imageDataUrl: await loadImage(mp.imagePath),
        imageName: mp.imageName,
        cornerNote: mp.cornerNote ?? '',
        fields: mp.fields.map((f) => ({ ...f })),
        aiPrompt: mp.aiPrompt,
      })),
    );
    items = itemsFromLegacyPanels(panels);
  } else {
    throw new Error(`Unsupported project version: ${(manifestRaw as { version: number }).version}`);
  }

  let logoDataUrl: string | null = null;
  if (manifestRaw.logoPath) {
    const entry = zip.file(manifestRaw.logoPath);
    if (entry) {
      const blob = await entry.async('blob');
      logoDataUrl = await blobToDataUrl(blob);
    }
  }

  const settings: ProjectSettings = {
    ...manifestRaw.settings,
    footer: { ...manifestRaw.settings.footer, logoDataUrl },
  };

  return { settings, items };
}

/**
 * Export to PDF using html2canvas + jsPDF.
 *
 * Rationale (2026-07-05): Chromium's native print pipeline (window.print + @page) refused to
 * paginate our multi-page layout no matter how aggressively we overrode transforms, overflow,
 * and break-after in `@media print`. Ripped it out in favor of a deterministic per-page raster
 * pipeline: for each `.page` element, render it into a canvas at its logical 1:1 pixel dims,
 * then add each canvas as an image to a jsPDF document sized to match.
 *
 * Trade-offs:
 *   - Text is rasterized (not selectable in the PDF). Acceptable for storyboards.
 *   - File size larger than native print (each page ~300 KB–1 MB). Fine for typical boards.
 *   - Total control over multi-page, dark theme, footer, logo. WYSIWYG guaranteed.
 */
export async function exportPdf(settings: ProjectSettings): Promise<void> {
  const pageEls = Array.from(document.querySelectorAll<HTMLElement>('.page'));
  if (pageEls.length === 0) {
    alert('Nothing to export — add some panels first.');
    return;
  }

  const { widthPx: W, heightPx: H } = settings.pageSize;
  const pageBg = settings.colors.pageBg;
  const canvasBg = settings.colors.canvasBg;

  // We temporarily disable the on-screen scale transform and force the pages to their logical
  // pixel dimensions so html2canvas rasterizes at exactly W x H. Restore after.
  const scroll = document.querySelector<HTMLElement>('.canvas-scroll');
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.page-wrapper'));
  const savedTransforms = wrappers.map((w) => w.style.transform);
  const savedMarginBottom = wrappers.map((w) => w.style.marginBottom);
  wrappers.forEach((w) => {
    w.style.transform = 'none';
    w.style.marginBottom = '0px';
  });

  // jsPDF units: px, format matches page size 1:1. hotfixes→px_scaling ensures 72dpi math is skipped
  // and 1 unit = 1 CSS pixel.
  const orientation: 'p' | 'l' = W >= H ? 'l' : 'p';
  const pdf = new jsPDF({ unit: 'px', format: [W, H], orientation, hotfixes: ['px_scaling'] });

  try {
    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      // eslint-disable-next-line no-await-in-loop
      const canvas = await html2canvas(el, {
        width: W,
        height: H,
        windowWidth: W,
        windowHeight: H,
        backgroundColor: pageBg,
        scale: 2, // 2x for crisp text/lines when zoomed in PDF viewers
        useCORS: true,
        allowTaint: false,
        logging: false,
        // Force html2canvas to render at logical size regardless of on-screen scale
        onclone: (doc: Document) => {
          // Kill inspector, toolbar, outliner, and controls in cloned DOM so nothing external bleeds in
          doc.querySelectorAll(
            '.toolbar, .inspector, .inspector-reopen, .outliner, .outliner-reopen, .page-label, .empty-hint, ' +
              '.slide-image-replace, .slide-image-remove, .slide-image-placeholder, .zoom-hud, ' +
              '.fullscreen-exit',
          ).forEach((n) => ((n as HTMLElement).style.display = 'none'));

          // v4 slide text boxes are contentEditable <div>s rather than <input>s; html2canvas renders
          // them fine, but we still want to strip any residual selection outline / drag handles
          // that might leak into the print. The .slide-textbox styles below live under the export-
          // safe class list; hide handles + toolbars explicitly.
          doc.querySelectorAll<HTMLElement>(
            '.slide-textbox-handle, .slide-textbox-toolbar, .slide-textbox.selected .slide-textbox-frame',
          ).forEach((n) => (n.style.display = 'none'));
          doc.querySelectorAll<HTMLElement>('.slide-textbox').forEach((n) => {
            n.classList.remove('selected', 'editing');
            n.style.outline = 'none';
            n.style.cursor = 'auto';
          });
          // Legacy: v3 or earlier slides that rendered as <input> (should no longer exist after
          // migration on load, but harmless to keep).
          doc.querySelectorAll<HTMLInputElement>('.slide-title, .slide-subtitle').forEach((inp) => {
            const div = doc.createElement('div');
            div.textContent = inp.value;
            div.className = inp.className + '-print';
            div.style.cssText = inp.style.cssText;
            div.style.width = '100%';
            div.style.textAlign = 'center';
            div.style.padding = '8px 20px';
            div.style.wordWrap = 'break-word';
            div.style.overflowWrap = 'break-word';
            div.style.whiteSpace = 'normal';
            div.style.background = 'transparent';
            div.style.border = 'none';
            div.style.outline = 'none';
            div.style.boxSizing = 'border-box';
            inp.replaceWith(div);
          });
          // Strip the blue selection highlight from panels so it doesn't render in the PDF
          doc.querySelectorAll<HTMLElement>('.panel').forEach((n) => {
            n.style.borderColor = 'transparent';
            n.classList.remove('panel-selected');
          });
          // html2canvas renders <textarea> values as a single line — line breaks + soft wraps get lost.
          // Replace each textarea with a plain <div> that preserves whitespace so multi-line captions render.
          doc.querySelectorAll<HTMLTextAreaElement>('.panel-field textarea').forEach((ta) => {
            const div = doc.createElement('div');
            div.className = 'panel-field-print';
            div.textContent = ta.value;
            // Copy computed visual styles onto the replacement div so it renders identically
            const cs = ta.ownerDocument.defaultView?.getComputedStyle(ta);
            div.style.cssText = ta.style.cssText; // inline (from React) first — color, background, fontSize, fontFamily, fontWeight, fontStyle
            div.style.whiteSpace = 'pre-wrap';
            div.style.wordWrap = 'break-word';
            div.style.overflowWrap = 'break-word';
            div.style.width = '100%';
            div.style.height = '100%';
            div.style.padding = cs?.padding ?? '6px 8px';
            div.style.lineHeight = cs?.lineHeight ?? '1.35';
            div.style.border = 'none';
            div.style.outline = 'none';
            div.style.boxSizing = 'border-box';
            div.style.overflow = 'hidden';
            ta.replaceWith(div);
          });
          doc.querySelectorAll<HTMLElement>('.page-wrapper').forEach((w) => {
            w.style.transform = 'none';
            w.style.marginBottom = '0px';
          });
          // Hide empty corner-note inputs so we don't print the "note" placeholder
          doc.querySelectorAll<HTMLInputElement>('.panel-header-note').forEach((inp) => {
            if (!inp.value) {
              const wrap = inp.closest('.panel-header-note-wrap') as HTMLElement | null;
              // If there's a prefix, keep it and just hide the empty input;
              // if there's no prefix span, hide the whole wrap.
              const prefix = wrap?.querySelector('.panel-header-note-prefix');
              if (prefix) inp.style.visibility = 'hidden';
              else if (wrap) wrap.style.display = 'none';
            }
          });
          // Ensure canvas + page backgrounds match settings (in case of any cascade quirk)
          doc.querySelectorAll<HTMLElement>('.canvas-area').forEach((n) => (n.style.background = canvasBg));
        },
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      if (i > 0) pdf.addPage([W, H], orientation);
      pdf.addImage(imgData, 'JPEG', 0, 0, W, H, undefined, 'FAST');
    }

    const filename = `${sanitize(settings.projectName || 'boardfish')}.pdf`;
    pdf.save(filename);
  } finally {
    // Restore on-screen scale transforms
    wrappers.forEach((w, i) => {
      w.style.transform = savedTransforms[i];
      w.style.marginBottom = savedMarginBottom[i];
    });
    // Nudge layout so the scroll container reflows to whatever pageScale ResizeObserver last set
    scroll?.getBoundingClientRect();
  }
}
