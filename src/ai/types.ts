// Shot list schema returned by the AI proxy (mirrors the JSON Ronan produces).

export type Shot = {
  shotNumber: number;
  slug: string;
  action: string;
  shotType?: string;
  cameraMove?: string;
  angle?: string;
  aspectRatio?: string;
  imagePrompt: string;
  directorNote?: string;
};

export type ShotList = {
  title: string;
  directorNotes: string;
  shots: Shot[];
};

export type ShotListResponse = {
  ok: true;
  sessionId: string | null;
  shotList: ShotList;
};

export type ImageGenResponse = {
  ok: true;
  dataUrl: string;
  width: number;
  height: number;
  mime: string;
};
