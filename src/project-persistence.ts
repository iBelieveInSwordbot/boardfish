/**
 * Server-backed persistence for the currently open project.
 *
 * Boardfish AI stores each project as a JSON file at
 *   boardfish-ai/data/projects/<id>.json
 * via the ai-proxy's /api/projects endpoints. This module owns the
 * "current project" lifecycle:
 *
 *   1. When `currentProjectId` becomes non-null, fetch the project from
 *      the server and dispatch `LOAD_PROJECT` so the reducer replaces
 *      state.settings + state.items.
 *
 *   2. After hydration, debounce every state change into a PUT that
 *      lifts inline data URLs into /api/media and saves the lightweight
 *      blob. If the PUT fails, we buffer the payload in IndexedDB and
 *      retry on the next change.
 */

import { useEffect, useRef } from 'react';
import type { Action, BoardfishState } from './store';
import { fetchProject, saveProjectBlob } from './projects-api';
import { liftInlineMedia, pickProjectThumbnail } from './project-media';
import { idbDel, idbGet, idbSet } from './idb-store';

const PENDING_KEY_PREFIX = 'boardfish3:pending-save:';
const AUTOSAVE_DEBOUNCE_MS = 1500;

type Options = {
  /** Called after each successful save. */
  onSaved?: (info: { name: string; modified: number }) => void;
  /** Called on hydrate or save error. */
  onError?: (err: Error) => void;
  /** Fires true after the initial load resolves (success or fail). */
  onHydrated?: (hydrated: boolean) => void;
};

/**
 * Wire an open project id into server-backed persistence. Loads the
 * project on mount, saves on every state change (debounced).
 */
export function useProjectPersistence(
  currentProjectId: string | null,
  state: BoardfishState,
  dispatch: React.Dispatch<Action>,
  opts: Options = {},
) {
  const hydratedRef = useRef<{ id: string | null; done: boolean }>({ id: null, done: false });
  const pendingTimer = useRef<number | null>(null);
  const inFlight = useRef<boolean>(false);
  const latestState = useRef<BoardfishState>(state);
  latestState.current = state;

  // Load on project change.
  useEffect(() => {
    hydratedRef.current = { id: currentProjectId, done: false };
    if (currentProjectId == null) {
      opts.onHydrated?.(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const proj = await fetchProject(currentProjectId);
        if (cancelled) return;
        // Prefer the settings.projectName (in-document source of truth); fall
        // back to the server-side meta.name if the loaded settings don't
        // carry a name yet.
        const settingsForLoad = { ...proj.settings };
        if (!settingsForLoad.projectName && proj.meta?.name) {
          settingsForLoad.projectName = proj.meta.name;
        }
        dispatch({ type: 'LOAD_PROJECT', state: { settings: settingsForLoad, items: proj.items } });
        hydratedRef.current = { id: currentProjectId, done: true };
        opts.onHydrated?.(true);
      } catch (err) {
        if (cancelled) return;
        opts.onError?.(err as Error);
        hydratedRef.current = { id: currentProjectId, done: true };
        opts.onHydrated?.(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // Save on state change (debounced).
  useEffect(() => {
    if (!currentProjectId) return;
    if (!hydratedRef.current.done || hydratedRef.current.id !== currentProjectId) return;

    async function runSave(idAtSave: string) {
      if (inFlight.current) return; // caller will reschedule
      inFlight.current = true;
      try {
        const snap = latestState.current;
        const items = await liftInlineMedia(snap.items);
        const thumb = pickProjectThumbnail(items);
        const meta = await saveProjectBlob({
          id: idAtSave,
          name: snap.settings.projectName || 'Untitled Project',
          settings: snap.settings,
          items,
          thumbnailMediaUrl: thumb,
        });
        try { await idbDel(PENDING_KEY_PREFIX + idAtSave); } catch { /* ignore */ }
        opts.onSaved?.({ name: meta.name, modified: meta.modified });
      } catch (err) {
        const snap = latestState.current;
        try {
          await idbSet(PENDING_KEY_PREFIX + idAtSave, {
            id: idAtSave,
            name: snap.settings.projectName || 'Untitled Project',
            settings: snap.settings,
            items: snap.items,
            savedAt: Date.now(),
          });
        } catch {
          /* ignore */
        }
        opts.onError?.(err as Error);
      } finally {
        inFlight.current = false;
      }
    }

    if (pendingTimer.current != null) {
      window.clearTimeout(pendingTimer.current);
    }

    const idAtScheduling = currentProjectId;
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null;
      void runSave(idAtScheduling);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (pendingTimer.current != null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
    };
  }, [state.settings, state.items, currentProjectId]);
}

/**
 * Read a buffered pending-save (from a failed save on a previous session).
 */
export async function getPendingBuffer(projectId: string): Promise<null | {
  id: string;
  name: string;
  settings: BoardfishState['settings'];
  items: BoardfishState['items'];
  savedAt: number;
}> {
  try {
    const v = await idbGet<{
      id: string;
      name: string;
      settings: BoardfishState['settings'];
      items: BoardfishState['items'];
      savedAt: number;
    }>(PENDING_KEY_PREFIX + projectId);
    return v ?? null;
  } catch {
    return null;
  }
}
