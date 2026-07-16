// Boardfish store — pure state + reducer. Zero deps.
import { useEffect, useReducer } from 'react';
import type { DocItem, Panel, ProjectSettings, Slide, SlideTextBox, StoryboardOverrides, ThemePreset } from './types';
import {
  cryptoRandomId,
  defaultSettings,
  migrateSlideFromV3,
  newDefaultTextBox,
  newSlideItem,
  newStoryboardItem,
  themeColors,
} from './types';

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
    panelNumbering: s.panelNumbering ?? defaults.panelNumbering,
    storage: { ...defaults.storage, ...(s.storage ?? {}) },
    pageSize: s.pageSize ?? defaults.pageSize,
  };
}

/** Backfill any missing fields on loaded panels. */
function normalizePanel(p: Partial<Panel>): Panel {
  return {
    id: p.id ?? cryptoRandomId(),
    imageDataUrl: p.imageDataUrl ?? null,
    imageName: p.imageName ?? null,
    videoDataUrl: p.videoDataUrl ?? null,
    cornerNote: p.cornerNote ?? '',
    fields: (p.fields ?? []).map((f) => ({ id: f.id, label: f.label, value: f.value })),
    aiPrompt: p.aiPrompt,
    imageHistory: p.imageHistory ? p.imageHistory.map((v) => ({ ...v })) : undefined,
    styleMode: p.styleMode,
    nodeGraph: p.nodeGraph,
  };
}

function normalizeTextBox(raw: Partial<SlideTextBox> | undefined, fallback: SlideTextBox): SlideTextBox {
  if (!raw) return fallback;
  return {
    id: raw.id ?? fallback.id,
    text: raw.text ?? fallback.text,
    x: typeof raw.x === 'number' ? raw.x : fallback.x,
    y: typeof raw.y === 'number' ? raw.y : fallback.y,
    width: typeof raw.width === 'number' ? raw.width : fallback.width,
    height: typeof raw.height === 'number' ? raw.height : fallback.height,
    fontFamily: raw.fontFamily ?? fallback.fontFamily,
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : fallback.fontSize,
    fontWeight: raw.fontWeight ?? fallback.fontWeight,
    textAlign: raw.textAlign ?? fallback.textAlign,
    italic: raw.italic ?? fallback.italic,
    color: raw.color ?? fallback.color,
  };
}

type RawSlide = Partial<Slide> & {
  title?: string;
  subtitle?: string;
  titleBox?: Partial<SlideTextBox>;
  subtitleBox?: Partial<SlideTextBox>;
  textBoxes?: Partial<SlideTextBox>[];
};

function ensureUniqueBoxIds(boxes: SlideTextBox[]): SlideTextBox[] {
  const seen = new Set<string>();
  return boxes.map((b) => {
    if (!b.id || seen.has(b.id)) {
      const id = cryptoRandomId();
      seen.add(id);
      return { ...b, id };
    }
    seen.add(b.id);
    return b;
  });
}

function normalizeSlide(s: RawSlide): Slide {
  // v5 shape: already has textBoxes[]. Normalize each box.
  if (Array.isArray(s.textBoxes)) {
    const fallback = newDefaultTextBox();
    const boxes = s.textBoxes.map((b) => normalizeTextBox(b, fallback));
    return {
      id: s.id ?? cryptoRandomId(),
      textBoxes: ensureUniqueBoxIds(boxes),
      showFooter: s.showFooter ?? true,
      imageDataUrl: s.imageDataUrl ?? null,
      imageName: s.imageName ?? null,
    };
  }
  // v4 shape: titleBox + subtitleBox. Migrate to textBoxes = [titleBox] (drop subtitle per v5 spec).
  if (s.titleBox) {
    const fallback = newDefaultTextBox();
    const titleBox = normalizeTextBox(s.titleBox, fallback);
    return {
      id: s.id ?? cryptoRandomId(),
      textBoxes: ensureUniqueBoxIds([titleBox]),
      showFooter: s.showFooter ?? true,
      imageDataUrl: s.imageDataUrl ?? null,
      imageName: s.imageName ?? null,
    };
  }
  // v3 shape (title/subtitle strings) — migrate.
  return migrateSlideFromV3({
    id: s.id,
    title: s.title,
    subtitle: s.subtitle,
    showFooter: s.showFooter,
    imageDataUrl: s.imageDataUrl ?? null,
    imageName: s.imageName ?? null,
  });
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
      overrides: (raw.overrides as StoryboardOverrides | undefined) ?? {},
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
  selectedPanelIds: string[]; // storyboard-panel selection (multi)
  lastClickedPanelId: string | null; // anchor for shift-click range
  clipboard: Panel[]; // multi-panel clipboard
  inspectorTab: 'page' | 'panel';
};

