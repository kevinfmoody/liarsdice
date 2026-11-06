'use strict';

/**
 * Strategist: Monte Carlo tree search over hidden dice.
 *
 * Each iteration:
 *   1. Sample the opponents' hands from the opponent model (so hands that
 *      fit their bids come up more often).
 *   2. Walk down a tree of MY decisions, choosing with UCB1. Opponents act
 *      with a fast policy that uses their sampled hand, so their calls depend
 *      on what they "hold" in that sample.
 *   3. Play the rest of the round out with the fast policy, and score it:
 *      -1 if I lose a die (more if it knocks me out), + if I gain one.
 * The action at the root with the most visits wins.
 */

const engine = require('../../engine');
const prob = require('../prob');
const { estimateCallThresholds } = require('./tactician');
const { Beliefs, countDice, describeChoice, choiceLikelihood, DEFAULT_BETA } = require('../beliefs');

/**
 * What anyone at the table can infer from the bids: a weight for each
 * possible hand of each player. Simulated players combine this with their
 * own (sampled) hand, so they read bids the way real opponents do.
 */
class PublicBelief {
  constructor(players, wilds) {
    this.players = players; // [{ n, hands, weights, beta }]
    this.wilds = wilds;
    this.pmfs = new Map();
  }

  withRaise(idx, choice, cache) {
    const p = this.players[idx];
    if (!p.hands) return new PublicBelief(this.players, this.wilds);
    // The same raise from the same spot recurs across playouts: cache it.
    const sig = p.n + '|' + p.beta + '|' + choice.value + '|' +
      choice.reps.map((r) => (r ? r.count * 10 + r.value : 0)).join(',');
    let like = cache.get(sig);
    if (!like) {
      like = new Float64Array(p.hands.length);
      for (let i = 0; i < like.length; i++) like[i] = choiceLikelihood(choice, p.hands[i].counts, p.beta);
      cache.set(sig, like);
    }
    const weights = new Float64Array(p.weights.length);
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      weights[i] = p.weights[i] * like[i];
      sum += weights[i];
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    const players = this.players.slice();
    players[idx] = Object.assign({}, p, { weights });
    return new PublicBelief(players, this.wilds);
  }

  pmf(idx, value) {
    const p = this.players[idx];
    if (!p.hands) return prob.binomPmf(p.n, prob.faceProb(value, this.wilds));
    const table = matchTable(p.n, this.wilds)[value];
    const out = new Array(p.n + 1).fill(0);
    for (let i = 0; i < table.length; i++) out[table[i]] += p.weights[i];
    return out;
  }

  /** Everyone's matches for `value` except player `exclude`. */
  othersPmf(exclude, value) {
    const key = exclude * 7 + value;
    let out = this.pmfs.get(key);
    if (!out) {
      out = [1];
      for (let i = 0; i < this.players.length; i++) {
        if (i !== exclude) out = prob.convolve(out, this.pmf(i, value));
      }
      this.pmfs.set(key, out);
    }
    return out;
  }
}

// matchTable(n, wilds)[value][handIndex] = matches for that hand.
const matchTables = new Map();
function matchTable(n, wilds) {
  const key = n + ':' + wilds;
  let t = matchTables.get(key);
  if (!t) {
    const hands = prob.allHands(n);
    t = [null];
    for (let v = 1; v <= 6; v++) {
      t.push(Uint8Array.from(hands.map((h) => prob.matchesFromCounts(h.counts, v, wilds))));
    }
    matchTables.set(key, t);
  }
  return t;
}

function rootPublicBelief(view, beliefs) {
  const wilds = view.config.wilds && !view.palifico;
  // My own bids, as the others read them.
  const meAsSeen = new Beliefs(Object.assign({}, view, {
    me: '__nobody__',
    order: view.order.concat('__nobody__'),
    players: Object.assign({}, view.players, { __nobody__: { numRemainingDice: 0, dice: [] } }),
  }), { betas: Object.assign({}, beliefs.betas, { [view.me]: DEFAULT_BETA }) });
  const players = view.order.map((name) => {
    const opp = (name === view.me ? meAsSeen : beliefs).opponents.find((o) => o.name === name);
    return { n: opp.n, hands: opp.hands, weights: opp.weights, beta: (beliefs.betas[name] ?? DEFAULT_BETA) };
  });
  return new PublicBelief(players, wilds);
}

