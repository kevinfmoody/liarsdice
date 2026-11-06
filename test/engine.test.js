'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine');

/** A game with fixed dice, for exact rule checks. */
function rigged(hands, config = {}, starter = null) {
  const names = Object.keys(hands);
  const state = engine.createGame(names, config, 1, { shuffle: false });
  for (const name of names) {
    state.players[name].dice = hands[name].slice().sort((a, b) => a - b);
    state.players[name].numDice = hands[name].length;
  }
  if (starter) {
    state.current = starter;
    state.rounds[0].starter = starter;
  }
  return state;
}

const raise = (count, value) => ({ type: 'raise', count, value });

test('rejects bad configs and player lists', () => {
  assert.throws(() => engine.createGame(['a'], {}));
  assert.throws(() => engine.createGame(['a', 'a'], {}));
  assert.throws(() => engine.createGame(['a', 'b'], { numDice: 0 }));
  assert.throws(() => engine.createGame(['a', 'b'], { numDice: 'x' }));
  assert.throws(() => engine.createGame(['a', 'b'], { wilds: 'yes' }));
});

test('the same seed gives the same game', () => {
  const a = engine.createGame(['a', 'b', 'c'], {}, 42);
  const b = engine.createGame(['a', 'b', 'c'], {}, 42);
  assert.deepEqual(a, b);
});

test('raises must go up', () => {
  const s = rigged({ a: [2, 3], b: [4, 5] });
  assert.throws(() => engine.apply(s, raise(0, 3)));
  assert.throws(() => engine.apply(s, raise(1, 7)));
  assert.throws(() => engine.apply(s, raise(NaN, 3)));
  assert.throws(() => engine.apply(s, raise(5, 3)), /illegal/); // more than 4 dice in play
  engine.apply(s, raise(2, 3));
  assert.throws(() => engine.apply(s, raise(2, 3)));
  assert.throws(() => engine.apply(s, raise(2, 2)));
  assert.throws(() => engine.apply(s, raise(1, 6)));
  engine.apply(s, raise(2, 4));
  engine.apply(s, raise(3, 1)); // higher count, any face
});

test('liar is only allowed after a bid', () => {
  const s = rigged({ a: [2], b: [3] });
  assert.throws(() => engine.apply(s, { type: 'liar' }));
  assert.throws(() => engine.apply(s, { type: 'exact' }), /off/);
});

test('calling liar on a true bid costs the caller a die, and they start next', () => {
  const s = rigged({ a: [2, 2], b: [2, 5] });
  engine.apply(s, raise(3, 2));
  engine.apply(s, { type: 'liar' });
  const turn = s.rounds[0].turns[1];
  assert.equal(turn.actualCount, 3);
  assert.equal(turn.loser, 'b');
  assert.equal(s.players.b.numDice, 1);
  assert.equal(s.current, 'b');
  assert.deepEqual(turn.dice, { a: [2, 2], b: [2, 5] });
});

test('calling liar on a false bid costs the bidder a die, and they start next', () => {
  const s = rigged({ a: [2, 2], b: [2, 5], c: [6, 6] });
  engine.apply(s, raise(4, 2));
  engine.apply(s, { type: 'liar' });
  assert.equal(s.rounds[0].turns[1].loser, 'a');
  assert.equal(s.players.a.numDice, 1);
  assert.equal(s.current, 'a');
});

test('wild 1s count for other faces but not for 1s', () => {
  const s = rigged({ a: [1, 3], b: [1, 1] }, { wilds: true });
  engine.apply(s, raise(4, 3));
  engine.apply(s, { type: 'liar' });
  assert.equal(s.rounds[0].turns[1].actualCount, 4);
  assert.equal(s.rounds[0].turns[1].loser, 'b');
});

test('wilds: no opening on 1s, half to switch to 1s, double plus one to leave', () => {
  const s = rigged({ a: [2, 3, 4], b: [2, 3, 4], c: [5, 6, 6] }, { wilds: true });
  assert.throws(() => engine.apply(s, raise(1, 1)));
  engine.apply(s, raise(5, 4));
  assert.throws(() => engine.apply(s, raise(2, 1)));
  engine.apply(s, raise(3, 1)); // ceil(5 / 2) = 3
  assert.throws(() => engine.apply(s, raise(6, 6)));
  engine.apply(s, raise(7, 2)); // 3 * 2 + 1
});

