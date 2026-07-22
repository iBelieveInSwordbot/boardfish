/**
 * Boardfish projects API client.
 *
 * Talks to the ai-proxy at /api/projects/* to list, load, create, save,
 * rename, and delete projects. Projects live in
 * boardfish-ai/data/projects/<id>.json on the server and hold the same
 * { settings, items } payload the reducer already knows how to LOAD.
 *
 * Media (base64 data URLs) is expected to be lifted into /api/media
 * BEFORE calling saveProject — see `liftInlineMedia` in ./project-media.ts.
 */

import type { BoardfishState } from './store';
import type { DocItem, ProjectSettings } from './types';

export type ProjectSummary = {
  id: string;
  name: string;
  created: number;
  modified: number;
  thumbnailMediaUrl: string | null;
  bytes: number;
};

export type ProjectPayload = {
  meta: {
    id: string;
    name: string;
    created: number;
    modified: number;
    thumbnailMediaUrl: string | null;
  };
  settings: ProjectSettings;
  items: DocItem[];
};

async function req<T>(input: string, init?: RequestInit): Promise<T> {
  const r = await fetch(input, init);
  const txt = await r.text();
  let j: unknown;
  try { j = JSON.parse(txt); } catch { throw new Error(`bad JSON from ${input}: ${txt.slice(0, 200)}`); }
  if (!r.ok) {
    const msg = (j && typeof j === 'object' && 'error' in j) ? (j as { error: string }).error : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j as T;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const j = await req<{ ok: boolean; projects: ProjectSummary[] }>('/api/projects');
  return j.projects || [];
}

export async function fetchProject(id: string): Promise<ProjectPayload> {
  const j = await req<{ ok: boolean; project: ProjectPayload }>(`/api/projects/${encodeURIComponent(id)}`);
  return j.project;
}

export async function createProject(input: {
  name: string;
  settings: ProjectSettings;
  items: DocItem[];
  thumbnailMediaUrl?: string | null;
}): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      settings: input.settings,
      items: input.items,
      meta: { thumbnailMediaUrl: input.thumbnailMediaUrl ?? null },
    }),
  });
  return { ...j.meta, id: j.id, bytes: 0 };
}

export async function saveProjectBlob(input: {
  id: string;
  name: string;
  settings: ProjectSettings;
  items: DocItem[];
  thumbnailMediaUrl?: string | null;
}): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(input.id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        settings: input.settings,
        items: input.items,
        meta: { thumbnailMediaUrl: input.thumbnailMediaUrl ?? null },
      }),
    },
  );
  return { ...j.meta, id: j.id, bytes: 0 };
}

export async function renameProject(id: string, name: string): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  return { ...j.meta, id: j.id, bytes: 0 };
}

export async function deleteProject(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Duplicate a project on the server. Fetches the current project's blob,
 * then POSTs a new copy with " (Copy)" appended to the name.
 */
export async function duplicateProject(id: string): Promise<ProjectSummary> {
  const src = await fetchProject(id);
  return createProject({
    name: `${src.meta.name} (Copy)`,
    settings: src.settings,
    items: src.items,
    thumbnailMediaUrl: src.meta.thumbnailMediaUrl,
  });
}

/** Convenience: extract the state slice we use in the reducer. */
export function payloadToStateSlice(p: ProjectPayload): Pick<BoardfishState, 'settings' | 'items'> {
  return { settings: p.settings, items: p.items };
}
