'use strict';

/**
 * Solver: plays the precomputed CFR strategy in two-player rounds with few
 * dice (see ai/cfr.js). It plays a mixed strategy, so it bluffs at the
 * right rate and can't be exploited much. Outside the solved setups it
 * hands over to the Strategist.
 */

const engine = require('../../engine');
const cfr = require('../cfr');
const strategist = require('./strategist');

function solverPolicy(view, { iterations, allowTrain }) {
  if (view.order.length !== 2 || view.config.spotOn || view.palifico) return null;
  const opp = view.order.find((n) => n !== view.me);
  const mine = view.players[view.me].numRemainingDice;
  const theirs = view.players[opp].numRemainingDice;
  const raises = (view.turns[view.turns.length - 1] || []).filter((t) => t.action === 'Raise');
  const role = raises.length % 2; // 0: I opened this round
  const n0 = role === 0 ? mine : theirs;
  const n1 = role === 0 ? theirs : mine;
  const solver = cfr.getSolver(n0, n1, view.config.wilds, { iterations, allowTrain });
  if (!solver) return null;
  const last = raises[raises.length - 1] || null;
  const prev = raises[raises.length - 2] || null;
  return solver.policy(role, prev, last, view.players[view.me].dice);
}

function sample(policy, rng) {
  let r = rng();
  for (const { action, p } of policy) {
    r -= p;
    if (r <= 0) return action;
  }
  return policy[policy.length - 1].action;
}

module.exports = {
  description: 'Near-optimal precomputed strategy for 2-player endgames with few dice',
  create(options = {}) {
    const rng = engine.makeRng(options.seed || engine.randomSeed());
    const fallback = strategist.create(options);
    const opts = { iterations: options.solverIterations || 600, allowTrain: options.allowTrain !== false };
    return {
      decide(view) {
        const policy = solverPolicy(view, opts);
        return policy ? sample(policy, rng) : fallback.decide(view);
      },
    };
  },
  solverPolicy,
};
