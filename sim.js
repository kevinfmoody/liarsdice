#!/usr/bin/env node
'use strict';

/**
 * Headless tournament runner.
 *
 *   node sim.js --bots statistician,profiler,tactician --games 2000
 *   node sim.js --bots expert,statistician --dice 2 --wilds --games 500
 *
 * Seats are rotated with the same seed, so each bot gets the same dice from
 * each seat over a cycle. That cuts down luck in the comparison.
 */

const engine = require('./engine');
const { createBot } = require('./ai');

function playGame(types, config, seed, botOptions = {}) {
  const names = types.map((t, i) => `${t}#${i}`);
  const bots = {};
  names.forEach((name, i) => (bots[name] = createBot(types[i], Object.assign({ seed: seed + i }, botOptions))));
  const state = engine.createGame(names, config, seed, { shuffle: false });
  const eliminated = [];
  const time = {};
  const decisions = {};
  let turns = 0;
  while (state.phase !== 'GameOver') {
    const actor = state.current;
    const start = process.hrtime.bigint();
    const action = bots[actor].decide(engine.viewFor(state, actor));
    time[actor] = (time[actor] || 0) + Number(process.hrtime.bigint() - start) / 1e6;
    decisions[actor] = (decisions[actor] || 0) + 1;
    const before = engine.alivePlayers(state);
    engine.apply(state, action);
    for (const name of before) if (state.players[name].numDice === 0) eliminated.push(name);
    if (++turns > 10000) throw new Error('game did not finish');
  }
  // Finishing place: 1 = winner, then reverse elimination order.
  const places = { [state.winner]: 1 };
  eliminated.reverse().forEach((name, i) => (places[name] = i + 2));
  const errors = {};
  for (const name of names) errors[name] = bots[name].errors;
  return { names, winner: state.winner, places, time, decisions, errors, turns };
}

function runMatch({ bots, games = 1000, config = {}, seed = 1, botOptions = {}, onProgress } = {}) {
  const n = bots.length;
  const stats = {};
  for (const t of new Set(bots)) {
    stats[t] = { seats: 0, wins: 0, placeSum: 0, ms: 0, decisions: 0, errors: 0 };
  }
  for (let g = 0; g < games; g++) {
    const rot = g % n;
    const types = bots.slice(rot).concat(bots.slice(0, rot));
    const result = playGame(types, config, seed + Math.floor(g / n) * 7919, botOptions);
    result.names.forEach((name, i) => {
      const s = stats[types[i]];
      s.seats++;
      if (result.winner === name) s.wins++;
      s.placeSum += result.places[name];
      s.ms += result.time[name] || 0;
      s.decisions += result.decisions[name] || 0;
      s.errors += result.errors[name];
    });
    if (onProgress) onProgress(g + 1, games);
  }
  return Object.entries(stats).map(([type, s]) => {
    const p = s.wins / s.seats;
    return {
      bot: type,
      seats: s.seats,
      winRate: p,
      ci95: 1.96 * Math.sqrt((p * (1 - p)) / s.seats),
      avgPlace: s.placeSum / s.seats,
      msPerMove: s.decisions ? s.ms / s.decisions : 0,
      errors: s.errors,
    };
  });
}

function parseArgs(argv) {
  const args = { bots: ['statistician', 'profiler'], games: 1000, seed: 1, config: {}, botOptions: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--bots') args.bots = next().split(',').map((s) => s.trim());
    else if (a === '--games') args.games = parseInt(next(), 10);
    else if (a === '--seed') args.seed = parseInt(next(), 10);
    else if (a === '--dice') args.config.numDice = parseInt(next(), 10);
    else if (a === '--wilds') args.config.wilds = true;
    else if (a === '--spoton') args.config.spotOn = true;
    else if (a === '--palifico') args.config.palifico = true;
    else if (a === '--iterations') args.botOptions.iterations = parseInt(next(), 10);
    else if (a === '--logic') args.botOptions.logicPath = next();
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('unknown option ' + a);
  }
  return args;
}

function printTable(rows) {
  rows.sort((a, b) => b.winRate - a.winRate);
  const head = ['bot', 'seats', 'win %', '±', 'avg place', 'ms/move', 'errors'];
  const body = rows.map((r) => [
    r.bot, String(r.seats), (r.winRate * 100).toFixed(1), (r.ci95 * 100).toFixed(1),
    r.avgPlace.toFixed(2), r.msPerMove.toFixed(2), String(r.errors),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (row) => row.map((c, i) => (i ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  body.forEach((row) => console.log(line(row)));
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node sim.js [options]
  --bots a,b,c     bots to seat (repeat a name for several copies)
  --games N        number of games (default 1000)
  --dice N         starting dice per player (default 5)
  --wilds          1s are wild
  --spoton         allow "exact" calls
  --palifico       palifico rounds
  --seed N         base seed (default 1)
  --iterations N   search budget for strategist / expert
  --logic PATH     file for the "logic" bot (default ./logic.js)
Bots: ${require('./ai').listBotTypes().join(', ')}`);
    process.exit(0);
  }
  const started = Date.now();
  const rows = runMatch(Object.assign({}, args, {
    onProgress: (done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\r${done}/${total} games`);
    },
  }));
  if (process.stderr.isTTY) process.stderr.write('\r');
  console.log(`${args.games} games, ${args.bots.length} seats, config ${JSON.stringify(engine.normalizeConfig(args.config))}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  printTable(rows);
}

module.exports = { playGame, runMatch };
