// LogoLoader — animated loader used while Ronan is thinking.
//
// The Boardfish logo mark (the checkmark/comma shape from `public/favicon.svg`)
// is used as an SVG clip-mask. Two things animate inside it:
//   1) A rotating conic gradient ("thinking energy") that sweeps through
//      purple / cyan / white / purple.
//   2) A vertical shimmer bar that pans top-to-bottom continuously.
// A soft outer glow pulses in sync so the whole mark breathes.
//
// Below the mark:
//   - Indeterminate progress bar (Ronan doesn't stream tokens through the
//     current proxy shape, so a determinate bar would lie).
//   - Elapsed-seconds counter — helps the user tell "still working" from
//     "hung" during 30-100s calls.
//   - Rotating status messages that hint at what Ronan is doing.
//
// Self-contained; no runtime deps beyond React.

import { useEffect, useState } from 'react';

const THINKING_MESSAGES = [
  'Ronan is reading the script…',
  'Identifying the cast…',
  'Mapping locations…',
  'Spotting key props…',
  'Picking camera language…',
  'Choosing shot lengths…',
  'Which director\u2019s sensibility fits?',
  'Composing the frame…',
  'Wiring asset references to shots…',
  'Assembling the shot list…',
];

// Path data lifted verbatim from public/favicon.svg — the outer Boardfish mark.
// We define it once as a <path> and reuse it as a clip-mask so both the
// gradient sweep and the shimmer bar are shape-cropped.
const LOGO_PATH_D =
  'M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z';

type Props = {
  /**
   * Extra headline shown under the animation, e.g. "Ronan is reading the
   * script and thinking through the coverage…". Left null = only rotating
   * subtitle is shown.
   */
  headline?: string | null;
  /** Optional accent color override (defaults to the logo purple). */
  accent?: string;
};

export function LogoLoader({ headline, accent = '#863bff' }: Props) {
  const [tick, setTick] = useState(0); // seconds since mount
  const [msgIdx, setMsgIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Rotate status message every 4.5s so it feels like Ronan is progressing
    // through stages rather than repeating one label.
    const t = setInterval(() => {
      setMsgIdx((i) => (i + 1) % THINKING_MESSAGES.length);
    }, 4500);
    return () => clearInterval(t);
  }, []);

  const seconds = tick;

  return (
    <div className="logo-loader">
      <div className="logo-loader-mark-wrap">
        {/* Outer pulsing glow */}
        <div className="logo-loader-glow" style={{ background: accent }} />

        <svg
          className="logo-loader-mark"
          viewBox="0 0 48 46"
          width="120"
          height="115"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            {/* Clip everything to the logo silhouette. */}
            <clipPath id="logo-loader-clip">
              <path d={LOGO_PATH_D} />
            </clipPath>
            {/* Gradient used for the rotating conic-ish sweep. Real conic
                gradients aren't SVG native — we use a linear gradient
                inside a rotating <g> to fake it, which reads just as well
                at this size. */}
            <linearGradient id="logo-loader-sweep" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0" />
              <stop offset="35%" stopColor={accent} stopOpacity="0.9" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0.85" />
              <stop offset="75%" stopColor="#47bfff" stopOpacity="0.9" />
              <stop offset="100%" stopColor={accent} stopOpacity="0" />
            </linearGradient>
            {/* Shimmer bar gradient — bright white/purple stripe. */}
            <linearGradient id="logo-loader-shimmer" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="45%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="50%" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Base filled logo — faint so the sweep pops. */}
          <path d={LOGO_PATH_D} fill={accent} fillOpacity="0.28" />

          <g clipPath="url(#logo-loader-clip)">
            {/* Rotating sweep — a rectangle bigger than the logo, rotating
                around center. The clip-path crops it to the logo shape. */}
            <g className="logo-loader-sweep-spin" style={{ transformOrigin: '24px 23px' }}>
              <rect x="-40" y="-40" width="130" height="130" fill="url(#logo-loader-sweep)" />
            </g>
            {/* Shimmer bar sliding top-to-bottom. */}
            <rect
              className="logo-loader-shimmer-slide"
              x="-4"
              y="0"
              width="56"
              height="20"
              fill="url(#logo-loader-shimmer)"
            />
          </g>

          {/* Crisp outline on top so the shape reads even when the sweep is
              dim on the far side. */}
          <path
            d={LOGO_PATH_D}
            fill="none"
            stroke={accent}
            strokeOpacity="0.75"
            strokeWidth="0.6"
          />
        </svg>
      </div>

      {headline && <p className="logo-loader-headline">{headline}</p>}
      <p className="logo-loader-status">
        {THINKING_MESSAGES[msgIdx]}
      </p>

      <div className="logo-loader-bar-wrap">
        <div className="logo-loader-bar-track">
          <div className="logo-loader-bar-thumb" />
        </div>
        <span className="logo-loader-elapsed">{seconds}s</span>
      </div>
    </div>
  );
}