const DEFAULTS = {
  modelCalls: true,
  iterations: 1500,
  exploration: 0.8,
  challengeRate: 0.7, // fast policy: assumed chance a raise gets called
  noise: 0.06, // fast policy: chance to pick a random candidate instead
  eliminationPenalty: 0.5,
};

function actionKey(a) {
  return a.type === 'raise' ? a.count * 10 + a.value : a.type === 'liar' ? -1 : -2;
}

/** Round state that's cheap to copy. */
function makeRound(view) {
  const turns = view.turns[view.turns.length - 1] || [];
  const first = turns.find((t) => t.action === 'Raise');
  return {
    order: view.order.slice(),
    dice: view.order.map((name) => view.players[name].numRemainingDice),
    bid: view.currentBid ? { count: view.currentBid.count, value: view.currentBid.value } : null,
    bidder: view.currentBid ? view.order.indexOf(view.currentBid.displayName) : -1,
    opening: first ? first.value : null,
    turn: 0, // index into order; 0 is me
  };
}

function roundContext(view, round) {
  return engine.makeContext({
    prevBid: round.bid,
    totalDice: view.totalDice,
    wilds: view.config.wilds,
    palifico: view.palifico,
    openingValue: round.opening,
    myDiceCount: round.dice[round.turn],
    spotOn: view.config.spotOn,
  });
}

/** Candidate actions: cheapest two raises per face, plus liar / exact. */
function candidates(ctx, openingHint) {
  const out = [];
  if (ctx.prevBid) {
    out.push({ type: 'liar' });
    if (ctx.spotOn) out.push({ type: 'exact' });
  }
  for (let value = 1; value <= 6; value++) {
    let min = engine.minLegalCount(ctx, value);
    if (min === null) continue;
    let span = 1;
    if (!ctx.prevBid && openingHint) {
      // Openings: a spread around what my dice suggest for this face.
      min = Math.max(min, openingHint[value] - 1);
      span = 2;
    }
    for (let c = min; c <= Math.min(ctx.totalDice, min + span); c++) {
      if (engine.isRaiseValid(ctx, { count: c, value })) out.push({ type: 'raise', count: c, value });
    }
  }
  return out;
}

/** Fast policy: one-step heuristic from the actor's own hand, a little noise. */
function fastPolicy(view, round, hand, pub, rng, opts) {
  const ctx = roundContext(view, round);
  const wilds = ctx.wilds;
  const pTrue = (b) => prob.tailOfPmf(pub.othersPmf(round.turn, b.value), b.count - countDice(hand, b.value, wilds));
  const options = candidates(ctx, null);
  if (rng() < opts.noise) return options[Math.floor(rng() * options.length)];
  if (!ctx.prevBid) {
    let best = null;
    for (let value = 1; value <= 6; value++) {
      if (!engine.isRaiseValid(ctx, { count: 1, value })) continue;
      let count = 1;
      while (count < ctx.totalDice && pTrue({ count: count + 1, value }) >= 0.6) count++;
      if (!best || count > best.count) best = { type: 'raise', count, value };
    }
    return best;
  }
  let best = { type: 'liar' };
  let bestLoss = pTrue(ctx.prevBid);
  if (round.turn !== 0 && opts.callThresholds) {
    // Opponents call at the rate they've been seen to call (learned
    // threshold, judged from their seat with the other dice unseen).
    const unseen = view.totalDice - hand.length;
    const own = prob.binomTail(unseen, ctx.prevBid.count - countDice(hand, ctx.prevBid.value, wilds),
      prob.faceProb(ctx.prevBid.value, wilds));
    const threshold = opts.callThresholds[round.order[round.turn]];
    if (rng() < 1 / (1 + Math.exp(-12 * (threshold - own)))) return best;
    bestLoss = Infinity;
  }
  for (const a of options) {
    if (a.type !== 'raise') continue;
    const loss = (1 - pTrue(a)) * opts.challengeRate;
    if (loss < bestLoss) { best = a; bestLoss = loss; }
  }
  return best;
}

