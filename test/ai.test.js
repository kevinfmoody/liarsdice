'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const engine = require('../engine');
const prob = require('../ai/prob');
const cfr = require('../ai/cfr');
const { Beliefs } = require('../ai/beliefs');
const { createBot } = require('../ai');
const { runMatch } = require('../sim');

test('binomial helpers', () => {
  assert.ok(Math.abs(prob.binomTail(10, 0, 1 / 6) - 1) < 1e-12);
  assert.ok(Math.abs(prob.binomTail(2, 2, 0.5) - 0.25) < 1e-12);
  assert.ok(Math.abs(prob.binomExact(3, 1, 0.5) - 0.375) < 1e-12);
  const hands = prob.allHands(3);
  assert.equal(hands.length, 56);
  assert.ok(Math.abs(hands.reduce((s, h) => s + h.prior, 0) - 1) < 1e-12);
});

test('beliefs: with no bids, an opponent looks uniform', () => {
  const s = engine.createGame(['a', 'b'], { numDice: 3 }, 3);
  const v = engine.viewFor(s, s.current);
  const b = new Beliefs(v);
  const pmf = b.othersPmf(4);
  const binom = prob.binomPmf(3, 1 / 6);
  pmf.forEach((p, i) => assert.ok(Math.abs(p - binom[i]) < 1e-9));
});

test('beliefs: a bid on a face makes holding it more likely', () => {
  const s = engine.createGame(['a', 'b'], { numDice: 5 }, 3, { shuffle: false });
  engine.apply(s, { type: 'raise', count: 3, value: 6 });
  const b = new Beliefs(engine.viewFor(s, 'b'));
  const sixes = b.othersPmf(6);
  const mean = sixes.reduce((m, p, i) => m + p * i, 0);
  assert.ok(mean > 5 / 6 + 0.3, `expected more sixes than chance, got ${mean}`);
});

const ALL = ['random', 'naive', 'statistician', 'profiler', 'tactician', 'strategist', 'solver', 'expert'];

test('every bot only plays legal moves', () => {
  const configs = [
    { numDice: 3 },
    { numDice: 2, wilds: true },
    { numDice: 3, wilds: true, spotOn: true, palifico: true },
  ];
  for (const config of configs) {
    const groups = [ALL.slice(0, 4), ALL.slice(4), ['expert', 'tactician']];
    for (let seed = 1; seed <= groups.length; seed++) {
      const names = groups[seed - 1];
      const state = engine.createGame(names, config, seed);
      const bots = Object.fromEntries(names.map((n) => [n, createBot(n, { safe: false, seed, iterations: 150 })]));
      while (state.phase !== 'GameOver') {
        const view = engine.viewFor(state, state.current);
        const action = bots[state.current].decide(view);
        assert.equal(engine.validate(state, action), null, `${state.current} played ${JSON.stringify(action)}`);
        engine.apply(state, action);
      }
    }
  }
});

test('the logic.js bot runs in the sandbox', () => {
  const bot = createBot('logic', { safe: false, logicPath: path.join(__dirname, '..', 'logic.js') });
  const s = engine.createGame(['me', 'you'], { numDice: 2 }, 9, { shuffle: false });
  const action = bot.decide(engine.viewFor(s, 'me'));
  assert.equal(action.type, 'raise');
});

test('stronger bots beat weaker ones', () => {
  const rate = (bots, games, config = { numDice: 3 }) =>
    Object.fromEntries(runMatch({ bots, games, config, seed: 3 }).map((r) => [r.bot, r.winRate]));
  assert.ok(rate(['statistician', 'random'], 100).statistician > 0.8);
  assert.ok(rate(['profiler', 'statistician'], 300).profiler > 0.6);
  assert.ok(rate(['tactician', 'profiler'], 300).tactician > 0.55);
});

test('solver: strategy is a probability distribution and calls obvious lies', () => {
  const solver = cfr.getSolver(1, 1, false, { iterations: 200 });
  const policy = solver.policy(0, null, null, [4]);
  const total = policy.reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(total - 1) < 1e-4);
  // Facing "2 fives" while holding a 3: the bid needs both dice, so call.
  const facing = solver.policy(1, null, { count: 2, value: 5 }, [3]);
  const liar = facing.find((x) => x.action.type === 'liar');
  assert.ok(liar.p > 0.99);
});
