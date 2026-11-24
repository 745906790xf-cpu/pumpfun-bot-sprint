// Second-wind pullback rider for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: nearly every new pump.fun coin dumps, but the rare runners show a shape
// before the big move — the coin survives its first minutes, the creator has not
// sold, and a crowd of distinct wallets keeps buying while the price grinds up
// near its recent high. This bot buys that shape once per coin and then lets the
// winner run: a far take-profit, a hard stop, and a trailing stop that only arms
// after a real gain. A stale exit frees a position slot that never did anything.
//
// The wire is the kit's shim (vendor/makefun-bot.ts): stdin carries one JSON
// line per message — a "hello" first, then one "batch" per slot with the slot's
// events, marks and fills — and the bot answers each batch with one "reply"
// line carrying its "orders". The shim keeps the account, positions, curves and
// pending orders current; this file only decides.
//
// Determinism: all price math is exact bigint cross-multiplication (no floats,
// no clock, no randomness, no environment). Iteration order is fixed: positions
// in mint-sorted order, entries in first-seen curve order. Two runs on the same
// data produce byte-identical action logs.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// --- strategy constants (my own picks; no dev dataset was available to tune
// against, so every number is a round, conservative choice, not a fit) ---
const STAKE_LAMPORTS = 250_000_000n; // 0.25 SOL per entry
const MAX_ENTRIES = 20; // guardrail needs 20 coins; every extra trip is drag
const ENTRY_SLIPPAGE_BPS = 150;
const SELL_SLIPPAGE_BPS = 300;
const MAX_BUY_ATTEMPTS = 5; // a rejected buy may retry while the signal holds
const MIN_AGE_SLOTS = 300; // let the first-minute chaos pass
const MAX_AGE_SLOTS = 4000; // after this the move is usually over
const MIN_TRADES = 8;
const MIN_BUYS = 6;
const MIN_NET_INFLOW = 1_000_000_000n; // >= 1 SOL net buying over the coin's life
const MIN_REAL_RESERVE = 2_000_000_000n; // >= 2 SOL of real reserve
const MAX_REAL_RESERVE = 50_000_000_000n; // <= 50 SOL: skip the already-huge
const STALE_AFTER_SLOTS = 20_000;

// Price ratios as exact fractions, compared by cross-multiplication.
const ENTRY_MIN_NUM = 6n; // entry only at >= 1.20x the creation price
const ENTRY_MIN_DEN = 5n;
const ENTRY_MAX_NUM = 9n; // ... and at most 1.80x it (never chase a vertical)
const ENTRY_MAX_DEN = 5n;
const TP_NUM = 9n; // take profit at +80% over the effective fill price
const TP_DEN = 5n;
const STOP_NUM = 13n; // hard stop at -35% under the effective fill price
const STOP_DEN = 20n;
const TRAIL_ARM_NUM = 7n; // trailing stop arms at +40% over the fill price
const TRAIL_ARM_DEN = 5n;
const TRAIL_DROP_NUM = 3n; // ... and exits on a -25% fall from the peak
const TRAIL_DROP_DEN = 4n;
const STALE_MAX_LOSS_NUM = 17n; // stale exit only when the loss is at most 15%
const STALE_MAX_LOSS_DEN = 20n;

/** A ratio a/b as bigints; compare x = a/b against y = c/d via a*d ? c*b. */
function ratioGte(a: bigint, b: bigint, c: bigint, d: bigint): boolean {
  return a * d >= c * b;
}
function ratioLte(a: bigint, b: bigint, c: bigint, d: bigint): boolean {
  return a * d <= c * b;
}

interface CoinStat {
  createdSlot: number | null;
  createQ: bigint; // creation price = createQ / createT (quote per token)
  createT: bigint;
  trades: number;
  buys: number;
  buyVol: bigint; // SOL spent on buys (sol_amount summed)
  sellVol: bigint; // SOL received on sells
  creator: string | null;
  creatorSold: boolean;
  attempts: number; // buy attempts sent (filled or rejected)
  entered: boolean; // a buy fill has landed for this coin
  entrySlot: number; // slot the buy fill resolved at
  peakQ: bigint; // peak price since entry, as peakQ / peakT
  peakT: bigint;
}

const stats = new Map<string, CoinStat>();
let entriesDone = 0;

function statFor(mint: string): CoinStat {
  let s = stats.get(mint);
  if (s === undefined) {
    s = {
      createdSlot: null,
      createQ: 0n,
      createT: 1n,
      trades: 0,
      buys: 0,
      buyVol: 0n,
      sellVol: 0n,
      creator: null,
      creatorSold: false,
      attempts: 0,
      entered: false,
      entrySlot: 0,
      peakQ: 0n,
      peakT: 1n,
    };
    stats.set(mint, s);
  }
  return s;
}

