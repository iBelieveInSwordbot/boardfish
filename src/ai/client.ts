// Boardfish 4 AI client. Talks to the local ai-proxy (default 127.0.0.1:5174,
// routed through Vite's /api proxy in dev). In production build, the app
// expects the same-origin /api routes to be reverse-proxied to the ai-proxy.

import type { ImageGenResponse, Shot, ShotList, ShotListResponse } from './types';

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j.ok);
  } catch {
    return false;
  }
}

export async function generateShotList(input: {
  script: string;
  defaultAspect?: string;
  constraints?: string;
  sessionId?: string | null;
  directorRefs?: string;
  styleKey?: string;
}): Promise<{ shotList: ShotList; sessionId: string | null }> {
  const res = await postJson<ShotListResponse>('/api/ronan/shot-list', input);
  return { shotList: res.shotList, sessionId: res.sessionId };
}

export type StylePreset = { key: string; label: string; tag: string };

export async function listStyles(): Promise<StylePreset[]> {
  try {
    const res = await fetch('/api/styles');
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.styles) ? j.styles : [];
  } catch {
    return [];
  }
}

export async function refineShot(input: {
  instruction: string;
  shot: Shot;
  sessionId?: string | null;
  defaultAspect?: string;
}): Promise<{ shot: Shot; sessionId: string | null }> {
  const res = await postJson<{ ok: true; sessionId: string | null; shot: Shot }>('/api/ronan/refine', input);
  return { shot: res.shot, sessionId: res.sessionId };
}

export async function generatePanelImage(input: {
  prompt: string;
  aspectRatio?: string; // "16:9", "9:16", etc.
}): Promise<ImageGenResponse> {
  return postJson<ImageGenResponse>('/api/image/generate', input);
}

// ---------- PDF / text import (Boardfish 6) ----------

export type ImportPdfResponse = {
  ok: true;
  filename: string;
  text: string;
  pages: number;
  kind: 'pdf' | 'text';
};

/**
 * Upload a PDF (or plain text file) to the AI proxy and get the extracted
 * text back. The browser hands off the raw File; the server does the parse.
 */
export async function importScriptFile(file: File): Promise<ImportPdfResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/import/pdf', { method: 'POST', body: form });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<ImportPdfResponse>;
}

// ---------- FAL passthrough (Boardfish 5 node editor) ----------
//
// Every FAL call from the browser goes through the local ai-proxy at
// POST /api/fal/run. The proxy holds FAL_KEY server-side, submits the job
// to https://queue.fal.run, polls until COMPLETED / FAILED, and returns
// { ok, requestId, endpoint, result }.

export type FalRunResponse = {
  ok: true;
  requestId: string;
  endpoint: string;
  result: Record<string, unknown>;
};

export async function runFalJob(
  endpoint: string,
  input: Record<string, unknown>,
): Promise<FalRunResponse> {
  return postJson<FalRunResponse>('/api/fal/run', { endpoint, input });
}

// ---------- FAL Platform APIs (billing + pricing) ----------
//
// Both go through the local ai-proxy which caches responses and holds
// the admin-scope FAL_ADMIN_KEY server-side. Browser never sees the key.

export type FalBillingInfo = {
  ok: true;
  balance: number | null;
  currency: string;
  pricePerCredit: number;
  fetchedAt: number;
  fresh: boolean;
};

export type FalPriceInfo = {
  ok: true;
  endpointId: string;
  unit: string;         // "images", "seconds", "1m tokens", "compute seconds"
  unitPrice: number;    // USD per unit
  currency: string;
  fetchedAt: number;
  fresh: boolean;
};

/** Fetch current fal credit balance for the node view top bar. */
export async function fetchFalBilling(): Promise<FalBillingInfo | null> {
  try {
    const res = await fetch('/api/fal/billing');
    if (!res.ok) return null;
    return (await res.json()) as FalBillingInfo;
  } catch {
    return null;
  }
}

/** Fetch per-endpoint pricing for the Generate button cost hint. */
export async function fetchFalPrice(endpointId: string): Promise<FalPriceInfo | null> {
  if (!endpointId) return null;
  try {
    const res = await fetch(`/api/fal/price?endpoint=${encodeURIComponent(endpointId)}`);
    if (!res.ok) return null;
    return (await res.json()) as FalPriceInfo;
  } catch {
    return null;
  }
}

