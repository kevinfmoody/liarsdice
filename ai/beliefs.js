'use strict';

/**
 * Opponent modeling.
 *
 * For every opponent we hold a probability for each possible hand. We start
 * from the uniform prior and reweight by how likely that hand would have
 * produced the bids the opponent made this round.
 *
 * The bid model: when a player bids, they pick a face. Each face f has a
 * "natural" bid (the count they'd need to bid on f), and from their seat that
 * bid has some chance s_f of being true. They pick faces with probability
 * proportional to exp(beta * s_f), plus a small chance of a pure bluff.
 * beta is how strongly a player's bids follow their dice. It's fitted to
 * each opponent from earlier rounds, where all dice were revealed.
 */

const engine = require('../engine');
const prob = require('./prob');

const BLUFF_RATE = 0.08;
const BETAS = [0, 1, 2, 4, 8, 16, 32, 64];
const DEFAULT_BETA = 16;
const MAX_MODELED_DICE = 10;

function countDice(dice, value, wilds) {
  let n = 0;
  for (const d of dice) if (d === value || (wilds && d === 1 && value !== 1)) n++;
  return n;
}

function countsOf(dice) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d]++;
  return counts;
}

/** P(bid true) from the bidder's seat: they know `counts`, the rest is unseen. */
function bidderBelief(counts, n, total, bid, wilds) {
  const need = bid.count - prob.matchesFromCounts(counts, bid.value, wilds);
  return prob.binomTail(total - n, need, prob.faceProb(bid.value, wilds));
}

/**
 * Walk a round's turns and describe each raise as a choice between faces:
 * [{ displayName, value, n, reps: [null | bid for face 1..6] }].
 */
/**
 * Describe one raise as a choice between faces: for each face, the bid the
 * player would have made on it instead. `ctx` is the context they faced.
 */
function describeChoice(ctx, raise, n) {
  const reps = [null];
  for (let f = 1; f <= 6; f++) {
    if (f === raise.value) {
      reps.push({ count: raise.count, value: f });
      continue;
    }
    let count;
    if (!ctx.prevBid) {
      // Openings: the same boldness on another face.
      count = engine.isRaiseValid(ctx, { count: raise.count, value: f }) ? raise.count : null;
    } else {
      count = engine.isRaiseValid(ctx, { count: raise.count, value: f }) ? raise.count : engine.minLegalCount(ctx, f);
    }
    reps.push(count === null ? null : { count, value: f });
  }
  return { value: raise.value, n, reps, total: ctx.totalDice, wilds: ctx.wilds };
}

/** Every raise in a round, described as a choice between faces. */
function describeRaises(turns, { total, wilds, palifico, diceCounts, spotOn }) {
  const out = [];
  let prev = null;
  let opening = null;
  for (const t of turns) {
    if (t.action !== 'Raise') continue;
    const n = diceCounts[t.displayName];
    const ctx = engine.makeContext({
      prevBid: prev, totalDice: total, wilds, palifico,
      openingValue: opening, myDiceCount: n, spotOn,
    });
    out.push(Object.assign({ displayName: t.displayName }, describeChoice(ctx, t, n)));
    if (!opening) opening = t.value;
    prev = { count: t.count, value: t.value };
  }
  return out;
}

/** P(they chose this face | hand counts, beta). */
function choiceLikelihood(raise, counts, beta) {
  let num = 0;
  let den = 0;
  let options = 0;
  for (let f = 1; f <= 6; f++) {
    const rep = raise.reps[f];
    if (!rep) continue;
    options++;
    const w = Math.exp(beta * bidderBelief(counts, raise.n, raise.total, rep, raise.wilds));
    den += w;
    if (f === raise.value) num = w;
  }
  return BLUFF_RATE / options + (1 - BLUFF_RATE) * (num / den);
}

/** Fit beta for each opponent from rounds where the dice were revealed. */
function estimateBetas(view) {
  const logL = {};
  const rounds = view.turns;
  for (let r = 0; r < rounds.length - 1; r++) {
    const turns = rounds[r];
    const reveal = turns[turns.length - 1];
    if (!reveal || !reveal.dice) continue;
    const roundInfo = view.rounds && view.rounds[r];
    const palifico = !!(roundInfo && roundInfo.palifico);
    const diceCounts = {};
    for (const [name, d] of Object.entries(reveal.dice)) diceCounts[name] = d.length;
    const total = Object.values(diceCounts).reduce((s, x) => s + x, 0);
    const raises = describeRaises(turns, {
      total, wilds: view.config.wilds && !palifico, palifico, diceCounts, spotOn: view.config.spotOn,
    });
    for (const raise of raises) {
      if (raise.displayName === view.me || !reveal.dice[raise.displayName]) continue;
      const counts = countsOf(reveal.dice[raise.displayName]);
      const ll = (logL[raise.displayName] = logL[raise.displayName] || BETAS.map(() => 0));
      BETAS.forEach((b, i) => (ll[i] += Math.log(choiceLikelihood(raise, counts, b))));
    }
  }
  const betas = {};
  for (const name of Object.keys(view.players)) {
    const ll = logL[name];
    if (!ll) {
      betas[name] = DEFAULT_BETA;
      continue;
    }
    // Penalized fit: a soft pull toward the default while data is scarce.
    let best = 0;
    let bestScore = -Infinity;
    BETAS.forEach((b, i) => {
      const prior = -0.5 * Math.pow(Math.log2(b + 1) - Math.log2(DEFAULT_BETA + 1), 2);
      if (ll[i] + prior > bestScore) { bestScore = ll[i] + prior; best = b; }
    });
    betas[name] = best;
  }
  return betas;
}

