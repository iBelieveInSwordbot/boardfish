// Boardfish 3.0 — core types

export type PageSize = {
  name: string;
  widthPx: number; // logical pixel dimensions (used for layout math + PDF export scaling)
  heightPx: number;
};

export const PAGE_SIZES: PageSize[] = [
  { name: '16:9 Digital', widthPx: 1920, heightPx: 1080 },
  { name: 'Letter (11×8.5)', widthPx: 1100, heightPx: 850 },
  { name: 'Tabloid (17×11)', widthPx: 1700, heightPx: 1100 },
];

export type PanelAspectRatio = {
  label: string;
  ratio: number; // width / height
};

export const PANEL_ASPECT_RATIOS: PanelAspectRatio[] = [
  { label: '16:9 (HD Video)', ratio: 16 / 9 },
  { label: '9:16 (Vertical Video)', ratio: 9 / 16 },
  { label: '4:3 (SD Video)', ratio: 4 / 3 },
  { label: '3:4 (Vertical SD)', ratio: 3 / 4 },
  { label: '2.39:1 (Cinemascope)', ratio: 2.39 },
  { label: '1.85:1 (Cinema Flat)', ratio: 1.85 },
  { label: '1:1 (Square)', ratio: 1 },
  { label: '3:2 (Photo)', ratio: 3 / 2 },
  { label: '2:3 (Vertical Photo)', ratio: 2 / 3 },
];

export type ImageFit = 'fit' | 'fill' | 'crop';

export type TextField = {
  id: string;
  label: string;
  value: string;
};

export type PanelImageVersion = {
  id: string;
  /** Poster frame (for kind=video) or the image itself (for kind=image/undefined). */
  dataUrl: string;
  prompt: string;
  generatedAt: number; // ms since epoch
  /** Optional — undefined = image (legacy). 'image' | 'video' for new entries. */
  kind?: 'image' | 'video';
  /** When kind='video', the actual video data-URL for playback. */
  videoDataUrl?: string;
  /**
   * Stable generation index (1-based, monotonic). Assigned at creation and
   * preserved when hearting/restoring a version. Legacy panels without
   * `seq` get a stable backfill from the generatedAt-sorted position. See
   * `nextSeqForPanel` / display helpers.
   */
  seq?: number;
};

// Style tag applied to the panel's AI prompt at generation time. Mirrors the
// ai-proxy's STYLE_PRESETS table so ad-hoc panels can pick the same styles
// the scripted AI Director flow offers. 'none' passes the prompt through as-is.
export type PanelStyleMode =
  | 'pencil-sketch'
  | 'ink-wash'
  | 'photoreal'
  | 'noir'
  | 'anime'
  | 'watercolor'
  | 'comic-ink'
  | 'none';

// Kept in sync with ai-proxy/server.js STYLE_PRESETS. Client-side copy is
// used for ad-hoc panel gens where the client sends the fully-styled prompt
// directly to /api/image/generate (no server-side re-appending happens).
export const STYLE_PRESET_TAGS: Record<PanelStyleMode, string> = {
  'pencil-sketch': 'Black-and-white pencil-sketch aesthetic, concise line work, greytone shading.',
  'ink-wash': 'Black-and-white ink-wash illustration, loose brushwork, high-contrast shadows.',
  'photoreal': 'Photorealistic cinematic still, natural lighting, shallow depth of field, film grain.',
  'noir': 'Black-and-white film-noir cinematography, hard chiaroscuro lighting, deep shadows, 35mm grain.',
  'anime': 'Anime key-frame illustration, clean linework, cel-shaded color, dramatic composition.',
  'watercolor': 'Loose watercolor illustration, soft edges, muted palette, paper texture.',
  'comic-ink': 'Comic-book ink illustration, bold outlines, halftone shading, dynamic composition.',
  'none': '',
};

