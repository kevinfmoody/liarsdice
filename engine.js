'use strict';

/**
 * Liar's Dice rules engine.
 *
 * Pure game logic with no networking. The server, the simulator and the bots
 * all share it. State is a plain JSON-able object; `apply` mutates it, and
 * `clone` copies it for search.
 *
 * Rule options (all optional):
 *   numDice   starting dice per player (1-10, default 5)
 *   wilds     1s count as every face; bidding on 1s uses the half/double rule
 *   spotOn    a player may call "exact": right gains a die, wrong loses one
 *   palifico  the round after a player first drops to 1 die: 1s aren't wild
 *             and the face is locked (players on 1 die may still change it)
 */

const DEFAULT_CONFIG = Object.freeze({
  numDice: 5,
  wilds: false,
  spotOn: false,
  palifico: false,
});

// ---------------------------------------------------------------- random ---

// mulberry32: small seeded PRNG so games can be replayed exactly.
function nextRandom(state) {
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function makeRng(seed) {
  const holder = { rngState: seed >>> 0 };
  return () => nextRandom(holder);
}

function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

// ---------------------------------------------------------------- config ---

function normalizeConfig(config = {}) {
  const c = Object.assign({}, DEFAULT_CONFIG, config);
  c.numDice = Number(c.numDice);
  if (!Number.isInteger(c.numDice) || c.numDice < 1 || c.numDice > 10) {
    throw new Error('numDice must be an integer from 1 to 10');
  }
  for (const key of ['wilds', 'spotOn', 'palifico']) {
    if (typeof c[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  }
  return {
    numDice: c.numDice,
    wilds: c.wilds,
    spotOn: c.spotOn,
    palifico: c.palifico,
  };
}

// ----------------------------------------------------------------- rules ---

/**
 * The public facts that decide which bids are legal. Built from either the
 * full state (`contextFromState`) or a player's view (`contextFromView`), so
 * bots and the engine agree on legality.
 */
function makeContext({ prevBid, totalDice, wilds, palifico, openingValue, myDiceCount, spotOn }) {
  return {
    prevBid: prevBid || null,
    totalDice,
    wilds: !!wilds && !palifico, // wilds are switched off in a palifico round
    palifico: !!palifico,
    openingValue: openingValue || null,
    myDiceCount,
    spotOn: !!spotOn,
  };
}

/** Is `bid` a legal raise over ctx.prevBid? */
function isRaiseValid(ctx, bid) {
  const { count, value } = bid;
  if (!Number.isInteger(count) || !Number.isInteger(value)) return false;
  if (count < 1 || count > ctx.totalDice || value < 1 || value > 6) return false;
  const prev = ctx.prevBid;

  if (!prev) {
    // Opening bids on 1s are not allowed when 1s are wild.
    return !(ctx.wilds && value === 1);
  }

  if (ctx.palifico && ctx.myDiceCount > 1 && value !== ctx.openingValue) {
    return false; // face is locked during palifico
  }

  if (ctx.wilds) {
    const prevOnes = prev.value === 1;
    const nextOnes = value === 1;
    if (prevOnes && nextOnes) return count > prev.count;
    if (!prevOnes && nextOnes) return count >= Math.ceil(prev.count / 2);
    if (prevOnes && !nextOnes) return count >= prev.count * 2 + 1;
  }
  return count > prev.count || (count === prev.count && value > prev.value);
}

/** Smallest legal count for a face, or null if none. */
function minLegalCount(ctx, value) {
  for (let count = 1; count <= ctx.totalDice; count++) {
    if (isRaiseValid(ctx, { count, value })) return count;
  }
  return null;
}

/** Every legal action: raises in increasing strength, then liar / exact. */
function legalActionsFromContext(ctx) {
  const actions = [];
  for (let count = 1; count <= ctx.totalDice; count++) {
    for (let value = 1; value <= 6; value++) {
      if (isRaiseValid(ctx, { count, value })) actions.push({ type: 'raise', count, value });
    }
  }
  if (ctx.prevBid) {
    actions.push({ type: 'liar' });
    if (ctx.spotOn) actions.push({ type: 'exact' });
  }
  return actions;
}

/** How many dice show `value`, counting wild 1s. */
function countMatches(dice, value, wilds) {
  let n = 0;
  for (const d of dice) if (d === value || (wilds && d === 1 && value !== 1)) n++;
  return n;
}

// ----------------------------------------------------------------- state ---

function alivePlayers(state) {
  return state.seats.filter((name) => state.players[name].numDice > 0);
}

function totalDice(state) {
  return alivePlayers(state).reduce((sum, name) => sum + state.players[name].numDice, 0);
}

function currentRound(state) {
  return state.rounds[state.rounds.length - 1];
}

function lastRaise(round) {
  for (let i = round.turns.length - 1; i >= 0; i--) {
    if (round.turns[i].action === 'Raise') return round.turns[i];
  }
  return null;
}

/** Next living player after `name`, in seat order. */
function nextAlive(state, name) {
  const n = state.seats.length;
  const start = state.seats.indexOf(name);
  for (let i = 1; i <= n; i++) {
    const candidate = state.seats[(start + i) % n];
    if (state.players[candidate].numDice > 0) return candidate;
  }
  return null;
}

function contextFromState(state) {
  const round = currentRound(state);
  const prev = lastRaise(round);
  const first = round.turns.find((t) => t.action === 'Raise');
  return makeContext({
    prevBid: prev && { count: prev.count, value: prev.value },
    totalDice: totalDice(state),
    wilds: state.config.wilds,
    palifico: round.palifico,
    openingValue: first && first.value,
    myDiceCount: state.players[state.current].numDice,
    spotOn: state.config.spotOn,
  });
}

/**
 * Start a game. `names` are the players in seat order; pass
 * `{ shuffle: true }` to randomize seats with the game's seed.
 */
function createGame(names, config = {}, seed = randomSeed(), { shuffle = true } = {}) {
  if (!Array.isArray(names) || names.length < 2) throw new Error('need at least 2 players');
  if (new Set(names).size !== names.length) throw new Error('player names must be unique');
  const state = {
    config: normalizeConfig(config),
    seats: names.slice(),
    players: {},
    rounds: [],
    current: null,
    phase: 'AwaitingTurn',
    winner: null,
    palificoPending: null,
    rngState: seed >>> 0,
  };
  if (shuffle) {
    for (let i = state.seats.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom(state) * (i + 1));
      [state.seats[i], state.seats[j]] = [state.seats[j], state.seats[i]];
    }
  }
  for (const name of state.seats) {
    state.players[name] = { name, numDice: state.config.numDice, dice: [], hadPalifico: false };
  }
  startRound(state, state.seats[0]);
  return state;
}

function startRound(state, starter) {
  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    state.phase = 'GameOver';
    state.winner = alive[0] || null;
    state.current = null;
    return;
  }
  const palifico = state.config.palifico && state.palificoPending === starter && alive.length > 2;
  state.palificoPending = null;
  for (const name of alive) {
    const p = state.players[name];
    p.dice = [];
    for (let i = 0; i < p.numDice; i++) p.dice.push(1 + Math.floor(nextRandom(state) * 6));
    p.dice.sort((a, b) => a - b);
  }
  state.rounds.push({ starter, palifico, turns: [] });
  state.current = starter;
  state.phase = 'AwaitingTurn';
}

function revealDice(state) {
  const dice = {};
  for (const name of alivePlayers(state)) dice[name] = state.players[name].dice.slice();
  return dice;
}

function loseDie(state, name) {
  const p = state.players[name];
  p.numDice -= 1;
  if (p.numDice === 1 && state.config.palifico && !p.hadPalifico) {
    p.hadPalifico = true;
    state.palificoPending = name;
  }
}

/** Check an action for the current player. Returns an error string or null. */
function validate(state, action) {
  if (state.phase !== 'AwaitingTurn') return 'game is not in progress';
  if (!action || typeof action !== 'object') return 'missing action';
  const ctx = contextFromState(state);
  switch (action.type) {
    case 'raise':
      return isRaiseValid(ctx, action) ? null : 'illegal raise';
    case 'liar':
      return ctx.prevBid ? null : 'nothing to call';
    case 'exact':
      if (!state.config.spotOn) return 'exact calls are off';
      return ctx.prevBid ? null : 'nothing to call';
    default:
      return 'unknown action';
  }
}

/**
 * Play `action` for the current player. Mutates and returns `state`.
 * Throws on an illegal action.
 */
function apply(state, action) {
  const error = validate(state, action);
  if (error) throw new Error(error);
  const actor = state.current;
  const round = currentRound(state);

  if (action.type === 'raise') {
    round.turns.push({ action: 'Raise', displayName: actor, count: action.count, value: action.value });
    state.current = nextAlive(state, actor);
    return state;
  }

  const bid = lastRaise(round);
  const wilds = state.config.wilds && !round.palifico;
  const dice = revealDice(state);
  const actualCount = Object.values(dice).reduce((s, d) => s + countMatches(d, bid.value, wilds), 0);
  let starter;

  if (action.type === 'liar') {
    const bidHolds = actualCount >= bid.count;
    const loser = bidHolds ? actor : bid.displayName;
    const winner = bidHolds ? bid.displayName : actor;
    round.turns.push({
      action: 'Liar', displayName: actor, actualCount, winner, loser,
      bid: { count: bid.count, value: bid.value, displayName: bid.displayName }, dice,
    });
    loseDie(state, loser);
    starter = state.players[loser].numDice > 0 ? loser : nextAlive(state, loser);
  } else {
    const correct = actualCount === bid.count;
    const p = state.players[actor];
    if (correct) {
      p.numDice = Math.min(state.config.numDice, p.numDice + 1);
    } else {
      loseDie(state, actor);
    }
    round.turns.push({
      action: 'Exact', displayName: actor, actualCount, correct,
      winner: correct ? actor : null, loser: correct ? null : actor,
      bid: { count: bid.count, value: bid.value, displayName: bid.displayName }, dice,
    });
    starter = p.numDice > 0 ? actor : nextAlive(state, actor);
  }

  startRound(state, starter);
  return state;
}

function legalActions(state) {
  if (state.phase !== 'AwaitingTurn') return [];
  return legalActionsFromContext(contextFromState(state));
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

// ------------------------------------------------------------------ view ---

/**
 * What one player is allowed to see. The shape matches the original client
 * `Game` object (`state`, `order`, `players`, `turns`) so existing bot code
 * keeps working, plus extra fields for smarter bots.
 */
function viewFor(state, name) {
  const players = {};
  for (const seat of state.seats) {
    const p = state.players[seat];
    players[seat] = { displayName: seat, numRemainingDice: p.numDice };
    if (seat === name) players[seat].dice = p.dice.slice();
  }
  let order = [];
  if (state.current) {
    order = [state.current];
    let next = nextAlive(state, state.current);
    while (next && next !== state.current) {
      order.push(next);
      next = nextAlive(state, next);
    }
  } else if (state.winner) {
    order = [state.winner];
  }
  const round = state.rounds.length ? currentRound(state) : null;
  const prev = round && lastRaise(round);
  let phase = state.phase;
  if (phase === 'AwaitingTurn' && state.current === name) phase = 'AwaitingYourTurn';
  return {
    state: phase,
    me: name,
    displayNames: state.seats.slice(),
    order,
    players,
    turns: state.rounds.map((r) => r.turns.map((t) => Object.assign({}, t))),
    rounds: state.rounds.map((r) => ({ starter: r.starter, palifico: r.palifico })),
    config: Object.assign({}, state.config),
    totalDice: state.phase === 'GameOver' ? 0 : totalDice(state),
    currentBid: prev ? { count: prev.count, value: prev.value, displayName: prev.displayName } : null,
    palifico: !!(round && round.palifico && state.phase !== 'GameOver'),
    winner: state.winner,
  };
}

function contextFromView(view) {
  const turns = view.turns[view.turns.length - 1] || [];
  const first = turns.find((t) => t.action === 'Raise');
  return makeContext({
    prevBid: view.currentBid,
    totalDice: view.totalDice,
    wilds: view.config.wilds,
    palifico: view.palifico,
    openingValue: first && first.value,
    myDiceCount: view.players[view.me].numRemainingDice,
    spotOn: view.config.spotOn,
  });
}

function legalActionsFromView(view) {
  if (view.state !== 'AwaitingYourTurn') return [];
  return legalActionsFromContext(contextFromView(view));
}

function sameAction(a, b) {
  return a.type === b.type && (a.type !== 'raise' || (a.count === b.count && a.value === b.value));
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  createGame,
  apply,
  validate,
  legalActions,
  legalActionsFromView,
  legalActionsFromContext,
  contextFromState,
  contextFromView,
  makeContext,
  isRaiseValid,
  minLegalCount,
  countMatches,
  viewFor,
  clone,
  alivePlayers,
  totalDice,
  nextAlive,
  makeRng,
  randomSeed,
  sameAction,
};