test('a player with no dice left is out, and the next player starts', () => {
  const s = rigged({ a: [3], b: [2, 2], c: [4, 4] });
  engine.apply(s, raise(3, 3));
  engine.apply(s, { type: 'liar' });
  assert.equal(s.players.a.numDice, 0);
  assert.equal(s.current, 'b');
  assert.deepEqual(engine.alivePlayers(s), ['b', 'c']);
});

test('the game ends when one player is left', () => {
  const s = rigged({ a: [3], b: [2] });
  engine.apply(s, raise(2, 3));
  engine.apply(s, { type: 'liar' });
  assert.equal(s.phase, 'GameOver');
  assert.equal(s.winner, 'b');
  assert.deepEqual(engine.legalActions(s), []);
  assert.throws(() => engine.apply(s, raise(1, 2)));
});

test('exact: right gains a die (up to the start), wrong loses one', () => {
  const s = rigged({ a: [3, 3], b: [3, 5] }, { spotOn: true, numDice: 3 });
  engine.apply(s, raise(3, 3));
  engine.apply(s, { type: 'exact' });
  assert.equal(s.rounds[0].turns[1].correct, true);
  assert.equal(s.players.b.numDice, 3);
  assert.equal(s.current, 'b');

  const t = rigged({ a: [3, 3], b: [3, 5] }, { spotOn: true });
  engine.apply(t, raise(2, 3));
  engine.apply(t, { type: 'exact' });
  assert.equal(t.players.b.numDice, 1);
});

test('palifico: after dropping to 1 die, 1s are not wild and the face is locked', () => {
  const s = rigged({ a: [4, 4], b: [2, 2], c: [3, 3] }, { wilds: true, palifico: true });
  engine.apply(s, raise(4, 5)); // false
  engine.apply(s, { type: 'liar' });
  assert.equal(s.players.a.numDice, 1);
  assert.equal(s.rounds[1].palifico, true);
  assert.equal(s.current, 'a');
  engine.apply(s, raise(1, 1)); // 1s may be opened in palifico
  assert.throws(() => engine.apply(s, raise(2, 4))); // b has 2 dice: face is locked
  engine.apply(s, raise(2, 1));
  // A palifico happens only once per player.
  s.players.a.dice = [6];
  s.players.b.dice = [6, 6];
  s.players.c.dice = [6, 6];
  engine.apply(s, { type: 'liar' }); // c calls 2x1: false, b loses
  assert.equal(s.players.b.numDice, 1);
  assert.equal(s.rounds[2].palifico, true);
});

test('view hides other players’ dice and keeps the classic shape', () => {
  const s = rigged({ a: [1, 2], b: [3, 4] });
  const v = engine.viewFor(s, 'b');
  assert.equal(v.state, 'AwaitingTurn');
  assert.deepEqual(v.order, ['a', 'b']);
  assert.deepEqual(v.players.b.dice, [3, 4]);
  assert.equal(v.players.a.dice, undefined);
  assert.equal(v.players.a.numRemainingDice, 2);
  assert.ok(Array.isArray(v.turns[0]));
  assert.equal(engine.viewFor(s, 'a').state, 'AwaitingYourTurn');
});

test('legal actions from a view match the engine', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const s = engine.createGame(['a', 'b', 'c'], { wilds: seed % 2 === 0, spotOn: seed % 3 === 0, palifico: true, numDice: 3 }, seed);
    const rng = engine.makeRng(seed);
    while (s.phase !== 'GameOver') {
      const fromState = engine.legalActions(s);
      const fromView = engine.legalActionsFromView(engine.viewFor(s, s.current));
      assert.deepEqual(fromView, fromState);
      const pick = rng() < 0.3 && fromState.some((a) => a.type === 'liar')
        ? fromState.find((a) => a.type === 'liar')
        : fromState[Math.floor(rng() * Math.min(fromState.length, 8))];
      engine.apply(s, pick);
    }
  }
});