export const STYLE_PRESET_LABELS: Record<PanelStyleMode, string> = {
  'pencil-sketch': 'Pencil sketch',
  'ink-wash': 'Ink wash',
  'photoreal': 'Photoreal',
  'noir': 'Film noir',
  'anime': 'Anime',
  'watercolor': 'Watercolor',
  'comic-ink': 'Comic book ink',
  'none': 'No style',
};

export const PANEL_STYLE_ORDER: PanelStyleMode[] = [
  'pencil-sketch', 'ink-wash', 'photoreal', 'noir', 'anime', 'watercolor', 'comic-ink', 'none',
];

// Legacy alias kept for any lingering imports.
export const STYLE_TAG_PENCIL_SKETCH = STYLE_PRESET_TAGS['pencil-sketch'];

/**
 * Next stable image-generation index for a panel. Considers the current
 * imageSeq plus any seqs on historical versions and returns max + 1
 * (defaults to 1). Used by APPLY_AI_IMAGE / APPLY_AI_VIDEO / RESTORE_AI_IMAGE
 * so newly-generated media get a stable, monotonically-increasing version
 * number.
 */
export function nextSeqForPanel(panel: {
  currentImageSeq?: number;
  imageHistory?: PanelImageVersion[];
}): number {
  let maxSeq = 0;
  const cur = panel.currentImageSeq;
  if (typeof cur === 'number' && Number.isFinite(cur) && cur > maxSeq) maxSeq = cur;
  for (const v of panel.imageHistory ?? []) {
    const s = v.seq;
    if (typeof s === 'number' && Number.isFinite(s) && s > maxSeq) maxSeq = s;
  }
  if (maxSeq > 0) return maxSeq + 1;
  // No sequenced entries. Backfill above the count of unsequenced entries
  // so display seq assignments don't collide.
  const unseqCount =
    (panel.imageHistory ?? []).filter((v) => typeof v.seq !== 'number').length +
    (typeof panel.currentImageSeq !== 'number' ? 1 : 0);
  return unseqCount + 1;
}

export function styleSuffix(mode: PanelStyleMode | undefined): string {
  const effective = mode ?? 'pencil-sketch';
  const tag = STYLE_PRESET_TAGS[effective] ?? '';
  return tag ? ' ' + tag : '';
}

// The node-editor graph attached to a panel. Optional — opened on demand by
// double-clicking a panel image. Stored as `unknown` on Panel to avoid a
// circular import (Panel is used inside project-io, which shouldn't reach into
// the node editor's type surface). Callers cast to NodeGraph from ../nodes/types.
export type PanelNodeGraph = unknown;

export type Panel = {
  id: string;
  imageDataUrl: string | null;
  imageName: string | null;
  /**
   * Optional video attached to the panel. Populated when the node editor's
   * Out node yields a video: we extract the first frame as `imageDataUrl`
   * (so PDF export and the still-based UI keep working) AND stash the full
   * MP4 here for lightbox playback / future export flows.
   */
  videoDataUrl?: string | null;
  fields: TextField[];
  cornerNote: string; // optional per-panel text shown in the top-right corner
  aiPrompt?: string; // last prompt used to generate the panel image (editable, re-gennable)
  imageHistory?: PanelImageVersion[]; // prior AI generations, oldest first. Current image is NOT in this list.
  /**
   * Stable generation index for the CURRENT `imageDataUrl` / `videoDataUrl`.
   * When set, archived history entries preserve this seq so version labels
   * (v1, v2, …) don't renumber when a version is hearted / restored.
   * Optional — legacy panels backfill seqs from generatedAt-sorted order.
   */
  currentImageSeq?: number;
  styleMode?: PanelStyleMode; // undefined = default (pencil-sketch)
  nodeGraph?: PanelNodeGraph; // Saved node-editor graph. Opened on double-click.
};

/** Text alignment for a slide text box. */
export type SlideTextAlign = 'left' | 'center' | 'right';

/** Text weight for a slide text box (numeric CSS font-weight). */
export type SlideFontWeight = 300 | 400 | 500 | 600 | 700 | 800 | 900;

