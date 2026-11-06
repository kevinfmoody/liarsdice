'use strict';

/**
 * Expert: the strongest combination. Uses the solver when the situation is
 * one it has solved (2 players, few dice) and tree search otherwise.
 */

const solver = require('./solver');

module.exports = {
  description: 'Solver for small 2-player endgames, tree search everywhere else',
  create(options = {}) {
    return solver.create(Object.assign({ iterations: 2000 }, options));
  },
};
