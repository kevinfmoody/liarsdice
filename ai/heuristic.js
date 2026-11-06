'use strict';

/**
 * One-step decision rule shared by the simpler bots.
 *
 * Given a way to estimate P(bid is true), it compares:
 *   - calling liar: I lose a die if the current bid is true
 *   - raising:      I lose a die if I'm challenged and my bid is false
 *   - exact:        I lose a die unless the count is exactly right
 * and picks the action with the lowest expected loss.
 */

const engine = require('../engine');

const DEFAULTS = {
  challengeRate: 0.7, // how often a raise is assumed to get challenged
  openThreshold: 0.65, // opening bids must be at least this likely
  exactGain: 0.5, // value of regaining a die, in "dice lost" units
};

/** The two cheapest raises on each face: the main candidates. */
function candidateRaises(ctx, extra = 1) {
  const out = [];
  for (let value = 1; value <= 6; value++) {
    const min = engine.minLegalCount(ctx, value);
    if (min === null) continue;
    for (let c = min; c <= Math.min(ctx.totalDice, min + extra); c++) {
      out.push({ type: 'raise', count: c, value });
    }
  }
  return out;
}

function openingBid(ctx, pTrue, threshold) {
  let best = null;
  for (let value = 1; value <= 6; value++) {
    if (!engine.isRaiseValid(ctx, { count: 1, value })) continue;
    for (let count = ctx.totalDice; count >= 1; count--) {
      const p = pTrue({ count, value });
      if (p >= threshold || count === 1) {
        // Prefer the biggest count that's still safe, then the safest.
        if (!best || count > best.count || (count === best.count && p > best.p)) {
          best = { type: 'raise', count, value, p };
        }
        break;
      }
    }
  }
  return { type: 'raise', count: best.count, value: best.value };
}

/**
 * @param view    player view (engine.viewFor)
 * @param pTrue   bid => probability the bid is true
 * @param pExact  bid => probability the count is exact (only for spotOn)
 */
function decide(view, pTrue, pExact, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const ctx = engine.contextFromView(view);
  if (!ctx.prevBid) return openingBid(ctx, pTrue, opts.openThreshold);

  const raises = candidateRaises(ctx);
  let best = { type: 'liar', loss: pTrue(ctx.prevBid) };
  for (const r of raises) {
    const loss = (1 - pTrue(r)) * opts.challengeRate;
    if (loss < best.loss) best = Object.assign({ loss }, r);
  }
  if (ctx.spotOn && pExact) {
    const pe = pExact(ctx.prevBid);
    const canGain = view.players[view.me].numRemainingDice < view.config.numDice;
    const loss = 1 - pe - (canGain ? opts.exactGain * pe : 0);
    if (loss < best.loss) best = { type: 'exact', loss };
  }
  delete best.loss;
  return best;
}

module.exports = { decide, candidateRaises, DEFAULTS };
