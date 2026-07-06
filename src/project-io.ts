// Save/load .boardfish files (zipped JSON + images) and PDF export via html2canvas + jsPDF

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import type { BoardfishState } from './store';
import type { Panel, ProjectSettings } from './types';

type SavedProjectV1 = {
  version: 1;
  savedAt: string;
  settings: ProjectSettings;
  panels: {
    id: string;
    imageName: string | null;
    imagePath: string | null; // path inside zip
    cornerNote?: string;
    fields: { id: string; label: string; value: string }[];
  }[];
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function saveProject(state: BoardfishState): Promise<void> {
  const zip = new JSZip();
  const images = zip.folder('images')!;

  const savedPanels: SavedProjectV1['panels'] = state.panels.map((p, idx) => {
    let imagePath: string | null = null;
    if (p.imageDataUrl) {
      const ext = extForDataUrl(p.imageDataUrl);
      imagePath = `images/panel-${idx.toString().padStart(4, '0')}-${p.id}.${ext}`;
      images.file(imagePath.replace(/^images\//, ''), dataUrlToBlob(p.imageDataUrl));
    }
    return {
      id: p.id,
      imageName: p.imageName,
      imagePath,
      cornerNote: p.cornerNote,
      fields: p.fields.map((f) => ({ id: f.id, label: f.label, value: f.value })),
    };
  });

  let logoPath: string | null = null;
  if (state.settings.footer.logoDataUrl) {
    const ext = extForDataUrl(state.settings.footer.logoDataUrl);
    logoPath = `logo.${ext}`;
    zip.file(logoPath, dataUrlToBlob(state.settings.footer.logoDataUrl));
  }

  // Store settings without embedded logo data URL (it's in the zip separately)
  const settingsForSave: ProjectSettings = {
    ...state.settings,
    footer: { ...state.settings.footer, logoDataUrl: null },
  };

  const manifest: SavedProjectV1 = {
    version: 1,
    savedAt: new Date().toISOString(),
    settings: settingsForSave,
    panels: savedPanels,
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

export async function loadProject(file: File): Promise<{ settings: ProjectSettings; panels: Panel[] }> {
  const zip = await JSZip.loadAsync(file);
  const manifestEntry = zip.file('project.json');
  if (!manifestEntry) throw new Error('Not a valid .boardfish file (missing project.json)');
  const manifest = JSON.parse(await manifestEntry.async('string')) as SavedProjectV1;
  if (manifest.version !== 1) throw new Error(`Unsupported project version: ${manifest.version}`);

  const panels: Panel[] = await Promise.all(
    manifest.panels.map(async (mp) => {
      let dataUrl: string | null = null;
      if (mp.imagePath) {
        const entry = zip.file(mp.imagePath);
        if (entry) {
          const blob = await entry.async('blob');
          dataUrl = await blobToDataUrl(blob);
        }
      }
      return {
        id: mp.id,
        imageDataUrl: dataUrl,
        imageName: mp.imageName,
        cornerNote: mp.cornerNote ?? '',
        fields: mp.fields.map((f) => ({ ...f })),
      };
    }),
  );

  let logoDataUrl: string | null = null;
  if (manifest.logoPath) {
    const entry = zip.file(manifest.logoPath);
    if (entry) {
      const blob = await entry.async('blob');
      logoDataUrl = await blobToDataUrl(blob);
    }
  }

  const settings: ProjectSettings = {
    ...manifest.settings,
    footer: { ...manifest.settings.footer, logoDataUrl },
  };

  return { settings, panels };
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
          // Kill inspector, toolbar in cloned DOM so nothing external bleeds in
          doc.querySelectorAll('.toolbar, .inspector, .inspector-reopen, .page-label, .empty-hint').forEach(
            (n) => ((n as HTMLElement).style.display = 'none'),
          );
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
