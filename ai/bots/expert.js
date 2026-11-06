'use strict';

/**
 * Expert: the strongest bot for each situation, picked from tournaments.
 *   - 2 players, few dice: the CFR solver
 *   - 2 players otherwise: tree search (strategist)
 *   - 3+ players: one-step lookahead (tactician), which beat tree search
 *     in multiplayer free-for-alls
 */

const solver = require('./solver');
const tactician = require('./tactician');

module.exports = {
  description: 'Solver in small 2-player endgames, tree search head-to-head, lookahead in multiplayer',
  create(options = {}) {
    const headsUp = solver.create(Object.assign({ iterations: 2000 }, options));
    const multi = tactician.create(options);
    return {
      decide(view) {
        return view.order.length > 2 ? multi.decide(view) : headsUp.decide(view);
      },
    };
  },
};
