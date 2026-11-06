'use strict';

/**
 * Tactician: one move of lookahead.
 *
 * For each raise it asks "if I bid this, will the next player call, and if
 * they do, is my bid true?" The next player's hand comes from the opponent
 * model, and how readily they call is learned from earlier rounds. Bids the
 * next player is unlikely to challenge become attractive even when false,
 * which is where bluffing comes from.
 */

const engine = require('../../engine');
const prob = require('../prob');
const { Beliefs, bidderBelief } = require('../beliefs');

const PRIOR_CALL_THRESHOLD = 0.3;
const PRIOR_WEIGHT = 3;
const CALL_SHARPNESS = 12;

/**
 * Learn each opponent's call threshold: the bid probability (from their seat)
 * below which they tend to call liar.
 */
function estimateCallThresholds(view) {
  const acc = {};
  const rounds = view.turns;
  for (let r = 0; r < rounds.length - 1; r++) {
    const turns = rounds[r];
    const reveal = turns[turns.length - 1];
    if (!reveal || !reveal.dice) continue;
    const roundInfo = view.rounds && view.rounds[r];
    const wilds = view.config.wilds && !(roundInfo && roundInfo.palifico);
    const total = Object.values(reveal.dice).reduce((s, d) => s + d.length, 0);
    let prev = null;
    for (const t of turns) {
      const hand = reveal.dice[t.displayName];
      if (prev && hand && t.displayName !== view.me) {
        const counts = [0, 0, 0, 0, 0, 0, 0];
        for (const d of hand) counts[d]++;
        const p = bidderBelief(counts, hand.length, total, prev, wilds);
        const a = (acc[t.displayName] = acc[t.displayName] || { call: [], raise: [] });
        (t.action === 'Raise' ? a.raise : a.call).push(p);
      }
      if (t.action === 'Raise') prev = t;
    }
  }
  const out = {};
  for (const name of Object.keys(view.players)) {
    const a = acc[name] || { call: [], raise: [] };
    // Calls happen when the bid looks unlikely, raises when it looks likely.
    const meanCall = (PRIOR_CALL_THRESHOLD * 0.5 * PRIOR_WEIGHT + sum(a.call)) / (PRIOR_WEIGHT + a.call.length);
    const meanRaise = ((PRIOR_CALL_THRESHOLD * 1.5) * PRIOR_WEIGHT + sum(a.raise)) / (PRIOR_WEIGHT + a.raise.length);
    out[name] = Math.max(0.05, Math.min(0.7, (meanCall + meanRaise) / 2));
  }
  return out;
}

