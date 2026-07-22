// Fixed label vocabulary for text-prompt fields, with mapping to preset
// groups (when the label has a corresponding curated preset list).
//
// Matt's spec (2026-07-22):
//   Each text field gets a label popup — fixed rename list plus free
//   text. Each field also gets a preset popup scoped to its label
//   (e.g. Style Tags → Photorealistic / Cineon / Leica M / …). Labels
//   without a preset group show no preset picker.
//
// Kept separate from text-prompt-fields.ts so:
//   - text-prompt-fields.ts stays the authoritative PRESET_GROUPS source
//   - This module is UI-focused: label list order, defaults, mapping.

import type { PresetGroupId } from './text-prompt-fields';

export type FieldLabelPreset = {
  /** Human label shown in the popup. */
  label: string;
  /** Preset group whose options fill this field's value picker, if any. */
  presetGroup?: PresetGroupId;
};

/**
 * Fixed rename list Matt asked for on 2026-07-22. Ordered roughly:
 *  1. Camera-related labels (shot type, focal length, perspective)
 *  2. Lighting / atmosphere / color
 *  3. Composition / staging / set
 *  4. Shot description / action / decisive moment
 *  5. Style Tags (the anchor of the whole popup UX)
 */
export const FIXED_FIELD_LABELS: FieldLabelPreset[] = [
  { label: 'Camera Shot Type', presetGroup: 'shot-type' },
  { label: 'Camera Focal Length', presetGroup: 'focal-length' },
  { label: 'Camera Perspective', presetGroup: 'perspective' },
  { label: 'Lighting', presetGroup: 'lighting' },
  { label: 'Atmosphere' },
  { label: 'Color Palette' },
  { label: 'Staging & Composition' },
  { label: 'Set Design' },
  { label: 'Shot Description' },
  { label: 'Action & Performance' },
  { label: 'Decisive Moment' },
  { label: 'Style Tags', presetGroup: 'style-tags' },
];

/**
 * Look up the preset group for a given field label. Fast reverse map so
 * the field renderer can decide whether to show the "Presets ▾" button
 * regardless of whether the label came from FIXED_FIELD_LABELS or was
 * typed as free text (in which case the lookup returns undefined).
 */
export function presetGroupForLabel(label: string): PresetGroupId | undefined {
  const norm = (label ?? '').trim().toLowerCase();
  if (!norm) return undefined;
  for (const entry of FIXED_FIELD_LABELS) {
    if (entry.label.toLowerCase() === norm) return entry.presetGroup;
  }
  return undefined;
}

/**
 * Compute the next "Prompt N" label given the existing fields' labels.
 * Used by the Add Field menu so successive Text field adds land as
 * "Prompt 1", "Prompt 2", "Prompt 3" out of the box.
 */
export function nextPromptLabel(existingLabels: string[]): string {
  let n = 1;
  const taken = new Set(existingLabels.map((s) => (s ?? '').trim().toLowerCase()));
  while (taken.has(`prompt ${n}`)) n += 1;
  return `Prompt ${n}`;
}