function priceOf(state: BotState, mint: string): { q: bigint; t: bigint } | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves === 0n) return null;
  return { q: c.virtual_quote_reserves, t: c.virtual_token_reserves };
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  // Fold this batch's events into the per-coin stats first.
  for (const e of batch.events) {
    const s = statFor(e.mint);
    if (e.event === 'CreateEvent') {
      s.createdSlot = e.slot;
      s.createQ = BigInt(e.virtual_quote_reserves);
      s.createT = BigInt(e.virtual_token_reserves);
      s.creator = e.creator;
    } else if (e.event === 'TradeEvent') {
      s.trades += 1;
      const vol = BigInt(e.sol_amount);
      if (e.is_buy) {
        s.buys += 1;
        s.buyVol += vol;
      } else {
        s.sellVol += vol;
        if (s.creator !== null && e.user === s.creator) s.creatorSold = true;
      }
    }
  }
  // Fold this batch's fills in: record entries, count rejected-buy attempts.
  for (const f of batch.fills) {
    const s = stats.get(f.mint);
    if (s === undefined) continue;
    if (f.side === 'buy' && f.status === 'filled') {
      s.entered = true;
      s.entrySlot = f.slot;
      const p = priceOf(state, f.mint);
      if (p !== null) {
        s.peakQ = p.q;
        s.peakT = p.t;
      }
      entriesDone += 1;
    } else if (f.side === 'buy' && f.status === 'rejected') {
      s.attempts += 1;
    }
  }

  const orders: OrderInput[] = [];
  const maxOrders = state.hello.caps.max_orders_per_batch;

  // Exits first: positions in mint-sorted order, so the reply is deterministic.
  const held = [...state.positions.keys()].sort();
  for (const mint of held) {
    if (orders.length >= maxOrders) break;
    const pos = state.positions.get(mint)!;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    // A sell already in flight for this mint: wait for its fill, never double-sell.
    if ([...state.pending.values()].some((p) => p.order.side === 'sell' && p.order.mint === mint)) continue;
    const price = priceOf(state, mint);
    if (price === null) continue;
    const s = statFor(mint);
    const tokens = pos.token_amount;
    const cost = pos.cost_lamports;
    if (tokens === 0n || cost === 0n) continue;

    // Track the peak price since entry (for the trailing stop).
    if (s.entered && ratioGte(price.q, price.t, s.peakQ, s.peakT)) {
      s.peakQ = price.q;
      s.peakT = price.t;
    }

    let exit = false;
    // Take profit: current price >= 1.80x the effective fill price.
    if (ratioGte(price.q, price.t, cost * TP_NUM, tokens * TP_DEN)) exit = true;
    // Hard stop: current price <= 0.65x the effective fill price.
    if (ratioLte(price.q, price.t, cost * STOP_NUM, tokens * STOP_DEN)) exit = true;
    // Trailing stop: armed at +40%, exits on a -25% fall from the peak.
    if (
      s.entered &&
      ratioGte(s.peakQ, s.peakT, cost * TRAIL_ARM_NUM, tokens * TRAIL_ARM_DEN) &&
      ratioLte(price.q, price.t, s.peakQ * TRAIL_DROP_NUM, s.peakT * TRAIL_DROP_DEN)
    ) {
      exit = true;
    }
    // Stale exit: open a long time, loss at most 15% — free the slot.
    if (
      s.entered &&
      state.slot - s.entrySlot > STALE_AFTER_SLOTS &&
      ratioGte(price.q, price.t, cost * STALE_MAX_LOSS_NUM, tokens * STALE_MAX_LOSS_DEN)
    ) {
      exit = true;
    }

    if (exit) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: tokens,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }
  }

  // Entries: first-seen curve order, one buy per coin, until the caps bind.
  if (entriesDone < MAX_ENTRIES && orders.length < maxOrders) {
    const txFee = state.txFeeLamports();
    for (const mint of state.curves.keys()) {
      if (orders.length >= maxOrders) break;
      if (entriesDone >= MAX_ENTRIES) break;
      const s = stats.get(mint)!;
      const curve = state.curves.get(mint)!;
      if (curve.complete) continue;
      if (s.entered || s.attempts >= MAX_BUY_ATTEMPTS) continue;
      if (state.positions.has(mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.side === 'buy' && p.order.mint === mint)) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
      if (s.createdSlot === null) continue;
      const age = state.slot - s.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (s.trades < MIN_TRADES || s.buys < MIN_BUYS) continue;
      if (s.buyVol - s.sellVol < MIN_NET_INFLOW) continue;
      if (s.creatorSold) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      if (curve.real_quote_reserves > MAX_REAL_RESERVE) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      // Price must sit in [1.20x, 1.80x] the creation price.
      if (!ratioGte(price.q, price.t, s.createQ * ENTRY_MIN_NUM, s.createT * ENTRY_MIN_DEN)) continue;
      if (!ratioLte(price.q, price.t, s.createQ * ENTRY_MAX_NUM, s.createT * ENTRY_MAX_DEN)) continue;
      // Size: 0.25 SOL, capped by the per-mint size cap and by free cash.
      let stake = STAKE_LAMPORTS;
      const cap = state.maxBuyLamports(mint);
      if (cap < stake) stake = cap;
      const free = state.freeCashLamports();
      const affordable = free - 2n * txFee; // keep the eventual sell's fee too
      if (affordable < stake) stake = affordable;
      if (stake < 10_000_000n) continue; // below the 0.01 SOL round-trip floor
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: stake,
        max_slippage_bps: ENTRY_SLIPPAGE_BPS,
      });
      s.attempts += 1;
    }
  }

  return orders;
}

await runBot({ onBatch });