/**
 * A single freeform text box on a section title slide. Position + size are in
 * PERCENTAGES of the slide's inner body (0-100), so slides render correctly at any
 * zoom level or page size. All styling lives on the text box itself.
 */
export type SlideTextBox = {
  id: string;
  text: string;
  /** 0-100 (%) of slide-body width. */
  x: number;
  /** 0-100 (%) of slide-body height. */
  y: number;
  /** 0-100 (%) of slide-body width. */
  width: number;
  /** 0-100 (%) of slide-body height. */
  height: number;
  /** CSS font-family stack. */
  fontFamily: string;
  /** Font size in pixels of the slide's LOGICAL page (matches page.widthPx units). */
  fontSize: number;
  fontWeight: SlideFontWeight;
  textAlign: SlideTextAlign;
  italic: boolean;
  color: string;
};

/** Freeform "slide" (Keynote-style): a collection of floating, individually
 *  styled text boxes.
 *
 *  v3 slides had `title`/`subtitle` strings and an `imageDataUrl`. v4 replaced
 *  those with `titleBox` + `subtitleBox`. v5 collapses the two boxes into an
 *  arbitrary array of `textBoxes` so users can add, duplicate, cut/copy/paste,
 *  and alt-drag boxes on a slide like a real Keynote surface.
 *
 *  The old image / title / subtitle fields are kept as optional legacy holders
 *  for backwards-compatible load only.
 */
export type Slide = {
  id: string;
  textBoxes: SlideTextBox[];
  showFooter: boolean;
  /** @deprecated retained only so old v3 saves round-trip; never rendered in v4+. */
  imageDataUrl?: string | null;
  /** @deprecated see imageDataUrl. */
  imageName?: string | null;
};

