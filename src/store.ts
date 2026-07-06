// Boardfish store — pure state + reducer. Zero deps.
import { useEffect, useReducer } from 'react';
import type { DocItem, Panel, ProjectSettings, Slide, ThemePreset } from './types';
import { cryptoRandomId, defaultSettings, newSlideItem, newStoryboardItem, themeColors } from './types';

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

/** Backfill any missing fields on loaded panels. */
function normalizePanel(p: Partial<Panel>): Panel {
  return {
    id: p.id ?? cryptoRandomId(),
    imageDataUrl: p.imageDataUrl ?? null,
    imageName: p.imageName ?? null,
    cornerNote: p.cornerNote ?? '',
    fields: (p.fields ?? []).map((f) => ({ id: f.id, label: f.label, value: f.value })),
  };
}

function normalizeSlide(s: Partial<Slide>): Slide {
  return {
    id: s.id ?? cryptoRandomId(),
    imageDataUrl: s.imageDataUrl ?? null,
    imageName: s.imageName ?? null,
    title: s.title ?? '',
    subtitle: s.subtitle ?? '',
    showFooter: s.showFooter ?? true,
  };
}

function normalizeItems(items: unknown[]): DocItem[] {
  return (items as Array<Record<string, unknown>>).map((raw) => {
    if (raw.kind === 'slide') {
      return {
        id: (raw.id as string) ?? cryptoRandomId(),
        kind: 'slide',
        slide: normalizeSlide((raw.slide as Partial<Slide>) ?? {}),
      };
    }
    return {
      id: (raw.id as string) ?? cryptoRandomId(),
      kind: 'storyboard',
      panels: ((raw.panels as Partial<Panel>[]) ?? []).map(normalizePanel),
    };
  });
}

/** Legacy support: if a saved project only has `panels[]` (pre-outliner), wrap it in a single storyboard item. */
export function itemsFromLegacyPanels(panels: Partial<Panel>[]): DocItem[] {
  return [newStoryboardItem(panels.map(normalizePanel))];
}

export type BoardfishState = {
  settings: ProjectSettings;
  items: DocItem[]; // ordered doc-level items (slides + storyboards)
  selectedItemId: string | null; // outliner selection
  selectedPanelId: string | null; // storyboard-panel selection (within an item)
  clipboard: Panel | null;
  inspectorTab: 'page' | 'panel';
};

export type Action =
  | { type: 'ADD_PANELS_TO_ITEM'; itemId: string; panels: Panel[] }
  | { type: 'REORDER_PANELS_WITHIN_ITEM'; itemId: string; ids: string[] }
  | { type: 'SELECT_PANEL'; id: string | null }
  | { type: 'SELECT_ITEM'; id: string | null }
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
  | { type: 'ADD_ITEM'; kind: 'slide' | 'storyboard'; afterItemId?: string | null }
  | { type: 'REMOVE_ITEM'; id: string }
  | { type: 'REORDER_ITEMS'; ids: string[] }
  | { type: 'UPDATE_SLIDE'; id: string; patch: Partial<Slide> }
  | { type: 'LOAD_PROJECT'; state: { settings: ProjectSettings; items: DocItem[] } }
  | { type: 'RESET' };

function initialState(): BoardfishState {
  return {
    settings: defaultSettings(),
    items: [newStoryboardItem()], // start with one empty storyboard
    selectedItemId: null,
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

/** Find the item ID that contains a given panel id, plus the panel itself. */
function findPanelLocation(
  items: DocItem[],
  panelId: string,
): { itemIdx: number; panelIdx: number; panel: Panel } | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'storyboard') continue;
    const pi = it.panels.findIndex((p) => p.id === panelId);
    if (pi >= 0) return { itemIdx: i, panelIdx: pi, panel: it.panels[pi] };
  }
  return null;
}

/** Return a *new* items array with one storyboard's panels replaced. */
function updateStoryboardPanels(items: DocItem[], itemIdx: number, panels: Panel[]): DocItem[] {
  return items.map((it, i) =>
    i === itemIdx && it.kind === 'storyboard' ? { ...it, panels } : it,
  );
}

