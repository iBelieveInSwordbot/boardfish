/**
 * App-shell utilities: current-project id persistence + one-time migration
 * from the legacy IndexedDB autosave into the server-backed project store.
 */

import { createProject, listProjects } from './projects-api';
import { idbGet, idbSet } from './idb-store';
import type { DocItem, ProjectSettings } from './types';

const CURRENT_KEY = 'boardfish:currentProjectId';
const MIGRATION_KEY = 'boardfish3:autosave-migrated:v1';
const LEGACY_IDB_KEY = 'boardfish3:autosave:v11';

export function getCurrentProjectId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export function setCurrentProjectId(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * If the user has a legacy IndexedDB autosave AND the server has no
 * projects yet AND we haven't already migrated, POST it as a new
 * "Untitled Project" (or whatever name the settings say).
 *
 * Returns the id of the newly-created project (so App can auto-open it),
 * or null if no migration happened.
 */
export async function maybeMigrateLegacyAutosave(): Promise<string | null> {
  try {
    const migrated = localStorage.getItem(MIGRATION_KEY);
    if (migrated === '1') return null;

    // Only migrate into an empty catalog. If the user has any project on
    // the server already, treat legacy as done (avoid duplicates from
    // re-imports).
    const existing = await listProjects().catch(() => []);
    if (existing.length > 0) {
      try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
      return null;
    }

    const saved = await idbGet<{ settings?: ProjectSettings; items?: DocItem[] }>(LEGACY_IDB_KEY);
    if (!saved?.settings || !Array.isArray(saved?.items)) {
      // Nothing to migrate; mark done so we don't rescan every launch.
      try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
      return null;
    }
    // Trivially empty projects (no items, default settings) aren't worth
    // preserving as a distinct entry. Let the user start fresh instead.
    if (saved.items.length === 0) {
      try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
      return null;
    }

    const name = saved.settings.projectName || 'Untitled Project';
    const summary = await createProject({
      name,
      settings: saved.settings,
      items: saved.items,
    });

    try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
    return summary.id;
  } catch (err) {
    // Don't block app startup on migration failure.
    // eslint-disable-next-line no-console
    console.warn('[boardfish] autosave migration failed', err);
    return null;
  }
}

/**
 * Test hook — force a fresh migration on next launch. Not used in prod.
 * @internal
 */
export async function _resetMigrationMarker(): Promise<void> {
  try { localStorage.removeItem(MIGRATION_KEY); } catch { /* ignore */ }
  try { await idbSet(MIGRATION_KEY, null); } catch { /* ignore */ }
}
