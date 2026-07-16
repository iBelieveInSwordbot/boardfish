// LogoLoader — animated loader used while Ronan is thinking.
//
// Uses the "iBelieveIn swordbot" (IBIS) wordmark supplied by Matt as the
// mask. Two things animate inside the letters:
//   1) A rotating conic-ish gradient sweep in the brand cyan.
//   2) A vertical shimmer bar that pans top-to-bottom.
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

// IBIS wordmark path data (union of all 19 glyph paths from the supplied
// IBIS.svg). Original file viewBox is 0 0 1584 1224 but the actual wordmark
// occupies roughly x=449..1140, y=488..734, so we tighten the viewBox.
const IBIS_D =
  'M459.3,499.49c0-6.77,5.21-11.43,13.38-11.43c8.09,0,13.38,4.67,13.38,11.43c0,6.69-5.29,11.43-13.38,11.43 C464.51,510.92,459.3,506.18,459.3,499.49z M461.32,522.9h22.63v85.78h-22.63V522.9z M500.79,608.69V496.46h49.08c21.78,0,34.76,10.66,34.76,28c0,11.9-8.79,22.24-20.3,23.95v1.4 C579.19,550.9,590,562.1,590,576.57c0,19.68-14.85,32.12-38.81,32.12H500.79z M524.28,542.97h17.65c12.68,0,19.6-5.21,19.6-14.23 c0-8.94-6.46-14.31-17.65-14.31h-19.6V542.97z M545.2,590.72c13.53,0,20.84-5.68,20.84-16.18c0-10.27-7.54-15.71-21.39-15.71 h-20.38v31.89H545.2z M674.02,584.26c-3.42,16.18-18.2,26.29-39.2,26.29c-26.13,0-41.53-16.49-41.53-44.33 c0-27.92,15.71-45.19,41.22-45.19c25.28,0,40.21,16.1,40.21,43.32v6.92h-58.88v1.17c0.31,12.75,7.78,20.69,19.6,20.69 c8.94,0,15.09-3.19,17.5-8.87H674.02z M615.93,556.81h36.55c-0.47-11.36-7.31-18.43-17.89-18.43 C624.09,538.38,616.71,545.69,615.93,556.81z M685.72,490.16h22.63v118.53h-22.63V490.16z M721.69,499.49c0-6.77,5.21-11.43,13.38-11.43c8.09,0,13.38,4.67,13.38,11.43c0,6.69-5.29,11.43-13.38,11.43 C726.9,510.92,721.69,506.18,721.69,499.49z M723.71,522.9h22.63v85.78h-22.63V522.9z M840.64,584.26c-3.42,16.18-18.2,26.29-39.2,26.29c-26.13,0-41.53-16.49-41.53-44.33 c0-27.92,15.71-45.19,41.22-45.19c25.28,0,40.21,16.1,40.21,43.32v6.92h-58.88v1.17c0.31,12.75,7.78,20.69,19.6,20.69 c8.94,0,15.09-3.19,17.5-8.87H840.64z M782.54,556.81h36.55c-0.47-11.36-7.31-18.43-17.89-18.43 C790.71,538.38,783.32,545.69,782.54,556.81z M897.13,608.69h-25.51l-29.79-85.78h24.34l17.73,63.93h1.4l17.58-63.93h23.88L897.13,608.69z M1006.82,584.26c-3.42,16.18-18.2,26.29-39.2,26.29c-26.13,0-41.53-16.49-41.53-44.33 c0-27.92,15.71-45.19,41.22-45.19c25.28,0,40.21,16.1,40.21,43.32v6.92h-58.88v1.17c0.31,12.75,7.78,20.69,19.6,20.69 c8.94,0,15.09-3.19,17.5-8.87H1006.82z M948.73,556.81h36.55c-0.47-11.36-7.31-18.43-17.89-18.43 C956.89,538.38,949.51,545.69,948.73,556.81z M1015.88,499.49c0-6.77,5.21-11.43,13.38-11.43c8.09,0,13.38,4.67,13.38,11.43 c0,6.69-5.29,11.43-13.38,11.43C1021.09,510.92,1015.88,506.18,1015.88,499.49z M1017.9,522.9h22.63v85.78h-22.63V522.9z M1055.11,522.9h21.93v13.77h1.4c3.97-9.64,12.68-15.63,25.35-15.63c19.05,0,29.32,11.67,29.32,32.2v55.45 h-22.63V558.6c0-11.82-5.06-18.04-15.79-18.04c-10.5,0-16.96,7.39-16.96,18.67v49.46h-22.63V522.9z M472.84,703.73c1.05,8.74,9.86,14.34,22.56,14.34c11.73,0,20.02-5.68,20.02-13.82 c0-6.87-5.38-10.83-18.6-13.67l-14.04-2.99c-19.65-4.11-29.29-14.34-29.29-30.78c0-20.32,16.36-33.69,41.24-33.69 c23.76,0,40.57,13.3,41.24,32.5h-21.22c-1.05-8.52-8.96-14.19-19.87-14.19c-11.28,0-18.75,5.23-18.75,13.45 c0,6.65,5.15,10.46,17.78,13.15l13,2.76c21.67,4.56,31,13.9,31,30.63c0,21.74-16.66,35.04-43.7,35.04 c-25.7,0-42.36-12.63-43.18-32.72H472.84z M639.51,733.69h-23.16l-14.72-56.85h-1.34l-14.57,56.85h-22.86l-21.96-82.4h22.04l12.25,59.09h1.34 l14.42-59.09h20.77l14.49,59.09h1.34l12.25-59.09h21.59L639.51,733.69z M659.67,692.45c0-26.67,15.46-42.96,40.57-42.96s40.57,16.21,40.57,42.96c0,26.97-15.24,43.03-40.57,43.03 S659.67,719.42,659.67,692.45z M718.47,692.45c0-15.84-6.72-25.18-18.23-25.18c-11.58,0-18.23,9.34-18.23,25.18 c0,16.06,6.57,25.25,18.23,25.25C711.82,717.7,718.47,708.43,718.47,692.45z M748.72,651.28h21.07v13.15h1.34c2.17-8.22,10.68-14.49,21.14-14.49c2.99,0,6.65,0.37,8.52,1.05v19.8 c-1.72-0.67-6.8-1.34-10.31-1.34c-11.88,0-20.02,7.02-20.02,18.6v45.65h-21.74V651.28z M799.59,692.37c0-26.22,12.85-42.43,33.54-42.43c11.13,0,20.32,5.38,24.58,14.49h1.27v-44.6h21.74v113.85 h-21.07v-12.92h-1.34c-4.41,8.89-13.75,14.2-25.18,14.2C812.36,734.96,799.59,718.67,799.59,692.37z M821.93,692.45 c0,15.24,6.95,24.35,18.6,24.35s18.68-9.19,18.68-24.28c0-15.02-7.1-24.36-18.68-24.36S821.93,677.36,821.93,692.45z M899.84,669.21h-13.3v-17.11h13.3v-8.07c0-16.66,9.94-23.53,29.29-23.53c4.26,0,6.95,0.3,10.16,0.82v15.61 c-1.42-0.3-4.11-0.6-7.1-0.6c-7.62,0-11.06,2.99-11.06,9.71v6.05h17.48v17.11h-17.03v64.47h-21.74V669.21z M944.36,628.8c0-6.5,5-10.98,12.85-10.98c7.77,0,12.85,4.48,12.85,10.98c0,6.42-5.08,10.98-12.85,10.98 C949.37,639.78,944.36,635.22,944.36,628.8z M946.3,651.28h21.74v82.4H946.3V651.28z M1012.64,649.49c20.92,0,33.24,8.74,34.44,24.5h-20.1c-1.12-5.3-6.13-8.59-14.19-8.59 c-7.77,0-13.52,3.51-13.52,8.74c0,4.04,3.51,6.5,11.13,8.22l15.46,3.36c15.99,3.51,23.16,10.23,23.16,22.56 c0,16.44-14.72,27.19-36.31,27.19c-21.74,0-34.89-8.89-36.38-24.73h21.22c1.64,5.6,6.95,8.81,15.61,8.81 c8.44,0,14.27-3.51,14.27-8.81c0-4.04-3.14-6.5-10.38-8.07l-14.94-3.36c-15.99-3.51-23.76-11.13-23.76-23.83 C978.35,659.87,992.09,649.49,1012.64,649.49z M1057.83,619.83h21.37v44.97h1.34c3.81-9.41,12.77-15.09,24.88-15.09c17.71,0,28.24,11.13,28.24,30.93v53.04 h-21.74V685.8c0-11.43-5.3-17.33-15.17-17.33c-10.91,0-17.18,7.25-17.18,17.93v47.29h-21.74V619.83z';

