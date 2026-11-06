'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_DELAY_MS = '0';
const { http, createRoom } = require('../server');
const ioClient = require('socket.io-client');

function connect(port) {
  return ioClient(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] });
}

const call = (socket, event, data) =>
  new Promise((resolve) => socket.emit(event, data, (ok, error, extra) => resolve({ ok, error, extra })));

test('a human and two bots play a full game over sockets', async () => {
  await new Promise((resolve) => http.listen(0, resolve));
  const port = http.address().port;
  const room = createRoom();
  const alice = connect(port);
  try {
    let latest = null;
    let finished;
    const done = new Promise((resolve) => (finished = resolve));
    alice.on('GameUpdate', (game) => {
      latest = game;
      if (game.state === 'GameOver') finished(game);
      if (game.state === 'AwaitingYourTurn') {
        // Play like a cautious human: take the hint every time.
        alice.emit('Suggest', (ok, error, action) => {
          if (!ok) return;
          if (action.type === 'raise') alice.emit('Raise', { count: action.count, value: action.value });
          else alice.emit(action.type === 'liar' ? 'Liar' : 'Exact');
        });
      }
    });

    assert.equal((await call(alice, 'JoinGame', { gameId: 'nope', displayName: 'alice' })).ok, false);
    assert.equal((await call(alice, 'JoinGame', { gameId: room.id, displayName: 'alice', password: 'pw' })).ok, true);
    assert.equal((await call(alice, 'StartGame', { numDice: 2 })).ok, false); // need 2 players
    assert.equal((await call(alice, 'AddBot', { type: 'profiler' })).ok, true);
    assert.equal((await call(alice, 'AddBot', { type: 'tactician' })).ok, true);
    assert.equal((await call(alice, 'AddBot', { type: 'nonsense' })).ok, false);

    // A second human can join the lobby but isn't the host.
    const bob = connect(port);
    assert.equal((await call(bob, 'JoinGame', { gameId: room.id, displayName: 'alice', password: 'x' })).ok, false);
    assert.equal((await call(bob, 'JoinGame', { gameId: room.id, displayName: 'bob' })).ok, true);
    assert.equal((await call(bob, 'StartGame', { numDice: 2 })).ok, false);
    assert.equal((await call(alice, 'RemovePlayer', { displayName: 'bob' })).ok, true);
    bob.close();

    assert.equal((await call(alice, 'StartGame', { numDice: 2, wilds: true, turnSeconds: 0 })).ok, true);
    assert.equal((await call(alice, 'StartGame', { numDice: 2 })).ok, false);
    const final = await done;
    assert.equal(final.state, 'GameOver');
    assert.ok(final.winner);
    assert.ok(latest.turns.length >= 3);
    // Other players' dice stay hidden during play.
    for (const [name, p] of Object.entries(final.players)) if (name !== 'alice') assert.equal(p.dice, undefined);
  } finally {
    alice.close();
    room.close();
    http.close();
  }
});
