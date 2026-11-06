'use strict';

const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const express = require('express');
const engine = require('./engine');
const { createBot, LEVELS } = require('./ai');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_DELAY_MS = parseInt(process.env.BOT_DELAY_MS || '900', 10);
const DISCONNECTED_TIMEOUT_S = 15;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PLAYERS = 10;

const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// ------------------------------------------------------------------ rooms ---

class Room {
  constructor(id) {
    this.id = id;
    this.members = new Map(); // name -> { name, password, socket, bot, botType, connected }
    this.host = null;
    this.state = null;
    this.settings = { turnSeconds: 60 };
    this.timer = null;
    this.deadline = null;
    this.botNames = 0;
  }

  get started() {
    return !!this.state;
  }

  join(name, password, socket) {
    name = String(name || '').trim();
    password = String(password || '');
    if (!name || name.length > 20) return 'Pick a name of 1 to 20 characters.';
    const existing = this.members.get(name);
    if (existing) {
      if (existing.bot) return 'That name belongs to a bot.';
      if (existing.password !== password) return 'That name is taken (wrong password).';
      existing.socket = socket;
      existing.connected = true;
      this.broadcast();
      return null;
    }
    if (this.started) return 'This game has already started.';
    if (this.members.size >= MAX_PLAYERS) return 'This game is full.';
    this.members.set(name, { name, password, socket, bot: null, connected: true });
    if (!this.host) this.host = name;
    this.broadcast();
    return null;
  }

  disconnect(name) {
    const m = this.members.get(name);
    if (!m || m.bot) return;
    m.connected = false;
    m.socket = null;
    if (!this.started) {
      // Leaving the lobby frees the seat; hand hosting to another human.
      this.members.delete(name);
      if (this.host === name) {
        const next = [...this.members.values()].find((x) => !x.bot && x.connected);
        this.host = next ? next.name : null;
      }
    }
    this.scheduleTurn();
    this.broadcast();
  }

  addBot(by, type) {
    if (by !== this.host) return 'Only the host can add bots.';
    if (this.started) return 'The game has already started.';
    if (this.members.size >= MAX_PLAYERS) return 'This game is full.';
    const level = LEVELS.find((l) => l.type === type);
    if (!level) return 'Unknown bot level.';
    const base = level.label.split(' ')[0];
    let name;
    do {
      name = `${base} Bot ${++this.botNames}`;
    } while (this.members.has(name));
    this.members.set(name, {
      name, bot: createBot(type, { allowTrain: false }), botType: type, connected: true,
    });
    this.broadcast();
    return null;
  }

  removePlayer(by, name) {
    if (by !== this.host) return 'Only the host can remove players.';
    if (this.started) return 'The game has already started.';
    const m = this.members.get(name);
    if (!m || name === this.host) return 'Can’t remove that player.';
    this.members.delete(name);
    if (m.socket) m.socket.emit('Kicked');
    this.broadcast();
    return null;
  }

  start(by, options = {}) {
    if (by !== this.host) return 'Only the host can start the game.';
    if (this.started) return 'The game has already started.';
    if (this.members.size < 2) return 'You need at least 2 players (add a bot!).';
    let config;
    try {
      config = engine.normalizeConfig({
        numDice: options.numDice,
        wilds: !!(options.wilds ?? options.enableWilds),
        spotOn: !!options.spotOn,
        palifico: !!options.palifico,
      });
    } catch (err) {
      return err.message;
    }
    const turnSeconds = parseInt(options.turnSeconds, 10);
    this.settings.turnSeconds = Number.isInteger(turnSeconds) && turnSeconds >= 0 && turnSeconds <= 600 ? turnSeconds : 60;
    this.state = engine.createGame([...this.members.keys()], config);
    this.scheduleTurn();
    this.broadcast();
    return null;
  }

  act(name, action) {
    if (!this.started) return 'The game hasn’t started.';
    if (this.state.current !== name) return 'It’s not your turn.';
    const error = engine.validate(this.state, action);
    if (error) return `That move isn’t allowed: ${error}.`;
    engine.apply(this.state, action);
    this.scheduleTurn();
    this.broadcast();
    return null;
  }