// Given a FAL result blob, best-effort extract the primary image URL.
// Handles common shapes across SDXL / Flux / Nano Banana / OpenAI-via-FAL.
export function extractImageUrl(result: Record<string, unknown>): string | null {
  if (!result || typeof result !== 'object') return null;

  // result.images[0].url  (SDXL, Flux, Nano Banana, most image models)
  const images = (result as { images?: unknown }).images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (first && typeof first === 'object') {
      const url = (first as { url?: unknown }).url;
      if (typeof url === 'string' && url) return url;
    }
    if (typeof first === 'string' && first) return first;
  }

  // result.image.url  (some models return a single image object)
  const image = (result as { image?: unknown }).image;
  if (image && typeof image === 'object') {
    const url = (image as { url?: unknown }).url;
    if (typeof url === 'string' && url) return url;
  }
  if (typeof image === 'string' && image) return image;

  // Direct URL fields the wilder end of FAL sometimes uses.
  const outputUrl = (result as { output_url?: unknown }).output_url;
  if (typeof outputUrl === 'string' && outputUrl) return outputUrl;

  const url = (result as { url?: unknown }).url;
  if (typeof url === 'string' && url) return url;

  return null;
}

/**
 * Extract ALL image URLs from a FAL result blob. Same shape logic as
 * extractImageUrl but returns the full array so multi-image gens
 * (num_images > 1) don't silently drop N-1 results.
 */
export function extractImageUrls(result: Record<string, unknown>): string[] {
  if (!result || typeof result !== 'object') return [];
  const out: string[] = [];
  const images = (result as { images?: unknown }).images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (item && typeof item === 'object') {
        const url = (item as { url?: unknown }).url;
        if (typeof url === 'string' && url) out.push(url);
      } else if (typeof item === 'string' && item) {
        out.push(item);
      }
    }
  }
  if (out.length > 0) return out;
  // Fallback: single-image shapes.
  const single = extractImageUrl(result);
  return single ? [single] : [];
}

// Given a FAL result blob, best-effort extract the primary video URL.
// Handles common shapes across Veo / Kling / Seedance / etc.
export function extractVideoUrl(result: Record<string, unknown>): string | null {
  if (!result || typeof result !== 'object') return null;

  // result.video.url  (Veo, Kling, Seedance most commonly)
  const video = (result as { video?: unknown }).video;
  if (video && typeof video === 'object') {
    const url = (video as { url?: unknown }).url;
    if (typeof url === 'string' && url) return url;
  }
  if (typeof video === 'string' && video) return video;

  // result.videos[0].url
  const videos = (result as { videos?: unknown }).videos;
  if (Array.isArray(videos) && videos.length > 0) {
    const first = videos[0];
    if (first && typeof first === 'object') {
      const url = (first as { url?: unknown }).url;
      if (typeof url === 'string' && url) return url;
    }
    if (typeof first === 'string' && first) return first;
  }

  // Fallback URL fields.
  const outputUrl = (result as { output_url?: unknown }).output_url;
  if (typeof outputUrl === 'string' && outputUrl) return outputUrl;

  const url = (result as { url?: unknown }).url;
  if (typeof url === 'string' && url) return url;

  return null;
}

// Fetch a URL and convert it to a data URL. Used so that FAL CDN outputs get
// inlined into the .boardfish project zip (which we control) instead of
// depending on FAL hosting the asset forever.
export async function urlToDataUrl(
  url: string,
): Promise<{ dataUrl: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const mime = blob.type || 'application/octet-stream';
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === 'string') resolve(r);
      else reject(new Error('FileReader did not return a string'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
  return { dataUrl, mime };
}

// Convert a numeric panel aspect ratio (width/height) to the closest supported
// label string. Mirrors the proxy's normalizeAspect(); we send both so the
// server has final say.
export function ratioToLabel(ratio: number): string {
  const opts: [string, number][] = [
    ['1:1', 1], ['2:3', 2/3], ['3:2', 3/2], ['3:4', 3/4], ['4:3', 4/3],
    ['4:5', 4/5], ['5:4', 5/4], ['9:16', 9/16], ['16:9', 16/9], ['21:9', 21/9],
  ];
  let best = opts[0];
  let bestDiff = Infinity;
  for (const opt of opts) {
    const diff = Math.abs(ratio - opt[1]);
    if (diff < bestDiff) { bestDiff = diff; best = opt; }
  }
  return best[0];
}
