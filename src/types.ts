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
};

// Project-level settings that live in the Inspector (Page tab)
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
    text: string;
    accent: string;
  };
  labels: {
    // Global default field labels for new panels
    defaults: string[]; // e.g. ['Description', 'VO']
  };
  footer: {
    showProjectName: boolean;
    showPageNumber: boolean;
    logoDataUrl: string | null;
  };
};

export const DEFAULT_FIELD_LABELS = ['Description', 'VO'];

export function defaultSettings(): ProjectSettings {
  return {
    projectName: 'Untitled Board',
    pageSize: PAGE_SIZES[0],
    panelsHorizontal: 3,
    panelsVertical: 2,
    panelAspectRatio: 16 / 9,
    panelAspectLocked: true,
    imageFit: 'fit',
    marginPx: 40,
    gutterHorizontalPx: 20,
    gutterVerticalPx: 20,
    colors: {
      canvasBg: '#1a1a1a',
      pageBg: '#ffffff',
      panelBg: '#f5f5f5',
      text: '#111111',
      accent: '#4a9eff',
    },
    labels: {
      defaults: [...DEFAULT_FIELD_LABELS],
    },
    footer: {
      showProjectName: true,
      showPageNumber: true,
      logoDataUrl: null,
    },
  };
}

export function newPanel(labels: string[] = DEFAULT_FIELD_LABELS): Panel {
  return {
    id: cryptoRandomId(),
    imageDataUrl: null,
    imageName: null,
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
