// btc-race-24h-20261118-1444: deep-dip V-reversal bot, written from scratch.
//
// Idea (from the dev window's own shape): cbBTC on 1-minute bars spends most
// of the day chopping inside a few dozen bps, so plain trend-following bleeds
// out on whipsaws (my offline tests of EMA crosses lost $60-100). The one
// repeatable edge in the dev data is the crash-and-recover shape: a sharp
// sell-off of 150+ bps off the trailing 4-hour high, followed by a small
// upward turn in the last 5 minutes. Buy that confirmed bounce with the whole
// stack, then let it run to +180 bps or trail it 80 bps off its peak, with a
// hard -120 bps stop and a 30-bar cooldown after any exit, so a stop-out never
// buys straight back into the same falling knife. One clean round trip on the
//
// Protocol: agent-fun/bars-replay/v1 via the vendored shim. Orders decided on
// bar k fill at bar k+1's open, so every signal is read off closes we have
// already seen. All math is integer (bigint) ratios in basis points, so two
// runs on the same data produce identical replies. No clock, no network, no
// files outside /bot, no randomness.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Trailing window for the "high" the dip is measured from: 240 one-minute bars.
const LOOKBACK = 240;
// Enter only when the close sits this far below the trailing high (bps).
const DIP_BPS = 150n;
// ...and the last 5 closes already turned up by at least this much (bps).
const CONFIRM_BARS = 5;
const CONFIRM_BPS = 10n;
// Take profit above the entry close (bps).
const TAKE_PROFIT_BPS = 180n;
// Trailing stop below the best close since entry (bps).
const TRAIL_BPS = 80n;
// Hard stop below the entry close (bps).
const STOP_BPS = 120n;
// Bars to wait after an exit before a new entry is allowed.
const COOLDOWN_BARS = 30;
// Max slippage vs the latest close we tolerate on a fill. The modelled cost
// is ~2 bps slip + ~10 bps impact on a full-size order, so 300 bps leaves
// ample room for a one-minute gap without ever binding in normal bars.
const MAX_SLIP_BPS = 300;

// Ratio (a - b) / b in basis points, truncated toward zero, bigint-exact.
function bpsDiff(a: bigint, b: bigint): bigint {
  return ((a - b) * 10_000n) / b;
}

interface TradeState {
  closes: bigint[];
  entryClose: bigint | null;
  peakClose: bigint | null;
  // Bars since the last exit; a fresh entry needs the dip to re-form after
  // a stop-out instead of buying straight back into the same falling knife.
  barsSinceExit: number;
}

function freshState(): TradeState {
  return { closes: [], entryClose: null, peakClose: null, barsSinceExit: COOLDOWN_BARS };
}

const trade: TradeState = freshState();

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const close = state.close(SYMBOL);
  if (close === null) return [];
  const held = state.positions.get(SYMBOL);
  const qty = held?.qty ?? 0n;

  // Record this bar's close before deciding (the decision fills next bar).
  trade.closes.push(close);
  if (trade.closes.length > LOOKBACK) trade.closes.shift();

  if (qty > 0n) {
    // We are long: maintain the peak and check the three exits.
    if (trade.peakClose === null || close > trade.peakClose) trade.peakClose = close;
    const entry = trade.entryClose ?? close;
    const gain = bpsDiff(close, entry);
    const fromPeak = trade.peakClose === null ? 0n : bpsDiff(close, trade.peakClose);
    const exit =
      gain >= TAKE_PROFIT_BPS || fromPeak <= -TRAIL_BPS || gain <= -STOP_BPS;
    if (exit) {
      trade.entryClose = null;
      trade.peakClose = null;
      trade.barsSinceExit = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
    }
    return [];
  }
  trade.barsSinceExit++;

  // Flat: look for a confirmed deep dip.
  if (trade.closes.length < LOOKBACK) return [];
  if (trade.barsSinceExit < COOLDOWN_BARS) return [];
  let high = trade.closes[0]!;
  for (const c of trade.closes) if (c > high) high = c;
  const dip = bpsDiff(close, high); // negative when below the high
  if (dip > -DIP_BPS) return [];
  const older = trade.closes[trade.closes.length - 1 - CONFIRM_BARS]!;
  const bounce = bpsDiff(close, older);
  if (bounce < CONFIRM_BPS) return [];

  // Confirmed bounce after a deep dip: go all in with the cash on hand.
  const cash = state.cash;
  if (cash <= 0n) return [];
  trade.entryClose = close;
  trade.peakClose = close;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIP_BPS }];
}

await runBars({ onBatch });