// Cropped viewBox around the actual wordmark bounds (~x 449..1140, y 488..734).
// Adds small padding so strokes/shadows don't clip.
const VB_X = 440;
const VB_Y = 480;
const VB_W = 710;
const VB_H = 265;
// Sweep transform origin (center of viewBox).
const VB_CX = VB_X + VB_W / 2;
const VB_CY = VB_Y + VB_H / 2;

type Props = {
  /**
   * Extra headline shown under the animation, e.g. "Ronan is reading the
   * script and thinking through the coverage…". Left null = only rotating
   * subtitle is shown.
   */
  headline?: string | null;
  /** Optional accent color override (defaults to IBIS brand cyan). */
  accent?: string;
};

export function LogoLoader({ headline, accent = '#50c5ee' }: Props) {
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
      <div className="logo-loader-mark-wrap logo-loader-mark-wrap-wide">
        {/* Outer pulsing glow */}
        <div
          className="logo-loader-glow"
          style={{ background: accent, boxShadow: `0 0 60px 20px ${accent}` }}
        />

        <svg
          className="logo-loader-mark"
          viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`}
          width="260"
          height="97"
          xmlns="http://www.w3.org/2000/svg"
          style={{ filter: `drop-shadow(0 0 10px ${accent}55)` }}
        >
          <defs>
            {/* Clip everything to the wordmark silhouette. */}
            <clipPath id="logo-loader-clip">
              <path d={IBIS_D} />
            </clipPath>
            {/* Gradient used for the rotating conic-ish sweep. */}
            <linearGradient id="logo-loader-sweep" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0" />
              <stop offset="35%" stopColor={accent} stopOpacity="0.9" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0.9" />
              <stop offset="75%" stopColor={accent} stopOpacity="0.95" />
              <stop offset="100%" stopColor={accent} stopOpacity="0" />
            </linearGradient>
            {/* Shimmer bar gradient — bright white stripe. */}
            <linearGradient id="logo-loader-shimmer" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="45%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="50%" stopColor="#ffffff" stopOpacity="0.6" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Base filled wordmark — faint so the sweep pops. */}
          <path d={IBIS_D} fill={accent} fillOpacity="0.32" />

          <g clipPath="url(#logo-loader-clip)">
            {/* Rotating sweep — a rectangle bigger than the wordmark,
                rotating around center. The clip-path crops it to the shape. */}
            <g
              className="logo-loader-sweep-spin"
              style={{ transformOrigin: `${VB_CX}px ${VB_CY}px` }}
            >
              <rect
                x={VB_X - VB_W}
                y={VB_Y - VB_H}
                width={VB_W * 3}
                height={VB_H * 3}
                fill="url(#logo-loader-sweep)"
              />
            </g>
            {/* Shimmer bar sliding top-to-bottom across the wordmark. */}
            <rect
              className="logo-loader-shimmer-slide"
              x={VB_X - 20}
              y={VB_Y}
              width={VB_W + 40}
              height={VB_H * 0.35}
              fill="url(#logo-loader-shimmer)"
            />
          </g>

          {/* Crisp outline on top so the wordmark reads even when the sweep
              is dim on the far side. */}
          <path
            d={IBIS_D}
            fill="none"
            stroke={accent}
            strokeOpacity="0.85"
            strokeWidth="1.4"
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
