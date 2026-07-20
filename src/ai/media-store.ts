/**
 * Media store client.
 *
 * Boardfish generates a LOT of pixel data (base64 data URLs for every panel
 * image + video). Storing those in localStorage blows the ~5 MB quota fast,
 * which is why refreshing / hitting back = black panels — the autosave
 * silently fails and we fall back to an old (or empty) state.
 *
 * This module uploads a data URL to the ai-proxy, which writes it to disk
 * under a content-addressed path (`<sha256>.<ext>`), and gives us back a
 * stable relative URL (`/api/media/<sha>.<ext>`) that:
 *   - survives page reload / back button
 *   - is tiny in localStorage
 *   - is cache-immutable (proxy sends Cache-Control: immutable)
 *
 * Design notes:
 *   - `mediaUrl` is *always* a relative path so the same saved state works
 *     across dev / prod / different hosts.
 *   - `mediaId` is `<sha>.<ext>`. We keep both so downstream code can
 *     rebuild URLs, migrate, or verify.
 *   - Uploads are content-addressed → same bytes = same ID = free dedupe.
 *   - Failures fall back to keeping the original data URL. Nothing crashes.
 */

export type MediaStoreEntry = {
  id: string;    // "<sha>.<ext>"
  url: string;   // "/api/media/<id>"
  mime: string;
  bytes: number;
};

/**
 * Upload a data URL to the server media store.
 * Returns null on failure (caller keeps the data URL).
 */
export async function uploadDataUrl(
  dataUrl: string,
  mimeHint?: string,
): Promise<MediaStoreEntry | null> {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  try {
    const r = await fetch('/api/media/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, mime: mimeHint }),
    });
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn('[media-store] upload failed', r.status, await r.text().catch(() => ''));
      return null;
    }
    const j = (await r.json()) as MediaStoreEntry & { ok: boolean };
    if (!j?.ok || !j.id || !j.url) return null;
    return { id: j.id, url: j.url, mime: j.mime, bytes: j.bytes };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[media-store] upload error', err);
    return null;
  }
}

/**
 * Upload a File (from a file picker or drop event) to the server media store.
 * Reads the file as a data URL first, then delegates to uploadDataUrl.
 * Returns null on failure (caller keeps the local File / falls back).
 */
export function uploadFile(file: File): Promise<MediaStoreEntry | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result);
        const rec = await uploadDataUrl(dataUrl, file.type || undefined);
        resolve(rec);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[media-store] uploadFile error', err);
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Return true if a string looks like a data URL for image or video content.
 */
export function isDataUrl(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('data:');
}

/**
 * Return true if a string looks like our server-side media reference.
 */
export function isMediaStoreUrl(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('/api/media/');
}