class Beliefs {
  constructor(view, { betas, model = true } = {}) {
    this.view = view;
    this.me = view.me;
    this.myDice = view.players[view.me].dice || [];
    this.wilds = view.config.wilds && !view.palifico;
    this.total = view.totalDice;
    this.betas = model ? betas || estimateBetas(view) : {};
    this.cache = new Map();
    const turns = view.turns[view.turns.length - 1] || [];
    const diceCounts = {};
    for (const name of view.order) diceCounts[name] = view.players[name].numRemainingDice;
    const raises = model
      ? describeRaises(turns, {
        total: this.total, wilds: this.wilds, palifico: view.palifico, diceCounts, spotOn: view.config.spotOn,
      })
      : [];
    this.opponents = view.order
      .filter((name) => name !== view.me)
      .map((name) => this._modelOpponent(name, diceCounts[name], raises.filter((r) => r.displayName === name)));
  }

  _modelOpponent(name, n, raises) {
    if (n > MAX_MODELED_DICE) return { name, n, hands: null, weights: null };
    const hands = prob.allHands(n);
    const beta = this.betas[name];
    const weights = new Float64Array(hands.length);
    let sum = 0;
    for (let i = 0; i < hands.length; i++) {
      let w = hands[i].prior;
      for (const raise of raises) w *= choiceLikelihood(raise, hands[i].counts, beta);
      weights[i] = w;
      sum += w;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    return { name, n, hands, weights };
  }

  myMatches(value) {
    return countDice(this.myDice, value, this.wilds);
  }

  /** Distribution of one opponent's matches for `value`. */
  opponentPmf(opp, value) {
    if (!opp.hands) return prob.binomPmf(opp.n, prob.faceProb(value, this.wilds));
    const pmf = new Array(opp.n + 1).fill(0);
    for (let i = 0; i < opp.hands.length; i++) {
      pmf[prob.matchesFromCounts(opp.hands[i].counts, value, this.wilds)] += opp.weights[i];
    }
    return pmf;
  }

  /** Distribution of all opponents' matches for `value`, optionally leaving one out. */
  othersPmf(value, exclude = null) {
    const key = value + ':' + exclude;
    let pmf = this.cache.get(key);
    if (pmf) return pmf;
    pmf = [1];
    for (const opp of this.opponents) {
      if (opp.name !== exclude) pmf = prob.convolve(pmf, this.opponentPmf(opp, value));
    }
    this.cache.set(key, pmf);
    return pmf;
  }

  /** P(bid is true) given my dice and beliefs about everyone else. */
  pTrue(bid) {
    return prob.tailOfPmf(this.othersPmf(bid.value), bid.count - this.myMatches(bid.value));
  }

  pExact(bid) {
    return prob.pmfAt(this.othersPmf(bid.value), bid.count - this.myMatches(bid.value));
  }

  /** Draw a full set of opponent hands from the beliefs. */
  sampleHands(rng) {
    const out = {};
    for (const opp of this.opponents) {
      if (!opp.hands) {
        const dice = [];
        for (let i = 0; i < opp.n; i++) dice.push(1 + Math.floor(rng() * 6));
        out[opp.name] = dice.sort((a, b) => a - b);
        continue;
      }
      let r = rng();
      let i = 0;
      for (; i < opp.weights.length - 1; i++) {
        r -= opp.weights[i];
        if (r <= 0) break;
      }
      out[opp.name] = opp.hands[i].dice.slice();
    }
    return out;
  }
}

/** Beliefs with no opponent modeling: every unseen die is uniform. */
function uniformBeliefs(view) {
  return new Beliefs(view, { model: false });
}

module.exports = {
  Beliefs, uniformBeliefs, estimateBetas, bidderBelief, countDice, countsOf,
  describeChoice, choiceLikelihood, DEFAULT_BETA,
};
