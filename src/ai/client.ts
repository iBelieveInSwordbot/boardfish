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