  /** Set up whatever happens next: a bot move, or a human's turn timer. */
  scheduleTurn() {
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    if (!this.started || this.state.phase === 'GameOver') return;
    const current = this.members.get(this.state.current);
    const round = this.state.rounds.length;
    const turn = this.state.rounds[round - 1].turns.length;
    const stillSameTurn = () =>
      this.state.rounds.length === round && this.state.rounds[round - 1].turns.length === turn;

    if (current.bot) {
      const delay = BOT_DELAY_MS * (0.7 + Math.random() * 0.6);
      this.timer = setTimeout(() => {
        if (!stillSameTurn()) return;
        const action = current.bot.decide(engine.viewFor(this.state, current.name));
        this.act(current.name, action);
      }, delay);
      return;
    }

    let seconds = this.settings.turnSeconds;
    if (!current.connected) seconds = seconds ? Math.min(seconds, DISCONNECTED_TIMEOUT_S) : DISCONNECTED_TIMEOUT_S;
    if (!seconds) return;
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => {
      if (!stillSameTurn()) return;
      // Out of time: a simple bot plays this turn for them.
      const auto = createBot('statistician');
      this.act(current.name, auto.decide(engine.viewFor(this.state, current.name)));
    }, seconds * 1000);
  }

  viewFor(name) {
    const bots = {};
    const connected = {};
    for (const m of this.members.values()) {
      if (m.bot) bots[m.name] = m.botType;
      connected[m.name] = m.connected;
    }
    const extra = {
      id: this.id, host: this.host, bots, connected, levels: LEVELS,
      deadline: this.deadline, turnSeconds: this.settings.turnSeconds,
    };
    if (!this.started) {
      const players = {};
      for (const m of this.members.keys()) players[m] = { displayName: m, numRemainingDice: 0 };
      return Object.assign({
        state: 'WaitingForPlayers', me: name, displayNames: [...this.members.keys()],
        order: [], players, turns: [], rounds: [], config: engine.DEFAULT_CONFIG,
        totalDice: 0, currentBid: null, palifico: false, winner: null,
      }, extra);
    }
    return Object.assign(engine.viewFor(this.state, name), extra);
  }

  broadcast() {
    for (const m of this.members.values()) {
      if (m.socket) m.socket.emit('GameUpdate', this.viewFor(m.name));
    }
  }

  close() {
    clearTimeout(this.timer);
  }
}

const rooms = new Map();

function createRoom() {
  const id = crypto.randomBytes(16).toString('hex');
  const room = new Room(id);
  rooms.set(id, room);
  setTimeout(() => {
    room.close();
    rooms.delete(id);
  }, ROOM_TTL_MS).unref();
  return room;
}

// ----------------------------------------------------------------- routes ---

for (const file of ['styles.css', 'index.js', 'logic.js']) {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
}

app.get('/', (req, res) => res.redirect(`/games/${createRoom().id}`));

app.get('/games/:id', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------------------------------------------------------------- sockets ---

io.on('connection', (socket) => {
  let room = null;
  let name = null;
  const reply = (cb, error) => {
    if (typeof cb === 'function') cb(!error, error || null);
    else if (error) socket.emit('ActionError', error);
  };
  const guard = (cb) => {
    if (!room || !name) {
      reply(cb, 'Join the game first.');
      return false;
    }
    return true;
  };

  socket.on('JoinGame', (data = {}, cb) => {
    const r = rooms.get(data.gameId);
    if (!r) return reply(cb, 'That game doesn’t exist (it may have expired).');
    const error = r.join(data.displayName, data.password, socket);
    if (!error) {
      room = r;
      name = String(data.displayName).trim();
    }
    reply(cb, error);
  });

  socket.on('AddBot', (data = {}, cb) => guard(cb) && reply(cb, room.addBot(name, data.type)));
  socket.on('RemovePlayer', (data = {}, cb) => guard(cb) && reply(cb, room.removePlayer(name, data.displayName)));
  socket.on('StartGame', (data = {}, cb) => guard(cb) && reply(cb, room.start(name, data)));

  socket.on('Raise', (data = {}, cb) => guard(cb) && reply(cb, room.act(name, {
    type: 'raise', count: parseInt(data.count, 10), value: parseInt(data.value, 10),
  })));
  socket.on('Liar', (data, cb) => guard(cb) && reply(cb || data, room.act(name, { type: 'liar' })));
  socket.on('Exact', (data, cb) => guard(cb) && reply(cb || data, room.act(name, { type: 'exact' })));

  // Ask a bot what it would do in your seat.
  socket.on('Suggest', (data, cb) => {
    cb = cb || data;
    if (!guard(cb) || typeof cb !== 'function') return;
    if (!room.started || room.state.current !== name) return cb(false, 'It’s not your turn.');
    const action = createBot('tactician').decide(engine.viewFor(room.state, name));
    cb(true, null, action);
  });

  socket.on('GameUpdate', () => {
    if (room && name) socket.emit('GameUpdate', room.viewFor(name));
  });

  socket.on('disconnect', () => {
    if (room && name && room.members.get(name) && room.members.get(name).socket === socket) {
      room.disconnect(name);
    }
  });
});

// ------------------------------------------------------- solver warm-up ---

function warmSolver() {
  if (process.env.SKIP_SOLVER_TRAINING) return;
  const worker = new Worker(path.join(__dirname, 'scripts', 'train-solver.js'));
  worker.on('message', (msg) => {
    if (msg !== 'done') console.log('[solver]', msg);
  });
  worker.on('error', (err) => console.error('[solver] training failed:', err.message));
  worker.unref();
}

if (require.main === module) {
  http.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}`);
    warmSolver();
  });
}

module.exports = { app, http, io, Room, rooms, createRoom };