/** Get the item id targeted for panel operations (drop images, paste). */
function nearestStoryboardItemId(state: BoardfishState): string | null {
  // Prefer the item containing the selected panel
  if (state.selectedPanelId) {
    const loc = findPanelLocation(state.items, state.selectedPanelId);
    if (loc) return state.items[loc.itemIdx].id;
  }
  // Prefer the currently-selected item if it's a storyboard
  if (state.selectedItemId) {
    const sel = state.items.find((it) => it.id === state.selectedItemId);
    if (sel && sel.kind === 'storyboard') return sel.id;
  }
  // First storyboard item; or create one implicitly
  const first = state.items.find((it) => it.kind === 'storyboard');
  return first?.id ?? null;
}

function reducer(state: BoardfishState, action: Action): BoardfishState {
  switch (action.type) {
    case 'ADD_PANELS_TO_ITEM': {
      const idx = state.items.findIndex((it) => it.id === action.itemId);
      if (idx < 0 || state.items[idx].kind !== 'storyboard') return state;
      const it = state.items[idx] as Extract<DocItem, { kind: 'storyboard' }>;
      const newPanels = [...it.panels, ...action.panels];
      return {
        ...state,
        items: updateStoryboardPanels(state.items, idx, newPanels),
        selectedPanelId: action.panels[0]?.id ?? state.selectedPanelId,
        selectedItemId: state.items[idx].id,
      };
    }
    case 'REORDER_PANELS_WITHIN_ITEM': {
      const idx = state.items.findIndex((it) => it.id === action.itemId);
      if (idx < 0 || state.items[idx].kind !== 'storyboard') return state;
      const it = state.items[idx] as Extract<DocItem, { kind: 'storyboard' }>;
      const byId = new Map(it.panels.map((p) => [p.id, p]));
      const reordered = action.ids.map((id) => byId.get(id)).filter(Boolean) as Panel[];
      const included = new Set(action.ids);
      const leftover = it.panels.filter((p) => !included.has(p.id));
      return {
        ...state,
        items: updateStoryboardPanels(state.items, idx, [...reordered, ...leftover]),
      };
    }
    case 'SELECT_PANEL':
      return {
        ...state,
        selectedPanelId: action.id,
        inspectorTab: action.id ? 'panel' : state.inspectorTab,
      };
    case 'SELECT_ITEM':
      return { ...state, selectedItemId: action.id, selectedPanelId: null };
    case 'DELETE_PANEL': {
      const loc = findPanelLocation(state.items, action.id);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.filter((p) => p.id !== action.id);
      const newSelected =
        nextPanels[loc.panelIdx]?.id ?? nextPanels[loc.panelIdx - 1]?.id ?? null;
      return {
        ...state,
        items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels),
        selectedPanelId: newSelected,
      };
    }
    case 'CUT_PANEL': {
      const loc = findPanelLocation(state.items, action.id);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.filter((p) => p.id !== action.id);
      const newSelected =
        nextPanels[loc.panelIdx]?.id ?? nextPanels[loc.panelIdx - 1]?.id ?? null;
      return {
        ...state,
        items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels),
        selectedPanelId: newSelected,
        clipboard: deepClonePanel(loc.panel),
      };
    }
    case 'COPY_PANEL': {
      const loc = findPanelLocation(state.items, action.id);
      if (!loc) return state;
      return { ...state, clipboard: deepClonePanel(loc.panel) };
    }
    case 'PASTE_PANEL': {
      if (!state.clipboard) return state;
      const clone = deepClonePanel(state.clipboard);
      clone.id = cryptoRandomId();
      clone.fields = clone.fields.map((f) => ({ ...f, id: cryptoRandomId() }));

      // Paste destination: item containing currently selected panel, or nearest storyboard
      let destItemIdx = -1;
      let destPanelIdx = -1;
      if (state.selectedPanelId) {
        const loc = findPanelLocation(state.items, state.selectedPanelId);
        if (loc) {
          destItemIdx = loc.itemIdx;
          destPanelIdx = loc.panelIdx;
        }
      }
      if (destItemIdx < 0) {
        // Fall back to selected item (if storyboard) or first storyboard
        const targetId = nearestStoryboardItemId(state);
        destItemIdx = state.items.findIndex((it) => it.id === targetId);
        if (destItemIdx < 0) return state;
        const it = state.items[destItemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
        destPanelIdx = it.panels.length - 1; // append at end
      }
      const destItem = state.items[destItemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = insertAfter(destItem.panels, destPanelIdx, clone);
      return {
        ...state,
        items: updateStoryboardPanels(state.items, destItemIdx, nextPanels),
        selectedPanelId: clone.id,
      };
    }
    case 'UPDATE_PANEL': {
      const loc = findPanelLocation(state.items, action.id);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p));
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'UPDATE_FIELD': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) =>
        p.id === action.panelId
          ? { ...p, fields: p.fields.map((f) => (f.id === action.fieldId ? { ...f, value: action.value } : f)) }
          : p,
      );
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'ADD_FIELD': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) =>
        p.id === action.panelId
          ? { ...p, fields: [...p.fields, { id: cryptoRandomId(), label: action.label, value: '' }] }
          : p,
      );
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'REMOVE_FIELD': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) =>
        p.id === action.panelId ? { ...p, fields: p.fields.filter((f) => f.id !== action.fieldId) } : p,
      );
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'RENAME_FIELD_LABEL_GLOBAL': {
      const { oldLabel, newLabel } = action;
      const settings: ProjectSettings = {
        ...state.settings,
        labels: {
          ...state.settings.labels,
          defaults: state.settings.labels.defaults.map((l) => (l === oldLabel ? newLabel : l)),
        },
      };
      const items = state.items.map((it) =>
        it.kind === 'storyboard'
          ? {
              ...it,
              panels: it.panels.map((p) => ({
                ...p,
                fields: p.fields.map((f) => (f.label === oldLabel ? { ...f, label: newLabel } : f)),
              })),
            }
          : it,
      );
      return { ...state, settings, items };
    }
    case 'ADD_FIELD_GLOBAL': {
      const settings: ProjectSettings = {
        ...state.settings,
        labels: { ...state.settings.labels, defaults: [...state.settings.labels.defaults, action.label] },
      };
      const items = state.items.map((it) =>
        it.kind === 'storyboard'
          ? {
              ...it,
              panels: it.panels.map((p) => ({
                ...p,
                fields: [...p.fields, { id: cryptoRandomId(), label: action.label, value: '' }],
              })),
            }
          : it,
      );
      return { ...state, settings, items };
    }
    case 'REMOVE_FIELD_GLOBAL': {
      const settings: ProjectSettings = {
        ...state.settings,
        labels: {
          ...state.settings.labels,
          defaults: state.settings.labels.defaults.filter((l) => l !== action.label),
        },
      };
      const items = state.items.map((it) =>
        it.kind === 'storyboard'
          ? {
              ...it,
              panels: it.panels.map((p) => ({ ...p, fields: p.fields.filter((f) => f.label !== action.label) })),
            }
          : it,
      );
      return { ...state, settings, items };
    }
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'SET_INSPECTOR_TAB':
      return { ...state, inspectorTab: action.tab };
    case 'APPLY_THEME':
      return { ...state, settings: { ...state.settings, colors: themeColors(action.theme) } };
    case 'SET_CORNER_NOTE': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => (p.id === action.panelId ? { ...p, cornerNote: action.value } : p));
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'ADD_ITEM': {
      const newItem = action.kind === 'slide' ? newSlideItem() : newStoryboardItem();
      const afterIdx = action.afterItemId
        ? state.items.findIndex((it) => it.id === action.afterItemId)
        : state.items.length - 1;
      const items = insertAfter(state.items, afterIdx, newItem);
      return { ...state, items, selectedItemId: newItem.id, selectedPanelId: null };
    }
    case 'REMOVE_ITEM': {
      const items = state.items.filter((it) => it.id !== action.id);
      // If we deleted the last item, keep an empty storyboard placeholder
      const nextItems = items.length > 0 ? items : [newStoryboardItem()];
      return {
        ...state,
        items: nextItems,
        selectedItemId: state.selectedItemId === action.id ? null : state.selectedItemId,
        selectedPanelId: null,
      };
    }
    case 'REORDER_ITEMS': {
      const byId = new Map(state.items.map((it) => [it.id, it]));
      const reordered = action.ids.map((id) => byId.get(id)).filter(Boolean) as DocItem[];
      const included = new Set(action.ids);
      const leftover = state.items.filter((it) => !included.has(it.id));
      return { ...state, items: [...reordered, ...leftover] };
    }
    case 'UPDATE_SLIDE': {
      const items = state.items.map((it) =>
        it.kind === 'slide' && it.slide.id === action.id
          ? { ...it, slide: { ...it.slide, ...action.patch } }
          : it,
      );
      return { ...state, items };
    }
    case 'LOAD_PROJECT':
      return {
        ...initialState(),
        settings: normalizeSettings(action.state.settings),
        items: normalizeItems(action.state.items),
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

const LS_KEY = 'boardfish3:autosave:v8'; // v8: outliner (items[] with slide + storyboard kinds)

export function useBoardfish() {
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { settings: ProjectSettings; items: DocItem[] };
        if (parsed?.settings && Array.isArray(parsed.items)) {
          return {
            ...initialState(),
            settings: normalizeSettings(parsed.settings),
            items: normalizeItems(parsed.items),
          };
        }
      }
    } catch {
      // ignore
    }
    return initialState();
  });

  useEffect(() => {
    try {
      const payload = JSON.stringify({ settings: state.settings, items: state.items });
      localStorage.setItem(LS_KEY, payload);
    } catch {
      // ignore quota errors — user still has Save Project as durable path
    }
  }, [state.settings, state.items]);

  return { state, dispatch };
}

