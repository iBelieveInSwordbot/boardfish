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
 * This is intentionally simple: it uses the same DOM we already render, so what-you-see-is-what-you-print.
 */
export function exportPdf(settings: ProjectSettings): void {
  const styleId = 'boardfish-print-style';
  document.getElementById(styleId)?.remove();

  const style = document.createElement('style');
  style.id = styleId;
  // Page dimensions in px: browsers accept `size: <w>px <h>px` in @page. Landscape/portrait implied by dims.
  style.textContent = `
    @page {
      size: ${settings.pageSize.widthPx}px ${settings.pageSize.heightPx}px;
      margin: 0;
    }
    @media print {
      html, body { background: #fff !important; margin: 0 !important; }
      body * { visibility: hidden !important; }
      .canvas-area, .canvas-area * { visibility: visible !important; }
      .canvas-area { position: absolute !important; inset: 0 !important; background: #fff !important; overflow: visible !important; }
      .canvas-scroll { transform: none !important; padding: 0 !important; gap: 0 !important; }
      .page-label { display: none !important; }
      .page-wrapper { break-after: page; page-break-after: always; margin: 0 !important; box-shadow: none !important; }
      .page-wrapper:last-child { break-after: auto; page-break-after: auto; }
      .empty-hint { display: none !important; }
    }
  `;
  document.head.appendChild(style);

  // Give the browser a tick to apply, then invoke print
  setTimeout(() => window.print(), 50);
}
