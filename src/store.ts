// Boardfish store — pure state + reducer. Zero deps.
import { useEffect, useReducer } from 'react';
import type { Panel, ProjectSettings, ThemePreset } from './types';
import { cryptoRandomId, defaultSettings, themeColors } from './types';

/** Normalize settings loaded from persistence to add any fields introduced after the file was saved. */
function normalizeSettings(s: Partial<ProjectSettings>): ProjectSettings {
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...s,
    colors: { ...defaults.colors, ...(s.colors ?? {}) },
    fonts: { ...defaults.fonts, ...(s.fonts ?? {}) },
    labels: { ...defaults.labels, ...(s.labels ?? {}) },
    footer: { ...defaults.footer, ...(s.footer ?? {}) },
    panelBadges: { ...defaults.panelBadges, ...(s.panelBadges ?? {}) },
    pageSize: s.pageSize ?? defaults.pageSize,
  };
}

/** Backfill any missing fields on loaded panels (e.g. older projects lack cornerNote). */
function normalizePanels(panels: Partial<Panel>[]): Panel[] {
  return panels.map((p) => ({
    id: p.id ?? cryptoRandomId(),
    imageDataUrl: p.imageDataUrl ?? null,
    imageName: p.imageName ?? null,
    cornerNote: p.cornerNote ?? '',
    fields: (p.fields ?? []).map((f) => ({ id: f.id, label: f.label, value: f.value })),
  }));
}

export type BoardfishState = {
  settings: ProjectSettings;
  panels: Panel[]; // flat list; pages derived at render time
  selectedPanelId: string | null;
  clipboard: Panel | null;
  inspectorTab: 'page' | 'panel';
};

export type Action =
  | { type: 'ADD_PANELS'; panels: Panel[] }
  | { type: 'REORDER_PANELS'; ids: string[] }
  | { type: 'SELECT_PANEL'; id: string | null }
  | { type: 'DELETE_PANEL'; id: string }
  | { type: 'CUT_PANEL'; id: string }
  | { type: 'COPY_PANEL'; id: string }
  | { type: 'PASTE_PANEL' }
  | { type: 'UPDATE_PANEL'; id: string; patch: Partial<Panel> }
  | { type: 'UPDATE_FIELD'; panelId: string; fieldId: string; value: string }
  | { type: 'ADD_FIELD'; panelId: string; label: string }
  | { type: 'REMOVE_FIELD'; panelId: string; fieldId: string }
  | { type: 'RENAME_FIELD_LABEL_GLOBAL'; oldLabel: string; newLabel: string }
  | { type: 'ADD_FIELD_GLOBAL'; label: string }
  | { type: 'REMOVE_FIELD_GLOBAL'; label: string }
  | { type: 'UPDATE_SETTINGS'; patch: Partial<ProjectSettings> }
  | { type: 'SET_INSPECTOR_TAB'; tab: 'page' | 'panel' }
  | { type: 'APPLY_THEME'; theme: ThemePreset }
  | { type: 'SET_CORNER_NOTE'; panelId: string; value: string }
  | { type: 'LOAD_PROJECT'; state: Pick<BoardfishState, 'settings' | 'panels'> }
  | { type: 'RESET' };

function initialState(): BoardfishState {
  return {
    settings: defaultSettings(),
    panels: [],
    selectedPanelId: null,
    clipboard: null,
    inspectorTab: 'page',
  };
}

function insertAfter<T>(arr: T[], afterIdx: number, item: T): T[] {
  const copy = arr.slice();
  copy.splice(afterIdx + 1, 0, item);
  return copy;
}