// --- Helpers exposed to components ---

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

/** Flatten all storyboard panels across all items in document order (for continuous numbering + nav). */
export function allStoryboardPanels(items: DocItem[]): Panel[] {
  const out: Panel[] = [];
  for (const it of items) {
    if (it.kind === 'storyboard') out.push(...it.panels);
  }
  return out;
}

/** Continuous 1-based panel number map across the whole document. */
export function panelNumberMap(items: DocItem[]): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  for (const it of items) {
    if (it.kind !== 'storyboard') continue;
    for (const p of it.panels) {
      n += 1;
      map.set(p.id, n);
    }
  }
  return map;
}

/**
 * Layout the doc into an ordered list of pages. Slides are 1 page each. Storyboards are chunked
 * into pages of `perPage` panels each. Panel numbering is continuous across storyboards.
 */
export type LaidOutPage =
  | { kind: 'storyboard'; itemId: string; panels: Panel[]; startNumber: number }
  | { kind: 'slide'; itemId: string; slide: Slide };

export function itemsToPages(items: DocItem[], perPage: number): LaidOutPage[] {
  const out: LaidOutPage[] = [];
  const numbers = panelNumberMap(items);
  for (const it of items) {
    if (it.kind === 'slide') {
      out.push({ kind: 'slide', itemId: it.id, slide: it.slide });
      continue;
    }
    // storyboard: chunk into pages of perPage
    if (it.panels.length === 0) {
      out.push({ kind: 'storyboard', itemId: it.id, panels: [], startNumber: 1 });
      continue;
    }
    for (let i = 0; i < it.panels.length; i += perPage) {
      const chunk = it.panels.slice(i, i + perPage);
      const startNumber = numbers.get(chunk[0].id) ?? 1;
      out.push({ kind: 'storyboard', itemId: it.id, panels: chunk, startNumber });
    }
  }
  return out;
}

/** Find the item id containing a given panel. */
export function itemIdForPanel(items: DocItem[], panelId: string): string | null {
  for (const it of items) {
    if (it.kind !== 'storyboard') continue;
    if (it.panels.some((p) => p.id === panelId)) return it.id;
  }
  return null;
}
