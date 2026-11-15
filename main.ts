// Fast dip-buyer for cbBTC 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea: buy a sharp pullback once it shows a bounce, then take a quick
// profit. A full-size round trip pays about 43 bps (4 bps fee each way,
// 2 bps slippage each way, ~16 bps of pool impact each way at the depth
// this window trades at), so every trade must catch a move well above
// that. The bot therefore waits for a deep dip, confirms the turn with a
// small recovery off the dip low, and exits on a modest take-profit or a
// wide stop-loss so a falling knife does not cut it.
//
//   arm    : close falls DIP_BPS below the rolling LOOKBACK-bar high
//   buy    : close recovers REC_BPS above the lowest close since arming
//   sell   : close rises TP_BPS above the fill, falls SL_BPS below it,
//            or the position is MAX_HOLD bars old
//   sizing : 100% of cash on a buy, the whole position on a sell
//
// Long only, at most one open position, fully deterministic: every
// decision comes from the bars the harness sends, never the clock, the
// environment or randomness. All price comparisons are exact bigint
// arithmetic (close * 10000 against high * (10000 - bps)).

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 240;
const DIP_BPS = 250n;
const REC_BPS = 20n;
const TP_BPS = 60n;
const SL_BPS = 400n;
const MAX_HOLD = 720;
const MAX_SLIP_BPS = 300;
const BPS = 10000n;

// Closes of the bars seen so far, oldest first. The rolling high is
// taken over the LOOKBACK closes before the bar being answered.
const closes: bigint[] = [];
let armed = false;
let dipLow = 0n;
let entryPrice = 0n;
let entrySeq = -1;

function rollingHigh(): bigint | null {
  const n = closes.length;
  if (n < LOOKBACK) return null;
  let hi = closes[n - LOOKBACK];
  for (let j = n - LOOKBACK + 1; j < n; j++) {
    if (closes[j] > hi) hi = closes[j];
  }
  return hi;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);

    // Record the fill price of any buy that just landed (and clear it on
    // a sell), so take-profit and stop-loss measure from the true entry.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.symbol !== SYMBOL) continue;
      if (f.side === 'buy') {
        entryPrice = BigInt(f.price);
        entrySeq = batch.seq;
      } else {
        entryPrice = 0n;
        entrySeq = -1;
      }
    }

    if (state.warmingUp) {
      closes.push(close);
      return [];
    }

    const hi = rollingHigh();
    closes.push(close);

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    if (!holding) {
      if (!armed) {
        if (hi !== null && close * BPS <= hi * (BPS - DIP_BPS)) {
          armed = true;
          dipLow = close;
        }
      } else {
        if (close < dipLow) dipLow = close;
        if (close * BPS >= dipLow * (BPS + REC_BPS)) {
          armed = false;
          const cash = state.cash;
          if (cash >= 1000000n) {
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIP_BPS }];
          }
        } else if (hi !== null && close * BPS >= hi * (BPS - DIP_BPS)) {
          // Price drifted back near the high without confirming a bounce;
          // the dip is over, stand down until the next one.
          armed = false;
        }
      }
      return [];
    }

    // Holding a position: exit on take-profit, stop-loss or age.
    if (entryPrice === 0n) entryPrice = close;
    if (
      close * BPS >= entryPrice * (BPS + TP_BPS) ||
      close * BPS <= entryPrice * (BPS - SL_BPS) ||
      batch.seq - entrySeq >= MAX_HOLD
    ) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos!.qty, max_slippage_bps: MAX_SLIP_BPS }];
    }
    return [];
  },
});
