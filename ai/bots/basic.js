'use strict';

const engine = require('../../engine');
const prob = require('../prob');
const heuristic = require('../heuristic');
const { Beliefs, countDice } = require('../beliefs');

/** Picks a random small raise; calls liar now and then. */
const random = {
  description: 'Random small raises, calls liar 20% of the time',
  create({ rng = Math.random } = {}) {
    return {
      decide(view) {
        const ctx = engine.contextFromView(view);
        if (ctx.prevBid && (rng() < 0.2 || !heuristic.candidateRaises(ctx, 0).length)) {
          return { type: 'liar' };
        }
        const raises = heuristic.candidateRaises(ctx, 1);
        return raises[Math.floor(rng() * raises.length)];
      },
    };
  },
};

/** The original sample bot from logic.js: +1 on the same face, liar at 10. */
const naive = {
  description: 'Original sample bot: always +1 on the same face',
  create() {
    return {
      decide(view) {
        const ctx = engine.contextFromView(view);
        const prev = ctx.prevBid;
        if (!prev) return { type: 'raise', count: 1, value: ctx.wilds ? 2 : 1 };
        const next = { type: 'raise', count: prev.count + 1, value: prev.value };
        if (prev.count < 10 && engine.isRaiseValid(ctx, next)) return next;
        return { type: 'liar' };
      },
    };
  },
};

/** Plain probability: unseen dice are uniform, ignores what others bid. */
const statistician = {
  description: 'Binomial odds on unseen dice; ignores what others bid',
  create(options = {}) {
    return {
      decide(view) {
        const wilds = view.config.wilds && !view.palifico;
        const mine = view.players[view.me].dice;
        const unseen = view.totalDice - mine.length;
        const pTrue = (b) =>
          prob.binomTail(unseen, b.count - countDice(mine, b.value, wilds), prob.faceProb(b.value, wilds));
        const pExact = (b) =>
          prob.binomExact(unseen, b.count - countDice(mine, b.value, wilds), prob.faceProb(b.value, wilds));
        return heuristic.decide(view, pTrue, pExact, options);
      },
    };
  },
};

/** Same decision rule, but reads opponents' bids to infer their dice. */
const profiler = {
  description: 'Infers opponents’ dice from their bids and learns how much each one bluffs',
  create(options = {}) {
    return {
      decide(view) {
        const beliefs = new Beliefs(view);
        return heuristic.decide(view, (b) => beliefs.pTrue(b), (b) => beliefs.pExact(b), options);
      },
    };
  },
};

module.exports = { random, naive, statistician, profiler };
