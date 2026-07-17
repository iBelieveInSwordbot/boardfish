// Boardfish 5 — kind-level metadata (no React).
//
// Split out from registry.ts so pure modules (graph-utils.ts) can read a
// node kind's default width/height without pulling in the Preview/Inspector
// components (which import React).
//
// Keep this table in sync with the `defaultWidth` / `defaultHeight` fields
// on `NODE_KINDS` in registry.ts.

import type { NodeKind } from './types';

export type NodeKindMeta = {
  defaultWidth: number;
  defaultHeight: number;
};

export const NODE_KINDS_META: Record<NodeKind, NodeKindMeta> = {
  'text-prompt':     { defaultWidth: 220, defaultHeight: 140 },
  'image-gen':       { defaultWidth: 220, defaultHeight: 180 },
  'movie-gen':       { defaultWidth: 220, defaultHeight: 160 },
  'out':             { defaultWidth: 200, defaultHeight: 160 },
  'switch':          { defaultWidth: 200, defaultHeight: 140 },
  'null-node':       { defaultWidth: 160, defaultHeight: 100 },
  'prompt-concat':   { defaultWidth: 200, defaultHeight: 140 },
  'prompt-enhancer': { defaultWidth: 220, defaultHeight: 160 },
  'llm-run':         { defaultWidth: 220, defaultHeight: 160 },
  'image-describer': { defaultWidth: 220, defaultHeight: 180 },
  'video-describer': { defaultWidth: 220, defaultHeight: 180 },
  'custom-fal':      { defaultWidth: 220, defaultHeight: 140 },
  'panel-ref':       { defaultWidth: 200, defaultHeight: 160 },
};