/** Back-compat helper: many callers still ask for the single selected id (first in selection). */
export function primarySelectedPanelId(state: BoardfishState): string | null {
  return state.selectedPanelIds[0] ?? null;
}

export type Action =
  | { type: 'ADD_PANELS_TO_ITEM'; itemId: string; panels: Panel[] }
  | { type: 'REORDER_PANELS_WITHIN_ITEM'; itemId: string; ids: string[] }
  | { type: 'SELECT_PANEL'; id: string | null; modifier?: 'set' | 'toggle' | 'range' }
  | { type: 'SELECT_ALL_PANELS' }
  | { type: 'CLEAR_PANEL_SELECTION' }
  | { type: 'SELECT_ITEM'; id: string | null }
  | { type: 'DELETE_PANELS'; ids: string[] }
  | { type: 'CUT_PANELS'; ids: string[] }
  | { type: 'COPY_PANELS'; ids: string[] }
  | { type: 'PASTE_PANELS' }
  | { type: 'DUPLICATE_PANELS'; ids: string[] }
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
  | { type: 'UPDATE_SLIDE_TEXTBOX'; slideId: string; textBoxId: string; patch: Partial<SlideTextBox> }
  | { type: 'ADD_SLIDE_TEXTBOX'; slideId: string; textBox: SlideTextBox }
  | { type: 'REMOVE_SLIDE_TEXTBOX'; slideId: string; textBoxId: string }
  | { type: 'UPDATE_STORYBOARD_OVERRIDES'; id: string; patch: StoryboardOverrides; merge?: boolean }
  | { type: 'CLEAR_STORYBOARD_OVERRIDE'; id: string; section: 'grid' | 'panelAspect' | 'fields' | 'name' }
  | { type: 'SET_LAST_STORYBOARD_PANELS'; panels: Panel[]; name?: string }
  // AI: replace the panel's current image with a new one, pushing the previous
  // image (if any) onto imageHistory. Preserves prompt+timestamp per version.
  | { type: 'APPLY_AI_IMAGE'; panelId: string; dataUrl: string; imageName: string; prompt: string; generatedAt: number }
  // AI: replace the panel's current video with a new one, pushing the previous
  // video (if any) onto imageHistory as a kind:'video' entry. Poster is required
  // so the storyboard grid + PDF export still have a still to render.
  | { type: 'APPLY_AI_VIDEO'; panelId: string; videoDataUrl: string; posterDataUrl: string; prompt: string; generatedAt: number }
  // AI: restore a previous image from history. Puts the current image onto history
  // and swaps in the chosen version.
  | { type: 'RESTORE_AI_IMAGE'; panelId: string; versionId: string }
  // AI: delete a specific history entry (permanent).
  | { type: 'DELETE_AI_HISTORY'; panelId: string; versionId: string }
  // Node editor: replace this panel's saved node graph. Fired on NodeEditor save.
  | { type: 'SET_PANEL_NODE_GRAPH'; panelId: string; graph: unknown }
  | { type: 'LOAD_PROJECT'; state: { settings: ProjectSettings; items: DocItem[] } }
  | { type: 'RESET' };

function initialState(): BoardfishState {
  return {
    settings: defaultSettings(),
    items: [newStoryboardItem()], // start with one empty storyboard
    selectedItemId: null,
    selectedPanelIds: [],
    lastClickedPanelId: null,
    clipboard: [],
    inspectorTab: 'page',
  };
}

