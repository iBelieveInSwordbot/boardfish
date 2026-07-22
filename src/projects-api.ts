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
  /**
   * Legacy single-folder tag. First entry of `folders` (or null). Kept for
   * backward compatibility — new code should read `folders`.
   */
  folder: string | null;
  /**
   * User-folder aliases the project belongs to. A project can appear in
   * multiple user folders. Empty array = not in any user folder (still
   * appears under "All Projects").
   */
  folders: string[];
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
  folder?: string | null;
}): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      settings: input.settings,
      items: input.items,
      meta: {
        thumbnailMediaUrl: input.thumbnailMediaUrl ?? null,
        folder: input.folder ?? null,
      },
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

/**
 * Legacy single-folder move. Sets folders[] = [folder] (or [] when null).
 * Prefer addProjectToFolder / removeProjectFromFolder for multi-membership.
 */
export async function moveProjectToFolder(
  id: string,
  folder: string | null,
): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder }),
    },
  );
  return { ...j.meta, id: j.id, bytes: 0 };
}

/**
 * Add the project to a user folder (multi-membership). No-op if it's
 * already in the folder.
 */
export async function addProjectToFolder(
  id: string,
  folder: string,
): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addFolder: folder }),
    },
  );
  return { ...j.meta, id: j.id, bytes: 0 };
}

/**
 * Remove the project from a user folder. No-op if it wasn't in it.
 */
export async function removeProjectFromFolder(
  id: string,
  folder: string,
): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeFolder: folder }),
    },
  );
  return { ...j.meta, id: j.id, bytes: 0 };
}

/**
 * Replace the project's folder membership list with `folders`.
 */
export async function setProjectFolders(
  id: string,
  folders: string[],
): Promise<ProjectSummary> {
  const j = await req<{ ok: boolean; id: string; meta: ProjectSummary }>(
    `/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders }),
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

// ---------- Folders ----------

export type FolderRecord = {
  id: string;
  name: string;
  created: number;
  modified: number;
  count: number;
  /** True if this folder was inferred from a project's meta.folder rather
   *  than being explicitly created via /api/folders. Renaming a legacy
   *  folder promotes it into the real folders store. */
  legacy?: boolean;
};

export async function listFolders(): Promise<FolderRecord[]> {
  const j = await req<{ ok: boolean; folders: FolderRecord[] }>('/api/folders');
  return j.folders || [];
}

export async function createFolder(name: string): Promise<FolderRecord> {
  const j = await req<{ ok: boolean; folder: FolderRecord }>('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return j.folder;
}

export async function renameFolder(id: string, name: string): Promise<{ id: string; name: string }> {
  const j = await req<{ ok: boolean; folder: { id: string; name: string } }>(
    `/api/folders/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  return j.folder;
}

export async function deleteFolder(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
