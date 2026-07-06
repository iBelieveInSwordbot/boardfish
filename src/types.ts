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

export type Panel = {
  id: string;
  imageDataUrl: string | null;
  imageName: string | null;
  fields: TextField[];
  cornerNote: string; // optional per-panel text shown in the top-right corner
};

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
    // Deeper, more contrasty dark theme so panels + field BGs are clearly darker than page
    return {
      canvasBg: '#050506',
      pageBg: '#0e0e11',
      panelBg: '#161619',
      fieldBg: '#050506',
      text: '#eaeaea',
      fieldText: '#eaeaea',
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
    },
    labels: {
      defaults: [...DEFAULT_FIELD_LABELS],
    },
    footer: {
      showProjectName: true,
      showPageNumber: true,
      logoDataUrl: null,
      logoAutoTheme: true,
      logoScale: 1.3,
    },
    panelBadges: {
      showNumber: true,
      showCornerNote: true,
      numberPrefix: 'Panel ',
      cornerNotePrefix: '',
      useNumberPrefix: false,
      useCornerNotePrefix: false,
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
