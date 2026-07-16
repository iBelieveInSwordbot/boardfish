// Boardfish 5 — FAL credit balance pill for the Node Editor top bar.
//
// Shows current fal.ai credit balance + "1 credit = $1 USD" hint.
// Polls /api/fal/billing every 60s (proxy caches for 60s so this is cheap).
// Gracefully hides itself when the admin key isn't configured on the server.

import { useEffect, useState } from 'react';
import { fetchFalBilling, type FalBillingInfo } from '../ai/client';

const POLL_INTERVAL_MS = 60_000;

export function FalCreditsPill() {
  const [info, setInfo] = useState<FalBillingInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const r = await fetchFalBilling();
      if (cancelled) return;
      if (r && typeof r.balance === 'number') {
        setInfo(r);
        setFailed(false);
      } else {
        setFailed(true);
      }
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Server-not-configured or first-poll-failed → render nothing rather than
  // a broken pill. If it comes back on a later poll we'll show it then.
  if (failed || !info || typeof info.balance !== 'number') return null;

  const balance = info.balance;
  const currency = info.currency || 'USD';
  const perCredit = info.pricePerCredit || 1;

  // Format: always 2 decimals for USD balance.
  const balanceLabel = `${currency === 'USD' ? '$' : ''}${balance.toFixed(2)}${currency !== 'USD' ? ` ${currency}` : ''} credits`;
  const rateLabel = `1 credit = $${perCredit.toFixed(2)} ${currency}`;

  // Low-balance visual warning under $10.
  const lowBalance = balance < 10;

  return (
    <div
      className={`fal-credits-pill${lowBalance ? ' low' : ''}`}
      title={`fal.ai balance: ${balanceLabel}\n${rateLabel}\nUpdates every ~60s`}
    >
      <span className="fal-credits-brand">fal</span>
      <span className="fal-credits-balance">{balanceLabel}</span>
      <span className="fal-credits-rate">· {rateLabel}</span>
    </div>
  );
}
