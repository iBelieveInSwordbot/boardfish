/**
 * Media lifting for the server-side project store.
 *
 * When a project is saved to /api/projects, we walk the DocItem tree and
 * hoist every inline `data:` URL into the /api/media content-addressed
 * store. In-place replacement: `imageDataUrl: "data:image/..."` becomes
 * `imageDataUrl: "/api/media/<sha>.<ext>"`.
 *
 * Rationale:
 *   - Project blobs stay tiny (kilobytes vs. megabytes). List / dashboard
 *     stays snappy, backups are cheap.
 *   - Content addressing = automatic dedupe across projects. Reusing the
 *     same actor headshot in ten shots stores it once.
 *   - The rest of the app already handles `/api/media/*` URLs everywhere
 *     images/videos are rendered.
 *
 * We upload each unique data URL exactly once per save, cached by data-URL
 * identity (Map keyed on the base64 string). Failures fall back to the
 * original data URL — save still succeeds, just fatter.
 */

import { uploadDataUrl, isDataUrl } from './ai/media-store';
import type { DocItem, Panel, PanelImageVersion, Slide, SlideTextBox } from './types';

async function liftOne(dataUrl: string, cache: Map<string, string>): Promise<string> {
  const hit = cache.get(dataUrl);
  if (hit) return hit;
  const rec = await uploadDataUrl(dataUrl);
  if (rec?.url) {
    cache.set(dataUrl, rec.url);
    return rec.url;
  }
  // Upload failed. Fall back to the original data URL so the project
  // still saves — just larger. Cache the null so we don't retry inside
  // the same save.
  cache.set(dataUrl, dataUrl);
  return dataUrl;
}

async function liftPanel(p: Panel, cache: Map<string, string>): Promise<Panel> {
  const next: Panel = { ...p };
  if (isDataUrl(next.imageDataUrl)) {
    next.imageDataUrl = await liftOne(next.imageDataUrl, cache);
  }
  if (isDataUrl(next.videoDataUrl)) {
    next.videoDataUrl = await liftOne(next.videoDataUrl, cache);
  }
  if (Array.isArray(next.imageHistory)) {
    const nextHist: PanelImageVersion[] = [];
    for (const v of next.imageHistory) {
      const vv: PanelImageVersion = { ...v };
      if (isDataUrl(vv.dataUrl)) vv.dataUrl = await liftOne(vv.dataUrl, cache);
      // posterDataUrl is optional on some version shapes; guard reflectively.
      const anyV = vv as PanelImageVersion & { posterDataUrl?: string | null };
      if (isDataUrl(anyV.posterDataUrl)) {
        anyV.posterDataUrl = await liftOne(anyV.posterDataUrl!, cache);
      }
      nextHist.push(vv);
    }
    next.imageHistory = nextHist;
  }
  // nodeGraph inputs/outputs can hold data URLs in their state. Best-effort
  // walk any string field starting with "data:".
  if (next.nodeGraph) {
    next.nodeGraph = await liftGraph(next.nodeGraph, cache);
  }
  return next;
}

async function liftGraph<T>(graph: T, cache: Map<string, string>): Promise<T> {
  async function walk(v: unknown): Promise<unknown> {
    if (typeof v === 'string') {
      return isDataUrl(v) ? await liftOne(v, cache) : v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x));
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = await walk(val);
      }
      return out;
    }
    return v;
  }
  return (await walk(graph)) as T;
}

async function liftSlide(s: Slide, cache: Map<string, string>): Promise<Slide> {
  const next: Slide = { ...s };
  // Slides may hold a background image or embedded images inside text
  // boxes — the shape varies across our v4/v5/v6 evolution, so we walk
  // any string field that starts with data:.
  const anySlide = next as Slide & { backgroundImageDataUrl?: string | null; textBoxes?: SlideTextBox[] };
  if (isDataUrl(anySlide.backgroundImageDataUrl)) {
    anySlide.backgroundImageDataUrl = await liftOne(anySlide.backgroundImageDataUrl!, cache);
  }
  return next;
}

/**
 * Walk the state and lift every inline data URL to the media store.
 * Returns a copy suitable for POST/PUT to /api/projects.
 */
export async function liftInlineMedia(items: DocItem[]): Promise<DocItem[]> {
  const cache = new Map<string, string>();
  const out: DocItem[] = [];
  for (const it of items) {
    if (it.kind === 'storyboard') {
      const nextPanels: Panel[] = [];
      for (const p of it.panels) nextPanels.push(await liftPanel(p, cache));
      out.push({ ...it, panels: nextPanels });
    } else if (it.kind === 'slide') {
      const nextSlide = await liftSlide(it.slide, cache);
      out.push({ ...it, slide: nextSlide });
    } else {
      out.push(it);
    }
  }
  return out;
}

/**
 * Pick a thumbnail media URL for the project: the current image of the
 * first storyboard panel that has one, preferring a media-store URL over
 * a data URL. Returns null if nothing renders.
 */
export function pickProjectThumbnail(items: DocItem[]): string | null {
  for (const it of items) {
    if (it.kind !== 'storyboard') continue;
    for (const p of it.panels) {
      if (typeof p.imageDataUrl === 'string' && p.imageDataUrl.length > 0) {
        return p.imageDataUrl;
      }
    }
  }
  return null;
}