function sum(xs) {
  return xs.reduce((s, x) => s + x, 0);
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Raises worth evaluating: every face, from the minimum up to a few steps. */
function candidates(ctx, beliefs) {
  const out = [];
  for (let value = 1; value <= 6; value++) {
    const min = engine.minLegalCount(ctx, value);
    if (min === null) continue;
    for (let count = min; count <= ctx.totalDice; count++) {
      const p = beliefs.pTrue({ count, value });
      out.push({ type: 'raise', count, value });
      if (p < 0.15 || (count >= min + 4 && p < 0.9)) break;
    }
  }
  return out;
}

function contextAfter(view, ctx, bid, diceCount) {
  const turns = view.turns[view.turns.length - 1] || [];
  const first = turns.find((t) => t.action === 'Raise');
  return engine.makeContext({
    prevBid: bid,
    totalDice: ctx.totalDice,
    wilds: view.config.wilds,
    palifico: view.palifico,
    openingValue: first ? first.value : bid.value,
    myDiceCount: diceCount,
    spotOn: ctx.spotOn,
  });
}

/** Cheapest raise on each face over `ctx.prevBid`. */
function minRaises(ctx) {
  const out = [];
  for (let value = 1; value <= 6; value++) {
    const count = engine.minLegalCount(ctx, value);
    if (count !== null) out.push({ count, value });
  }
  return out;
}

/**
 * Two-player only: if the opponent (holding `counts`) raises over my bid,
 * predict their raise and return my expected loss when I answer it.
 */
function continuationLoss(bid, counts, opp, view, ctx, beliefs, opts) {
  const theirCtx = contextAfter(view, ctx, bid, opp.n);
  let counter = null;
  let counterP = -1;
  for (const r of minRaises(theirCtx)) {
    const p = bidderBelief(counts, opp.n, ctx.totalDice, r, beliefs.wilds);
    if (p > counterP) { counter = r; counterP = p; }
  }
  if (!counter) return 0; // they can't raise, they must call
  // I won't know their hand when I answer, so judge with my current beliefs.
  let loss = beliefs.pTrue(counter); // calling liar on their counter
  const myCtx = contextAfter(view, ctx, counter, view.players[view.me].numRemainingDice);
  for (const r of minRaises(myCtx)) {
    loss = Math.min(loss, opts.reraiseRisk * (1 - beliefs.pTrue(r)));
  }
  return loss;
}

function evaluateRaise(bid, ctx, beliefs, view, thresholds, opts) {
  const nextName = view.order[1];
  const opp = beliefs.opponents.find((o) => o.name === nextName);
  const mine = beliefs.myMatches(bid.value);
  const alive = view.order.length;
  const rest = beliefs.othersPmf(bid.value, nextName);
  const threshold = thresholds[nextName] + opts.thresholdShift;

  const scoreHand = (counts, weight) => {
    const theirs = prob.matchesFromCounts(counts, bid.value, beliefs.wilds);
    const pFalse = 1 - prob.tailOfPmf(rest, bid.count - mine - theirs);
    const theirView = bidderBelief(counts, opp.n, ctx.totalDice, bid, beliefs.wilds);
    const call = sigmoid(CALL_SHARPNESS * (threshold - theirView));
    // Risk I carry if the next player raises instead of calling.
    const cont = alive === 2
      ? continuationLoss(bid, counts, opp, view, ctx, beliefs, opts)
      : opts.contN / alive;
    return weight * (call * pFalse + (1 - call) * cont);
  };

  let loss = 0;
  if (opp.hands) {
    for (let i = 0; i < opp.hands.length; i++) {
      if (opp.weights[i] > 1e-6) loss += scoreHand(opp.hands[i].counts, opp.weights[i]);
    }
  } else {
    const fallback = beliefs.pTrue(bid);
    loss = 0.6 * (1 - fallback) + 0.4 * (opts.contN / alive);
  }
  return loss;
}

const DEFAULTS = { contN: 1.2, reraiseRisk: 0.7, thresholdShift: 0, temperature: 0.01 };

function decide(view, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const rng = opts.rng || Math.random;
  const beliefs = new Beliefs(view);
  const thresholds = estimateCallThresholds(view);
  const ctx = engine.contextFromView(view);
  const choices = [];

  if (ctx.prevBid) {
    choices.push({ action: { type: 'liar' }, loss: beliefs.pTrue(ctx.prevBid) });
    if (ctx.spotOn) {
      const pe = beliefs.pExact(ctx.prevBid);
      const canGain = view.players[view.me].numRemainingDice < view.config.numDice;
      choices.push({ action: { type: 'exact' }, loss: 1 - pe - (canGain ? 0.5 * pe : 0) });
    }
  }
  for (const bid of candidates(ctx, beliefs)) {
    choices.push({ action: bid, loss: evaluateRaise(bid, ctx, beliefs, view, thresholds, opts) });
  }

  // Mostly greedy; a little randomness among near-equal options so the bot
  // can't be read perfectly.
  const best = Math.min(...choices.map((o) => o.loss));
  const near = choices.filter((o) => o.loss <= best + opts.temperature);
  return near[Math.floor(rng() * near.length)].action;
}

module.exports = {
  description: 'Looks one move ahead: predicts whether the next player will call each raise',
  create(options = {}) {
    const rng = engine.makeRng(options.seed || engine.randomSeed());
    return { decide: (view) => decide(view, Object.assign({ rng }, options)) };
  },
  estimateCallThresholds,
};
