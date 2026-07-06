// Save/load .boardfish files (zipped JSON + images) and PDF export via window.print()

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
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
 * Export to PDF via the browser's print dialog. We inject an `@page` size matching the current pageSize
 * (in pixels) so the print output preserves the exact aspect ratio and layout. The user picks
 * "Save as PDF" in the destination dropdown.
 *
 * The trick to make Chromium paginate transformed pages correctly: zero out the on-screen
 * scale transform in print media, force the .page element back to its logical pixel size,
 * and use `break-after: page` on every .page-wrapper. Also honor the theme (page BG color)
 * instead of forcing white.
 */
export function exportPdf(settings: ProjectSettings): void {
  const styleId = 'boardfish-print-style';
  document.getElementById(styleId)?.remove();

  const { widthPx: W, heightPx: H } = settings.pageSize;
  const pageBg = settings.colors.pageBg;
  const canvasBg = settings.colors.canvasBg;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @page {
      size: ${W}px ${H}px;
      margin: 0;
    }
    @media print {
      /* Preserve dark backgrounds in PDF output */
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        background: ${canvasBg} !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        color-adjust: exact !important;
      }
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      /* Hide chrome (toolbar, inspector, empty-state text) */
      .toolbar, .inspector, .inspector-reopen, .page-label, .empty-hint { display: none !important; }

      /* Reset app layout so only pages remain */
      .app-root { display: block !important; height: auto !important; width: auto !important; }
      .app-body { display: block !important; }
      .canvas-area { display: block !important; position: static !important; background: ${canvasBg} !important; overflow: visible !important; width: auto !important; height: auto !important; }
      .canvas-scroll { display: block !important; padding: 0 !important; gap: 0 !important; overflow: visible !important; width: auto !important; height: auto !important; }

      /* CRITICAL: kill the on-screen scale transform so each page prints at its logical size,
         and give each page its own physical page break. */
      .page-wrapper {
        display: block !important;
        transform: none !important;
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        page-break-after: always;
        break-after: page;
        page-break-inside: avoid;
        break-inside: avoid;
        width: ${W}px !important;
        height: ${H}px !important;
        overflow: hidden !important;
      }
      .page-wrapper:last-child {
        page-break-after: auto;
        break-after: auto;
      }

      /* Lock .page to exact logical pixel dims, keep it at origin, keep its background from theme */
      .page {
        width: ${W}px !important;
        height: ${H}px !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        margin: 0 !important;
        position: relative !important;
        overflow: hidden !important;
        background: ${pageBg} !important;
      }

      /* Footer + logo must stay visible; they were being hidden by the old visibility-hack approach */
      .page-footer { display: grid !important; opacity: 1 !important; }
      .footer-right img { display: block !important; }

      /* Textareas keep their fieldBg color (set inline via React), just kill borders/outlines for print */
      .panel-field textarea {
        border: none !important;
        outline: none !important;
        resize: none !important;
      }
      .panel-header-note {
        border-bottom: none !important;
        background: transparent !important;
      }
    }
  `;
  document.head.appendChild(style);

  // Give the browser a tick to apply layout, then invoke print
  setTimeout(() => {
    window.print();
    // Clean up the injected style after print dialog closes (~1s buffer)
    setTimeout(() => document.getElementById(styleId)?.remove(), 2000);
  }, 100);
}