function reducer(state: BoardfishState, action: Action): BoardfishState {
  switch (action.type) {
    case 'ADD_PANELS': {
      // If this is the very first image (settings.panelAspectLocked === true and no panels have images yet),
      // auto-detect aspect from the first image's data URL. We can't sync-measure here without extra work,
      // so we handle that in the caller before dispatching by patching settings.
      return {
        ...state,
        panels: [...state.panels, ...action.panels],
        selectedPanelId: action.panels.length > 0 ? action.panels[0].id : state.selectedPanelId,
      };
    }
    case 'REORDER_PANELS': {
      const byId = new Map(state.panels.map((p) => [p.id, p]));
      const reordered = action.ids.map((id) => byId.get(id)).filter(Boolean) as Panel[];
      // Preserve any panels not included (defensive)
      const included = new Set(action.ids);
      const leftover = state.panels.filter((p) => !included.has(p.id));
      return { ...state, panels: [...reordered, ...leftover] };
    }
    case 'SELECT_PANEL':
      return { ...state, selectedPanelId: action.id, inspectorTab: action.id ? 'panel' : state.inspectorTab };
    case 'DELETE_PANEL': {
      const idx = state.panels.findIndex((p) => p.id === action.id);
      if (idx < 0) return state;
      const panels = state.panels.filter((p) => p.id !== action.id);
      const newSelected = panels[idx]?.id ?? panels[idx - 1]?.id ?? null;
      return { ...state, panels, selectedPanelId: newSelected };
    }
    case 'CUT_PANEL': {
      const panel = state.panels.find((p) => p.id === action.id);
      if (!panel) return state;
      const idx = state.panels.findIndex((p) => p.id === action.id);
      const panels = state.panels.filter((p) => p.id !== action.id);
      const newSelected = panels[idx]?.id ?? panels[idx - 1]?.id ?? null;
      return { ...state, panels, selectedPanelId: newSelected, clipboard: deepClonePanel(panel) };
    }
    case 'COPY_PANEL': {
      const panel = state.panels.find((p) => p.id === action.id);
      if (!panel) return state;
      return { ...state, clipboard: deepClonePanel(panel) };
    }
    case 'PASTE_PANEL': {
      if (!state.clipboard) return state;
      const clone = deepClonePanel(state.clipboard);
      // Re-id the pasted panel + its fields so it's independent
      clone.id = cryptoRandomId();
      clone.fields = clone.fields.map((f) => ({ ...f, id: cryptoRandomId() }));
      const afterIdx = state.selectedPanelId
        ? state.panels.findIndex((p) => p.id === state.selectedPanelId)
        : state.panels.length - 1;
      const panels = insertAfter(state.panels, afterIdx, clone);
      return { ...state, panels, selectedPanelId: clone.id };
    }
    case 'UPDATE_PANEL':
      return {
        ...state,
        panels: state.panels.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p)),
      };
    case 'UPDATE_FIELD':
      return {
        ...state,
        panels: state.panels.map((p) =>
          p.id === action.panelId
            ? { ...p, fields: p.fields.map((f) => (f.id === action.fieldId ? { ...f, value: action.value } : f)) }
            : p,
        ),
      };
    case 'ADD_FIELD':
      return {
        ...state,
        panels: state.panels.map((p) =>
          p.id === action.panelId
            ? { ...p, fields: [...p.fields, { id: cryptoRandomId(), label: action.label, value: '' }] }
            : p,
        ),
      };
    case 'REMOVE_FIELD':
      return {
        ...state,
        panels: state.panels.map((p) =>
          p.id === action.panelId ? { ...p, fields: p.fields.filter((f) => f.id !== action.fieldId) } : p,
        ),
      };
    case 'RENAME_FIELD_LABEL_GLOBAL': {
      // Rename this label everywhere (settings + all panels)
      const oldLabel = action.oldLabel;
      const newLabel = action.newLabel;
      const settings: ProjectSettings = {
        ...state.settings,
        labels: {
          ...state.settings.labels,
          defaults: state.settings.labels.defaults.map((l) => (l === oldLabel ? newLabel : l)),
        },
      };
      const panels = state.panels.map((p) => ({
        ...p,
        fields: p.fields.map((f) => (f.label === oldLabel ? { ...f, label: newLabel } : f)),
      }));
      return { ...state, settings, panels };
    }
    case 'ADD_FIELD_GLOBAL': {
      const settings: ProjectSettings = {
        ...state.settings,
        labels: { ...state.settings.labels, defaults: [...state.settings.labels.defaults, action.label] },
      };
      const panels = state.panels.map((p) => ({
        ...p,
        fields: [...p.fields, { id: cryptoRandomId(), label: action.label, value: '' }],
      }));
      return { ...state, settings, panels };
    }
    case 'REMOVE_FIELD_GLOBAL': {
      const settings: ProjectSettings = {
        ...state.settings,
        labels: {
          ...state.settings.labels,
          defaults: state.settings.labels.defaults.filter((l) => l !== action.label),
        },
      };
      const panels = state.panels.map((p) => ({
        ...p,
        fields: p.fields.filter((f) => f.label !== action.label),
      }));
      return { ...state, settings, panels };
    }
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'SET_INSPECTOR_TAB':
      return { ...state, inspectorTab: action.tab };
    case 'APPLY_THEME':
      return { ...state, settings: { ...state.settings, colors: themeColors(action.theme) } };
    case 'SET_CORNER_NOTE':
      return {
        ...state,
        panels: state.panels.map((p) => (p.id === action.panelId ? { ...p, cornerNote: action.value } : p)),
      };
    case 'LOAD_PROJECT':
      return {
        ...initialState(),
        settings: normalizeSettings(action.state.settings),
        panels: normalizePanels(action.state.panels),
      };
    case 'RESET':
      return initialState();
    default:
      return state;
  }
}

function deepClonePanel(p: Panel): Panel {
  return {
    id: p.id,
    imageDataUrl: p.imageDataUrl,
    imageName: p.imageName,
    cornerNote: p.cornerNote,
    fields: p.fields.map((f) => ({ ...f })),
  };
}

const LS_KEY = 'boardfish3:autosave:v6'; // v6: logo 1.5x default, bold/italic toggles, footer bold default

export function useBoardfish() {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { settings: ProjectSettings; panels: Panel[] };
        if (parsed?.settings && Array.isArray(parsed.panels)) {
          return {
            ...initialState(),
            settings: normalizeSettings(parsed.settings),
            panels: normalizePanels(parsed.panels),
          };
        }
      }
    } catch {
      // ignore
    }
    return initialState();
  });

  // Autosave to localStorage on any change (best-effort; data URLs can be big).
  useEffect(() => {
    try {
      const payload = JSON.stringify({ settings: state.settings, panels: state.panels });
      localStorage.setItem(LS_KEY, payload);
    } catch {
      // Quota — silently ignore; user still has Save Project (.boardfish) as durable path
    }
  }, [state.settings, state.panels]);

  return { state, dispatch };
}

// Helpers -------------------------------------------------------------------

/** Load an image file as data URL and return its natural aspect ratio + data URL. */
export async function fileToPanelImage(file: File): Promise<{ dataUrl: string; aspect: number; name: string }> {
  const dataUrl = await fileToDataUrl(file);
  const aspect = await measureImageAspect(dataUrl);
  return { dataUrl, aspect, name: file.name };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function measureImageAspect(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / img.naturalHeight);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

/** Group flat panel array into pages of (h × v) panels each. */
export function panelsToPages(panels: Panel[], perPage: number): Panel[][] {
  if (perPage <= 0) return [[]];
  const pages: Panel[][] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(panels.length / perPage)); i++) {
    pages.push(panels.slice(i * perPage, (i + 1) * perPage));
  }
  return pages.length > 0 ? pages : [[]];
}