/** Font families offered in the slide text-box picker. Web-safe + already-loaded. */
export const SLIDE_FONT_FAMILIES: { label: string; value: string }[] = [
  { label: 'Inter', value: 'Inter, -apple-system, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'Menlo', value: 'Menlo, Monaco, monospace' },
  { label: 'Impact', value: 'Impact, "Haettenschweiler", sans-serif' },
  { label: 'Comic Sans MS', value: '"Comic Sans MS", "Comic Sans", cursive' },
];

/** Font sizes offered in the slide text-box picker. Free-form entry is also allowed. */
export const SLIDE_FONT_SIZES: number[] = [12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96, 128];

/** Font-weight options offered in the slide text-box picker. */
export const SLIDE_FONT_WEIGHTS: { label: string; value: SlideFontWeight }[] = [
  { label: 'Light', value: 300 },
  { label: 'Regular', value: 400 },
  { label: 'Medium', value: 500 },
  { label: 'Semibold', value: 600 },
  { label: 'Bold', value: 700 },
  { label: 'Extra Bold', value: 800 },
  { label: 'Black', value: 900 },
];

/**
 * Default freeform text box seeded on a fresh slide (and used when the user
 * hits the "+ Text" button). Placed roughly in the vertical center with a
 * reasonable default width; the user can move/resize/duplicate it freely.
 */
export function newDefaultTextBox(text = 'Text'): SlideTextBox {
  return {
    id: cryptoRandomId(),
    text,
    // Centered vertically in the top half, spanning most of the width.
    x: 10,
    y: 32,
    width: 80,
    height: 20,
    fontFamily: SLIDE_FONT_FAMILIES[0].value,
    fontSize: 84,
    fontWeight: 700,
    textAlign: 'center',
    italic: false,
    color: '#111111',
  };
}

/**
 * Kept for backwards-compat with any lingering call sites. Not used by the
 * slide UI anymore — v5 slides only have a single kind of text box.
 */
export function newSubtitleTextBox(text = ''): SlideTextBox {
  return {
    id: cryptoRandomId(),
    text,
    x: 15,
    y: 56,
    width: 70,
    height: 12,
    fontFamily: SLIDE_FONT_FAMILIES[0].value,
    fontSize: 36,
    fontWeight: 400,
    textAlign: 'center',
    italic: false,
    color: '#111111',
  };
}

/** Per-storyboard overrides. Undefined fields fall back to global settings. */
export type StoryboardOverrides = {
  name?: string; // optional label shown in outliner + inspector
  grid?: {
    panelsHorizontal?: number;
    panelsVertical?: number;
    marginPx?: number;
    gutterHorizontalPx?: number;
    gutterVerticalPx?: number;
  };
  panelAspect?: {
    panelAspectRatio?: number;
    panelAspectLocked?: boolean;
    imageFit?: ImageFit;
  };
  fields?: {
    defaults?: string[];
  };
};

/** Document-level item: either a slide, or a storyboard block that owns its own panels. */
export type DocItem =
  | { id: string; kind: 'slide'; slide: Slide }
  | { id: string; kind: 'storyboard'; panels: Panel[]; overrides?: StoryboardOverrides };

export function newSlide(): Slide {
  return {
    id: cryptoRandomId(),
    textBoxes: [newDefaultTextBox('Text')],
    showFooter: true,
  };
}

/**
 * Migrate a v3-shaped slide (title/subtitle strings) into a v4 Slide with
 * default-positioned text boxes. Preserves ids where possible so the outliner
 * doesn't jump around after load.
 */
export function migrateSlideFromV3(raw: {
  id?: string;
  title?: string;
  subtitle?: string;
  showFooter?: boolean;
  imageDataUrl?: string | null;
  imageName?: string | null;
}): Slide {
  // v3 → v5 direct: only the title becomes a real text box. The old subtitle
  // text is intentionally dropped per Matt's v5 spec.
  return {
    id: raw.id ?? cryptoRandomId(),
    textBoxes: [newDefaultTextBox(raw.title ?? 'Text')],
    showFooter: raw.showFooter ?? true,
    imageDataUrl: raw.imageDataUrl ?? null,
    imageName: raw.imageName ?? null,
  };
}

export function newSlideItem(): DocItem {
  return { id: cryptoRandomId(), kind: 'slide', slide: newSlide() };
}

export function newStoryboardItem(panels: Panel[] = []): DocItem {
  return { id: cryptoRandomId(), kind: 'storyboard', panels, overrides: {} };
}

// Project-level settings that live in the Inspector
export type ProjectSettings = {
  projectName: string;
  pageSize: PageSize;
  panelsHorizontal: number;
  panelsVertical: number;
  panelAspectRatio: number; // width/height; auto-set from first image
  panelAspectLocked: boolean; // locked to first image until user overrides
  imageFit: ImageFit;
  marginPx: number;
  gutterHorizontalPx: number;
  gutterVerticalPx: number;
  colors: {
    canvasBg: string;
    pageBg: string;
    panelBg: string;
    fieldBg: string; // textarea background behind field text
    text: string; // footer text
    fieldText: string; // panel field text
    panelLabel: string; // panel-number + corner-note text color
    accent: string;
  };
  fonts: {
    family: string; // CSS font-family stack
    fieldSizePx: number;
    footerSizePx: number;
    panelLabelSizePx: number;
    captionBold: boolean;
    footerBold: boolean;
    panelLabelBold: boolean;
    captionItalic: boolean;
    footerItalic: boolean;
    panelLabelItalic: boolean;
  };
  labels: {
    // Global default field labels for new panels
    defaults: string[]; // e.g. ['Description', 'VO']
  };
  footer: {
    showProjectName: boolean;
    showPageNumber: boolean;
    logoDataUrl: string | null; // user-uploaded logo; when null, the default Swordfish logo is used (auto light/dark)
    logoAutoTheme: boolean; // when true, auto-pick black/white default logo based on page BG luminance
    logoScale: number; // 0.25..2 multiplier over base logo max height
  };
  panelBadges: {
    showNumber: boolean; // small panel number above the panel image (top-left)
    showCornerNote: boolean; // enables per-panel note above the panel image (top-right)
    numberPrefix: string; // e.g. "Panel " → "Panel 01"; empty = just the number
    cornerNotePrefix: string; // e.g. "Note: " prepended to each corner note
    useNumberPrefix: boolean;
    useCornerNotePrefix: boolean;
  };
  panelNumbering: 'continuous' | 'per-storyboard'; // 'continuous' = 01…N across whole doc; 'per-storyboard' resets each storyboard
  storage: {
    downscaleOnSave: boolean; // resize embedded images to maxImageLongEdgePx on .boardfish save
    maxImageLongEdgePx: number; // e.g. 2400
  };
};

export type ThemePreset = 'light' | 'dark';

export const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'System Sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", "SF Pro Text", sans-serif' },
  { label: 'Georgia (Serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Courier (Mono)', value: '"Courier New", Courier, monospace' },
  { label: 'Inter', value: 'Inter, -apple-system, sans-serif' },
];