/** Flatten all storyboard panels across items in document order (for range selection + ⌘A). */
function flatPanelIds(items: DocItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'storyboard') {
      for (const p of it.panels) out.push(p.id);
    }
  }
  return out;
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
  const primary = primarySelectedPanelId(state);
  if (primary) {
    const loc = findPanelLocation(state.items, primary);
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
      const firstAddedId = action.panels[0]?.id;
      return {
        ...state,
        items: updateStoryboardPanels(state.items, idx, newPanels),
        selectedPanelIds: firstAddedId ? [firstAddedId] : state.selectedPanelIds,
        lastClickedPanelId: firstAddedId ?? state.lastClickedPanelId,
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
    case 'SELECT_PANEL': {
      const mod = action.modifier ?? 'set';
      if (!action.id) {
        return {
          ...state,
          selectedPanelIds: [],
          lastClickedPanelId: null,
          inspectorTab: state.inspectorTab,
        };
      }
      const id = action.id;
      let nextIds: string[];
      if (mod === 'toggle') {
        // ⌘-click: add/remove from selection
        nextIds = state.selectedPanelIds.includes(id)
          ? state.selectedPanelIds.filter((x) => x !== id)
          : [...state.selectedPanelIds, id];
      } else if (mod === 'range') {
        // Shift-click: select from anchor to id inclusive in document order
        const flat = flatPanelIds(state.items);
        const anchorId = state.lastClickedPanelId ?? primarySelectedPanelId(state) ?? id;
        const a = flat.indexOf(anchorId);
        const b = flat.indexOf(id);
        if (a < 0 || b < 0) {
          nextIds = [id];
        } else {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          nextIds = flat.slice(lo, hi + 1);
        }
      } else {
        // Plain click: replace selection
        nextIds = [id];
      }
      return {
        ...state,
        selectedPanelIds: nextIds,
        lastClickedPanelId: id,
        inspectorTab: 'panel',
      };
    }
    case 'SELECT_ALL_PANELS': {
      const all = flatPanelIds(state.items);
      return { ...state, selectedPanelIds: all, lastClickedPanelId: all[all.length - 1] ?? null };
    }
    case 'CLEAR_PANEL_SELECTION':
      return { ...state, selectedPanelIds: [], lastClickedPanelId: null };
    case 'SELECT_ITEM':
      return { ...state, selectedItemId: action.id, selectedPanelIds: [], lastClickedPanelId: null };
    case 'DELETE_PANELS': {
      const idsToRemove = new Set(action.ids);
      if (idsToRemove.size === 0) return state;
      // Track a next-selection candidate: the panel just after the last removed in doc order,
      // or the one just before if we removed the tail.
      const flat = flatPanelIds(state.items);
      const lastRemoved = action.ids[action.ids.length - 1];
      const lastIdx = flat.indexOf(lastRemoved);
      const nextFocus =
        (() => {
          for (let i = lastIdx + 1; i < flat.length; i++) if (!idsToRemove.has(flat[i])) return flat[i];
          for (let i = lastIdx - 1; i >= 0; i--) if (!idsToRemove.has(flat[i])) return flat[i];
          return null;
        })();
      const items = state.items.map((it) => {
        if (it.kind !== 'storyboard') return it;
        const next = it.panels.filter((p) => !idsToRemove.has(p.id));
        return next === it.panels ? it : { ...it, panels: next };
      });
      return {
        ...state,
        items,
        selectedPanelIds: nextFocus ? [nextFocus] : [],
        lastClickedPanelId: nextFocus,
      };
    }
    case 'CUT_PANELS': {
      if (action.ids.length === 0) return state;
      const idsSet = new Set(action.ids);
      // Clipboard: cloned panels in document order (matching action.ids order after sorting by doc pos)
      const flat = flatPanelIds(state.items);
      const orderedIds = flat.filter((id) => idsSet.has(id));
      const clones: Panel[] = [];
      for (const id of orderedIds) {
        const loc = findPanelLocation(state.items, id);
        if (loc) clones.push(deepClonePanel(loc.panel));
      }
      const flatAll = flatPanelIds(state.items);
      const lastRemoved = orderedIds[orderedIds.length - 1];
      const lastIdx = flatAll.indexOf(lastRemoved);
      const nextFocus =
        (() => {
          for (let i = lastIdx + 1; i < flatAll.length; i++) if (!idsSet.has(flatAll[i])) return flatAll[i];
          for (let i = lastIdx - 1; i >= 0; i--) if (!idsSet.has(flatAll[i])) return flatAll[i];
          return null;
        })();
      const items = state.items.map((it) => {
        if (it.kind !== 'storyboard') return it;
        const next = it.panels.filter((p) => !idsSet.has(p.id));
        return next === it.panels ? it : { ...it, panels: next };
      });
      return {
        ...state,
        items,
        selectedPanelIds: nextFocus ? [nextFocus] : [],
        lastClickedPanelId: nextFocus,
        clipboard: clones,
      };
    }
    case 'COPY_PANELS': {
      if (action.ids.length === 0) return state;
      const idsSet = new Set(action.ids);
      const flat = flatPanelIds(state.items);
      const orderedIds = flat.filter((id) => idsSet.has(id));
      const clones: Panel[] = [];
      for (const id of orderedIds) {
        const loc = findPanelLocation(state.items, id);
        if (loc) clones.push(deepClonePanel(loc.panel));
      }
      return { ...state, clipboard: clones };
    }
    case 'PASTE_PANELS': {
      if (state.clipboard.length === 0) return state;
      // Re-id every clipboard clone so pasted panels are independent
      const clones = state.clipboard.map((p) => {
        const c = deepClonePanel(p);
        c.id = cryptoRandomId();
        c.fields = c.fields.map((f) => ({ ...f, id: cryptoRandomId() }));
        return c;
      });
      // Paste destination: item containing primary selection, or nearest storyboard
      let destItemIdx = -1;
      let destPanelIdx = -1;
      const primary = primarySelectedPanelId(state);
      if (primary) {
        const loc = findPanelLocation(state.items, primary);
        if (loc) {
          destItemIdx = loc.itemIdx;
          destPanelIdx = loc.panelIdx;
        }
      }
      if (destItemIdx < 0) {
        const targetId = nearestStoryboardItemId(state);
        destItemIdx = state.items.findIndex((it) => it.id === targetId);
        if (destItemIdx < 0) return state;
        const it = state.items[destItemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
        destPanelIdx = it.panels.length - 1;
      }
      const destItem = state.items[destItemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      // Insert all clones after destPanelIdx, preserving clipboard order
      const next = destItem.panels.slice();
      next.splice(destPanelIdx + 1, 0, ...clones);
      const items = state.items.map((it, i) =>
        i === destItemIdx && it.kind === 'storyboard' ? { ...it, panels: next } : it,
      );
      const newIds = clones.map((c) => c.id);
      return {
        ...state,
        items,
        selectedPanelIds: newIds,
        lastClickedPanelId: newIds[newIds.length - 1] ?? null,
      };
    }
    case 'DUPLICATE_PANELS': {
      if (action.ids.length === 0) return state;
      const idsSet = new Set(action.ids);
      const flat = flatPanelIds(state.items);
      const orderedIds = flat.filter((id) => idsSet.has(id));
      // Group source panels by their owning storyboard, then insert clones after the last
      // selected panel in each storyboard.
      const byItem = new Map<string, { indices: number[]; clones: Panel[] }>();
      for (const id of orderedIds) {
        const loc = findPanelLocation(state.items, id);
        if (!loc) continue;
        const storyId = state.items[loc.itemIdx].id;
        if (!byItem.has(storyId)) byItem.set(storyId, { indices: [], clones: [] });
        const entry = byItem.get(storyId)!;
        entry.indices.push(loc.panelIdx);
        const clone = deepClonePanel(loc.panel);
        clone.id = cryptoRandomId();
        clone.fields = clone.fields.map((f) => ({ ...f, id: cryptoRandomId() }));
        entry.clones.push(clone);
      }
      const items = state.items.map((it) => {
        if (it.kind !== 'storyboard') return it;
        const entry = byItem.get(it.id);
        if (!entry) return it;
        const insertAt = Math.max(...entry.indices) + 1;
        const next = it.panels.slice();
        next.splice(insertAt, 0, ...entry.clones);
        return { ...it, panels: next };
      });
      const newIds: string[] = [];
      for (const [, entry] of byItem) newIds.push(...entry.clones.map((c) => c.id));
      return {
        ...state,
        items,
        selectedPanelIds: newIds,
        lastClickedPanelId: newIds[newIds.length - 1] ?? null,
      };
    }
    case 'UPDATE_PANEL': {
      const loc = findPanelLocation(state.items, action.id);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p));
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'APPLY_AI_IMAGE': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => {
        if (p.id !== action.panelId) return p;
        // Archive whichever media is currently "on" the panel. If both an
        // image and a video exist, prefer archiving the video (that's the
        // richer artifact) with the image as its poster.
        const archived: import('./types').PanelImageVersion[] = [];
        if (p.videoDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl ?? '',
            videoDataUrl: p.videoDataUrl,
            kind: 'video',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        } else if (p.imageDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl,
            kind: 'image',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        }
        const prior = [...(p.imageHistory ?? []), ...archived];
        return {
          ...p,
          imageDataUrl: action.dataUrl,
          imageName: action.imageName,
          aiPrompt: action.prompt,
          imageHistory: prior,
        };
      });
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'APPLY_AI_VIDEO': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => {
        if (p.id !== action.panelId) return p;
        // Archive whichever media the panel currently has as a versioned entry.
        const archived: import('./types').PanelImageVersion[] = [];
        if (p.videoDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl ?? '',
            videoDataUrl: p.videoDataUrl,
            kind: 'video',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        } else if (p.imageDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl,
            kind: 'image',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        }
        const prior = [...(p.imageHistory ?? []), ...archived];
        return {
          ...p,
          videoDataUrl: action.videoDataUrl,
          imageDataUrl: action.posterDataUrl,
          aiPrompt: action.prompt,
          imageHistory: prior,
        };
      });
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'RESTORE_AI_IMAGE': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => {
        if (p.id !== action.panelId) return p;
        const history = p.imageHistory ?? [];
        const target = history.find((v) => v.id === action.versionId);
        if (!target) return p;
        // Archive whatever is currently on the panel (image or video).
        const withoutTarget = history.filter((v) => v.id !== action.versionId);
        const archived: import('./types').PanelImageVersion[] = [];
        if (p.videoDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl ?? '',
            videoDataUrl: p.videoDataUrl,
            kind: 'video',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        } else if (p.imageDataUrl) {
          archived.push({
            id: cryptoRandomId(),
            dataUrl: p.imageDataUrl,
            kind: 'image',
            prompt: p.aiPrompt ?? '',
            generatedAt: Date.now(),
          });
        }
        const archivedCurrent = [...withoutTarget, ...archived];
        // Restoring: if the target is a video, restore both video+poster.
        // Otherwise clear the current video and just swap in the image.
        if (target.kind === 'video' && target.videoDataUrl) {
          return {
            ...p,
            imageDataUrl: target.dataUrl || p.imageDataUrl,
            videoDataUrl: target.videoDataUrl,
            aiPrompt: target.prompt || p.aiPrompt,
            imageHistory: archivedCurrent,
          };
        }
        return {
          ...p,
          imageDataUrl: target.dataUrl,
          videoDataUrl: null,
          aiPrompt: target.prompt || p.aiPrompt,
          imageHistory: archivedCurrent,
        };
      });
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'DELETE_AI_HISTORY': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) => {
        if (p.id !== action.panelId) return p;
        return {
          ...p,
          imageHistory: (p.imageHistory ?? []).filter((v) => v.id !== action.versionId),
        };
      });
      return { ...state, items: updateStoryboardPanels(state.items, loc.itemIdx, nextPanels) };
    }
    case 'SET_PANEL_NODE_GRAPH': {
      const loc = findPanelLocation(state.items, action.panelId);
      if (!loc) return state;
      const it = state.items[loc.itemIdx] as Extract<DocItem, { kind: 'storyboard' }>;
      const nextPanels = it.panels.map((p) =>
        p.id === action.panelId ? { ...p, nodeGraph: action.graph } : p,
      );
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
      return { ...state, items, selectedItemId: newItem.id, selectedPanelIds: [], lastClickedPanelId: null };
    }
    case 'SET_LAST_STORYBOARD_PANELS': {
      // AI Director helper: create a new storyboard at the end, seeded with the given
      // panels and (optionally) a name override. Atomic so the AIDrawer can hand off
      // ids for a follow-up image-gen loop.
      const newItem: DocItem = {
        id: cryptoRandomId(),
        kind: 'storyboard',
        panels: action.panels.map(normalizePanel),
        overrides: action.name ? { name: action.name } : {},
      };
      return {
        ...state,
        items: [...state.items, newItem],
        selectedItemId: newItem.id,
        selectedPanelIds: [],
        lastClickedPanelId: null,
      };
    }
    case 'REMOVE_ITEM': {
      const items = state.items.filter((it) => it.id !== action.id);
      // If we deleted the last item, keep an empty storyboard placeholder
      const nextItems = items.length > 0 ? items : [newStoryboardItem()];
      return {
        ...state,
        items: nextItems,
        selectedItemId: state.selectedItemId === action.id ? null : state.selectedItemId,
        selectedPanelIds: [],
        lastClickedPanelId: null,
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
    case 'UPDATE_SLIDE_TEXTBOX': {
      const items = state.items.map((it) => {
        if (it.kind !== 'slide' || it.slide.id !== action.slideId) return it;
        const nextBoxes = it.slide.textBoxes.map((b) =>
          b.id === action.textBoxId ? { ...b, ...action.patch } : b,
        );
        return { ...it, slide: { ...it.slide, textBoxes: nextBoxes } };
      });
      return { ...state, items };
    }
    case 'ADD_SLIDE_TEXTBOX': {
      const items = state.items.map((it) => {
        if (it.kind !== 'slide' || it.slide.id !== action.slideId) return it;
        // If the incoming box's id collides with an existing one on this slide, assign a fresh id.
        const existingIds = new Set(it.slide.textBoxes.map((b) => b.id));
        const boxToAdd: SlideTextBox = existingIds.has(action.textBox.id)
          ? { ...action.textBox, id: cryptoRandomId() }
          : action.textBox;
        return { ...it, slide: { ...it.slide, textBoxes: [...it.slide.textBoxes, boxToAdd] } };
      });
      return { ...state, items };
    }
    case 'REMOVE_SLIDE_TEXTBOX': {
      const items = state.items.map((it) => {
        if (it.kind !== 'slide' || it.slide.id !== action.slideId) return it;
        const nextBoxes = it.slide.textBoxes.filter((b) => b.id !== action.textBoxId);
        return { ...it, slide: { ...it.slide, textBoxes: nextBoxes } };
      });
      return { ...state, items };
    }
    case 'UPDATE_STORYBOARD_OVERRIDES': {
      const items = state.items.map((it) => {
        if (it.kind !== 'storyboard' || it.id !== action.id) return it;
        const prev = it.overrides ?? {};
        // Deep merge each section that appears in the patch
        const merged: StoryboardOverrides = { ...prev };
        if (action.patch.name !== undefined) merged.name = action.patch.name;
        if (action.patch.grid !== undefined) merged.grid = { ...(prev.grid ?? {}), ...action.patch.grid };
        if (action.patch.panelAspect !== undefined)
          merged.panelAspect = { ...(prev.panelAspect ?? {}), ...action.patch.panelAspect };
        if (action.patch.fields !== undefined)
          merged.fields = { ...(prev.fields ?? {}), ...action.patch.fields };

        // If the fields override changed, reconcile every panel's fields[] to match the new label set.
        let panels = it.panels;
        if (action.patch.fields?.defaults) {
          const newLabels = action.patch.fields.defaults;
          panels = panels.map((p) => reconcilePanelFields(p, newLabels));
        }
        return { ...it, overrides: merged, panels };
      });
      return { ...state, items };
    }
    case 'CLEAR_STORYBOARD_OVERRIDE': {
      const items = state.items.map((it) => {
        if (it.kind !== 'storyboard' || it.id !== action.id) return it;
        const next = { ...(it.overrides ?? {}) };
        delete next[action.section];
        // When clearing the fields override, reconcile panels back to the global default labels
        let panels = it.panels;
        if (action.section === 'fields') {
          panels = panels.map((p) => reconcilePanelFields(p, state.settings.labels.defaults));
        }
        return { ...it, overrides: next, panels };
      });
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

/**
 * Reconcile a panel's fields[] to match the desired label list.
 * - Preserves existing field values (and ids) whose labels appear in `desiredLabels`.
 * - Adds empty fields for labels not currently on the panel.
 * - Drops any fields whose labels aren't in the desired list.
 * - Output order matches `desiredLabels`.
 */
function reconcilePanelFields(panel: Panel, desiredLabels: string[]): Panel {
  const byLabel = new Map(panel.fields.map((f) => [f.label, f]));
  const nextFields = desiredLabels.map((label) => {
    const existing = byLabel.get(label);
    return existing ?? { id: cryptoRandomId(), label, value: '' };
  });
  return { ...panel, fields: nextFields };
}

function deepClonePanel(p: Panel): Panel {
  return {
    id: p.id,
    imageDataUrl: p.imageDataUrl,
    imageName: p.imageName,
    cornerNote: p.cornerNote,
    fields: p.fields.map((f) => ({ ...f })),
    aiPrompt: p.aiPrompt,
    imageHistory: p.imageHistory ? p.imageHistory.map((v) => ({ ...v })) : undefined,
    styleMode: p.styleMode,
    nodeGraph: p.nodeGraph,
  };
}

const LS_KEY = 'boardfish3:autosave:v10'; // v10: multi-select (selectedPanelIds[] + Panel[] clipboard)

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

/**
 * Compute a 1-based panel number map. Mode 'continuous' numbers across the whole doc (default);
 * 'per-storyboard' resets to 01 at the start of each storyboard item.
 */
export function panelNumberMap(
  items: DocItem[],
  mode: 'continuous' | 'per-storyboard' = 'continuous',
): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  for (const it of items) {
    if (it.kind !== 'storyboard') continue;
    if (mode === 'per-storyboard') n = 0;
    for (const p of it.panels) {
      n += 1;
      map.set(p.id, n);
    }
  }
  return map;
}

/**
 * Resolve the effective grid + panel-aspect + fields settings for a specific storyboard item,
 * merging global defaults with the item's overrides. Returns a partial ProjectSettings-shaped
 * object with only the overridable keys populated.
 */
export type EffectiveStoryboardSettings = {
  panelsHorizontal: number;
  panelsVertical: number;
  marginPx: number;
  gutterHorizontalPx: number;
  gutterVerticalPx: number;
  panelAspectRatio: number;
  panelAspectLocked: boolean;
  imageFit: import('./types').ImageFit;
  fieldLabels: string[];
};

export function resolveStoryboardSettings(
  settings: ProjectSettings,
  item: Extract<DocItem, { kind: 'storyboard' }>,
): EffectiveStoryboardSettings {
  const o = item.overrides ?? {};
  return {
    panelsHorizontal: o.grid?.panelsHorizontal ?? settings.panelsHorizontal,
    panelsVertical: o.grid?.panelsVertical ?? settings.panelsVertical,
    marginPx: o.grid?.marginPx ?? settings.marginPx,
    gutterHorizontalPx: o.grid?.gutterHorizontalPx ?? settings.gutterHorizontalPx,
    gutterVerticalPx: o.grid?.gutterVerticalPx ?? settings.gutterVerticalPx,
    panelAspectRatio: o.panelAspect?.panelAspectRatio ?? settings.panelAspectRatio,
    panelAspectLocked: o.panelAspect?.panelAspectLocked ?? settings.panelAspectLocked,
    imageFit: o.panelAspect?.imageFit ?? settings.imageFit,
    fieldLabels: o.fields?.defaults ?? settings.labels.defaults,
  };
}

/**
 * Layout the doc into an ordered list of pages. Slides are 1 page each. Storyboards are chunked
 * into pages of `perPage` panels each. Panel numbering is continuous across storyboards.
 */
export type LaidOutPage =
  | { kind: 'storyboard'; itemId: string; panels: Panel[]; startNumber: number }
  | { kind: 'slide'; itemId: string; slide: Slide };

/**
 * Layout the doc into pages. Each storyboard uses its own effective grid (respecting overrides).
 * Panel numbering follows settings.panelNumbering.
 */
export function itemsToPages(items: DocItem[], settings: ProjectSettings): LaidOutPage[] {
  const out: LaidOutPage[] = [];
  const numbers = panelNumberMap(items, settings.panelNumbering);
  for (const it of items) {
    if (it.kind === 'slide') {
      out.push({ kind: 'slide', itemId: it.id, slide: it.slide });
      continue;
    }
    const eff = resolveStoryboardSettings(settings, it);
    const perPage = Math.max(1, eff.panelsHorizontal * eff.panelsVertical);
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