/** Apply an action to the round; returns null to continue, else my reward. */
function step(view, round, action, hands, opts) {
  if (action.type === 'raise') {
    round.bid = { count: action.count, value: action.value };
    round.bidder = round.turn;
    if (!round.opening) round.opening = action.value;
    round.turn = (round.turn + 1) % round.order.length;
    return null;
  }
  const wilds = view.config.wilds && !view.palifico;
  let actual = 0;
  for (const hand of hands) actual += countDice(hand, round.bid.value, wilds);
  let loser = -1;
  let gainer = -1;
  if (action.type === 'liar') {
    loser = actual >= round.bid.count ? round.turn : round.bidder;
  } else if (actual === round.bid.count) {
    gainer = round.turn;
  } else {
    loser = round.turn;
  }
  if (loser === 0) return -1 - (round.dice[0] === 1 ? opts.eliminationPenalty : 0);
  if (gainer === 0) return round.dice[0] < view.config.numDice ? 0.5 : 0;
  return 0;
}

function search(view, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const rng = opts.rng || Math.random;
  const beliefs = new Beliefs(view);
  const myHand = view.players[view.me].dice;
  const wilds = view.config.wilds && !view.palifico;
  const unseen = view.totalDice - myHand.length;
  const openingHint = [0];
  for (let v = 1; v <= 6; v++) {
    openingHint.push(Math.max(1, Math.round(countDice(myHand, v, wilds) + unseen * prob.faceProb(v, wilds))));
  }

  // Learned call rates help in multiplayer search but hurt head-to-head.
  if (opts.modelCalls && view.order.length > 2) opts.callThresholds = estimateCallThresholds(view);
  const pubRoot = rootPublicBelief(view, beliefs);
  const pubs = new Map([['', pubRoot]]);
  const likeCache = new Map();

  // Tree of my decision points, keyed by the public history since the root.
  const nodes = new Map();
  const getNode = (key, round) => {
    let node = nodes.get(key);
    if (!node) {
      const acts = candidates(roundContext(view, round), key === '' ? openingHint : null);
      node = { visits: 0, children: acts.map((a) => ({ action: a, visits: 0, total: 0 })) };
      nodes.set(key, node);
    }
    return node;
  };

  for (let it = 0; it < opts.iterations; it++) {
    const sampled = beliefs.sampleHands(rng);
    const hands = view.order.map((name) => (name === view.me ? myHand : sampled[name]));
    const round = makeRound(view);
    let key = '';
    let inTree = true;
    const path = [];
    let reward = null;
    let pub = pubRoot;
    for (let guard = 0; guard < 200 && reward === null; guard++) {
      let action;
      if (round.turn === 0 && inTree) {
        const node = getNode(key, round);
        let best = null;
        let bestScore = -Infinity;
        const logN = Math.log(node.visits + 1);
        for (const child of node.children) {
          const score = child.visits === 0
            ? 1e9 + rng()
            : child.total / child.visits + opts.exploration * Math.sqrt(logN / child.visits);
          if (score > bestScore) { bestScore = score; best = child; }
        }
        path.push([node, best]);
        if (best.visits === 0) inTree = false; // expand one new node per iteration
        action = best.action;
      } else {
        action = fastPolicy(view, round, hands[round.turn], pub, rng, opts);
      }
      const ctxBefore = action.type === 'raise' ? roundContext(view, round) : null;
      const actor = round.turn;
      const parentKey = key;
      key += actionKey(action) + ',';
      if (ctxBefore) {
        let next = pubs.get(key);
        if (!next) {
          next = pubs.get(parentKey).withRaise(actor, describeChoice(ctxBefore, action, round.dice[actor]), likeCache);
          pubs.set(key, next);
        }
        pub = next;
      }
      reward = step(view, round, action, hands, opts);
    }
    if (reward === null) reward = 0;
    for (const [node, child] of path) {
      node.visits++;
      child.visits++;
      child.total += reward;
    }
  }

  const root = nodes.get('');
  root.children.sort((a, b) => b.visits - a.visits);
  return root.children;
}

module.exports = {
  description: 'Monte Carlo tree search over likely opponent hands',
  create(options = {}) {
    const rng = engine.makeRng(options.seed || engine.randomSeed());
    return {
      decide(view) {
        return search(view, Object.assign({ rng }, options))[0].action;
      },
    };
  },
  search,
};