export function themeColors(theme: ThemePreset): ProjectSettings['colors'] {
  if (theme === 'dark') {
    // Dark palette from Matt's approved Boardfish project 2026-07-05 (`Untitled Board-2.boardfish`)
    return {
      canvasBg: '#121212',
      pageBg: '#000000',
      panelBg: '#0f0f11',
      fieldBg: '#050506',
      text: '#d6d6d6',
      fieldText: '#aaaaaa',
      panelLabel: '#c8c8c8',
      accent: '#4a9eff',
    };
  }
  return {
    canvasBg: '#1a1a1a',
    pageBg: '#ffffff',
    panelBg: '#f5f5f5',
    fieldBg: '#ffffff',
    text: '#111111',
    fieldText: '#111111',
    panelLabel: '#555555',
    accent: '#4a9eff',
  };
}

export const DEFAULT_FIELD_LABELS = ['Description', 'VO'];

export function defaultSettings(): ProjectSettings {
  // Default page = Tabloid 17×11 per Matt's request
  const tabloid = PAGE_SIZES.find((p) => p.name.startsWith('Tabloid')) ?? PAGE_SIZES[0];
  return {
    projectName: 'Untitled Board',
    pageSize: tabloid,
    // Grid defaults (per Matt, top→bottom): 3, 2, 19, 21, 31
    panelsHorizontal: 3,
    panelsVertical: 2,
    panelAspectRatio: 16 / 9,
    panelAspectLocked: true,
    imageFit: 'fit',
    marginPx: 19,
    gutterHorizontalPx: 21,
    gutterVerticalPx: 31,
    colors: themeColors('light'),
    fonts: {
      family: FONT_FAMILIES[0].value, // Helvetica
      fieldSizePx: 16, // caption
      footerSizePx: 18,
      panelLabelSizePx: 10,
      captionBold: false,
      footerBold: true,
      panelLabelBold: false,
      captionItalic: false,
      footerItalic: false,
      panelLabelItalic: false,
    },
    labels: {
      defaults: [...DEFAULT_FIELD_LABELS],
    },
    footer: {
      showProjectName: true,
      showPageNumber: true,
      logoDataUrl: null,
      logoAutoTheme: true,
      logoScale: 1.5,
    },
    panelBadges: {
      showNumber: true,
      showCornerNote: true,
      numberPrefix: 'Panel ',
      cornerNotePrefix: '',
      useNumberPrefix: true, // "Panel 01" by default
      useCornerNotePrefix: false,
    },
    panelNumbering: 'continuous',
    storage: {
      downscaleOnSave: true,
      maxImageLongEdgePx: 2400,
    },
  };
}

export function newPanel(labels: string[] = DEFAULT_FIELD_LABELS): Panel {
  return {
    id: cryptoRandomId(),
    imageDataUrl: null,
    imageName: null,
    cornerNote: '',
    fields: labels.map((label) => ({
      id: cryptoRandomId(),
      label,
      value: '',
    })),
  };
}

export function cryptoRandomId(): string {
  // Fast, unique-enough id; no need for full uuid
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}
