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
  /** Names (from the assets section) referenced by this shot. Filled by Ronan
   *  in v6 so we can wire matching Panel Ref nodes into the final storyboard
   *  Nano-Banana Pro gens without doing fuzzy text matching. */
  refs?: {
    actors?: string[];
    locations?: string[];
    props?: string[];
  };
};

/** A named asset (character, location, or prop) extracted from the script by
 *  Ronan in v6. Rendered as an asset panel with two captions (Name / Description
 *  or Prop / Description) and later used as a Panel Ref input to final
 *  storyboard gens. */
export type AssetSpec = {
  name: string;
  description: string;
};

export type ShotList = {
  title: string;
  directorNotes: string;
  shots: Shot[];
  /** Asset lists — v6 additions. Older shot-list responses omit these. */
  actors?: AssetSpec[];
  locations?: AssetSpec[];
  props?: AssetSpec[];
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
