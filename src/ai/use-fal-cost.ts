// Boardfish 5 — hook for estimating the cost of a Generate click.
//
// Fetches per-endpoint pricing from the local ai-proxy (cached 1h) and
// multiplies by the node's quantity input (num_images for image gen,
// duration for video where the unit is `seconds`). Falls back to a
// static "unit price" hint when the exact quantity can't be resolved
// (e.g. token-priced endpoints where we don't know the input token
// count until after generation).
//
// Returns null while loading / on error so callers can hide the hint.

import { useEffect, useState } from 'react';
import { fetchFalPrice, type FalPriceInfo } from './client';

export type FalCostEstimate = {
  /** Rounded to two decimals for display. */
  amount: number | null;
  /** true when we could resolve amount from a real quantity, false when
   *  it's a per-unit hint only. Callers can pick a different label. */
  isTotal: boolean;
  /** The raw price info for tooltips or debug. */
  price: FalPriceInfo | null;
};

const EMPTY: FalCostEstimate = { amount: null, isTotal: false, price: null };

/**
 * Look up pricing for `endpointId` and combine with a quantity to
 * produce a total cost estimate.
 *
 * Quantity conventions:
 * - Pass `{ images: N }` for image endpoints priced by "images". N is the
 *   TOTAL number of images that will be billed (variants across all
 *   chunked jobs). fal charges the SUM of `num_images` regardless of
 *   how many parallel jobs the executor fires.
 * - Pass `{ seconds: N, variants: M }` for video endpoints priced by
 *   "seconds". Each variant is a separate billed job, so total cost is
 *   `unit_price * seconds * variants`.
 * - Pass `{ resolutionMultiplier: X }` when the endpoint's unit_price is a
 *   baseline that scales with output resolution (Nano Banana Pro at 1K vs
 *   2K vs 4K). The caller resolves the multiplier from the model's
 *   `resolutionCostMultiplier` map + the node's selected resolution. When
 *   omitted, defaults to 1.
 * - If neither matches the returned unit, fall back to showing the
 *   unit_price as an unmultiplied hint (e.g. token-priced Seedance).
 */
export function useFalCostEstimate(
  endpointId: string | null | undefined,
  quantity: { images?: number; seconds?: number; variants?: number; resolutionMultiplier?: number },
): FalCostEstimate {
  const [price, setPrice] = useState<FalPriceInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // CRITICAL: clear stale price immediately when endpointId changes,
    // otherwise the render before the fetch resolves multiplies new
    // quantity by old price’s unit → wrong number flashes on-screen.
    // Returning EMPTY briefly is better than showing a stale total.
    setPrice(null);
    setFailed(false);
    if (!endpointId) return;
    (async () => {
      const p = await fetchFalPrice(endpointId);
      if (cancelled) return;
      if (p) { setPrice(p); setFailed(false); }
      else { setFailed(true); }
    })();
    return () => { cancelled = true; };
  }, [endpointId]);

  if (!endpointId || failed || !price) return EMPTY;
  // Guard: if the fetched price is for a different endpoint than the
  // one we’re currently asked about (e.g. rapid model switching), don't
  // compute an estimate off it. The effect above will re-fetch on the
  // new id; we'll get a correct number the next render.
  if (price.endpointId !== endpointId) return EMPTY;

  const unit = (price.unit || '').toLowerCase();
  const unitPrice = price.unitPrice || 0;
  const images = quantity.images ?? null;
  const seconds = quantity.seconds ?? null;
  const variants = Math.max(1, quantity.variants ?? 1);
  const resMul = quantity.resolutionMultiplier ?? 1;

  // Exact totals when unit matches the quantity we can measure ahead of time.
  if (unit === 'images' && images != null && images > 0) {
    // For images, the `images` count is already the total across all
    // variants — fal bills sum(num_images) across chunked jobs.
    // resMul lets image models with tiered resolution pricing (Nano Banana
    // Pro: 1K/2K/4K) scale the base unit_price by the selected resolution.
    return { amount: unitPrice * images * resMul, isTotal: true, price };
  }
  if (unit === 'seconds' && seconds != null && seconds > 0) {
    // For video, each variant is a separate billed job.
    return { amount: unitPrice * seconds * variants, isTotal: true, price };
  }
  // "1m tokens" and "compute seconds" can't be estimated pre-flight.
  // Multiply the unit-price hint by variants so users at least see the
  // rough per-job cost scaled by how many jobs will fire.
  return { amount: unitPrice * variants, isTotal: false, price };
}
