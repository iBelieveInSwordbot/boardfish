// Boardfish 5 — Generate button with inline FAL cost hint.
//
// Renders the ne-inspect-generate button plus a "(≈ $X.XX)" tag pulled
// from the local ai-proxy's /api/fal/price. Extracted from the node
// Inspectors so both Image Gen and Movie Gen use the same look.
//
// The hint is best-effort: while pricing is loading, the button label
// is just "Generate"; on token-priced endpoints we can only show the
// unit price (no reliable pre-flight quantity) so the hint shows a
// generic price marker instead.

import { useFalCostEstimate } from '../ai/use-fal-cost';

export type GenerateButtonWithCostProps = {
  /** FAL endpoint id, e.g. "fal-ai/nano-banana-pro". Null while unknown. */
  endpointId: string | null;
  /** Quantity signals — pass whichever matches the endpoint's unit.
   *  For video: `variants` multiplies the per-job cost since fal fires
   *  N separate jobs. For images, `images` is already the total across
   *  chunked jobs so no `variants` needed.
   *  For image models with tiered resolution pricing (Nano Banana Pro:
   *  1K/2K/4K), pass `resolutionMultiplier` derived from the model's
   *  resolutionCostMultiplier map × the node's selected resolution. */
  quantity: { images?: number; seconds?: number; variants?: number; resolutionMultiplier?: number };
  /** Disables the button (e.g. mid-generation). */
  disabled: boolean;
  /** Label shown while a run is in flight. */
  busyLabel: string;
  /** Whether inFlight state should be used for busy label. */
  inFlight: boolean;
  onClick: () => void;
};

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function GenerateButtonWithCost({
  endpointId,
  quantity,
  disabled,
  busyLabel,
  inFlight,
  onClick,
}: GenerateButtonWithCostProps) {
  const est = useFalCostEstimate(endpointId, quantity);

  let costHint = '';
  if (inFlight) {
    costHint = '';
  } else if (est.amount != null) {
    costHint = ` (${formatCost(est.amount)})`;
  } else if (endpointId) {
    // Pricing is loading or just invalidated by a model switch. Show a
    // tiny placeholder so the user sees that a fresh number is coming,
    // rather than a blank "Generate" that could be misread as free.
    costHint = ' (…)';
  }

  return (
    <button
      type="button"
      className="ne-inspect-generate"
      disabled={disabled}
      onClick={onClick}
      title={
        est.price
          ? `Estimated: ${est.isTotal ? '' : 'unit '}price ${formatCost(est.price.unitPrice)} / ${est.price.unit}`
          : undefined
      }
    >
      {inFlight ? busyLabel : `Generate${costHint}`}
    </button>
  );
}
