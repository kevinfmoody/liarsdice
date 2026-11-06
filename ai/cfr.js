'use strict';

/**
 * CFR+ solver for two-player rounds with few dice.
 *
 * Abstraction: a player decides from their own hand plus the last two bids
 * (theirs and the opponent's). Because legality only depends on the last bid,
 * the pair (previous bid, last bid, whose turn) is a Markov state, so the game
 * is a small DAG and we can run full-width "vector" CFR over all hands at
 * once instead of sampling deals.
 *
 * In a two-player round exactly one player loses a die and the loss is all
 * that matters, so maximizing P(opponent loses this round) is the right goal
 * for the whole game.
 *
 * Role 0 opens the round, role 1 answers.
 */

const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const prob = require('./prob');

const CACHE_DIR = path.join(__dirname, '.cache');
const FORMAT_VERSION = 1;

/** Topological strength: every legal raise goes to a higher number. */
function strength(bid, wilds) {
  if (wilds && bid.value === 1) return bid.count * 20 + 6.5;
  return bid.count * 10 + bid.value;
}

function buildGame(n0, n1, wilds) {
  const total = n0 + n1;
  const bids = [];
  for (let count = 1; count <= total; count++) {
    for (let value = 1; value <= 6; value++) bids.push({ count, value });
  }
  bids.sort((a, b) => strength(a, wilds) - strength(b, wilds));
  const B = bids.length;
  const bidIndex = new Map(bids.map((b, i) => [b.count * 10 + b.value, i + 1]));

  // next[l]: bid indices (1-based) that can follow bid l (0 = opening).
  const next = [];
  for (let l = 0; l <= B; l++) {
    const ctx = engine.makeContext({
      prevBid: l ? bids[l - 1] : null, totalDice: total, wilds, palifico: false, myDiceCount: 1,
    });
    next.push(bids.map((b, j) => (engine.isRaiseValid(ctx, b) ? j + 1 : 0)).filter(Boolean));
  }

  const hands = [prob.allHands(n0), prob.allHands(n1)];
  const H0 = hands[0].length;
  const H1 = hands[1].length;

  // truth[b][x * H1 + y]: does bid b hold when role 0 has hand x, role 1 hand y?
  const truth = [null];
  for (const b of bids) {
    const t = new Uint8Array(H0 * H1);
    for (let x = 0; x < H0; x++) {
      const mx = prob.matchesFromCounts(hands[0][x].counts, b.value, wilds);
      for (let y = 0; y < H1; y++) {
        t[x * H1 + y] = mx + prob.matchesFromCounts(hands[1][y].counts, b.value, wilds) >= b.count ? 1 : 0;
      }
    }
    truth.push(t);
  }

  // Reachable states, found breadth-first, then ordered by last bid.
  const key = (p, l, r) => (p * (B + 1) + l) * 2 + r;
  const index = new Map();
  const states = [];
  const queue = [[0, 0, 0]];
  index.set(key(0, 0, 0), 0);
  states.push({ p: 0, l: 0, r: 0 });
  while (queue.length) {
    const [p, l, r] = queue.shift();
    for (const b of next[l]) {
      const k = key(l, b, 1 - r);
      if (!index.has(k)) {
        index.set(k, states.length);
        states.push({ p: l, l: b, r: 1 - r });
        queue.push([l, b, 1 - r]);
      }
    }
  }
  const order = states.map((_, i) => i).sort((a, b) => states[a].l - states[b].l);
  const sorted = order.map((old) => states[old]);
  index.clear();
  sorted.forEach((s, i) => index.set(key(s.p, s.l, s.r), i));
  sorted.forEach((s) => {
    s.raises = next[s.l];
    s.children = s.raises.map((b) => index.get(key(s.l, b, 1 - s.r)));
    s.numActions = s.raises.length + (s.l ? 1 : 0); // + liar
  });

  return { n0, n1, wilds, total, bids, bidIndex, B, hands, H: [H0, H1], truth, states: sorted, index, key };
}

/** Regret matching: strategy for hand h at a state from its regrets. */
function currentStrategy(regret, A, h, out) {
  let sum = 0;
  for (let a = 0; a < A; a++) {
    const r = regret[h * A + a];
    out[a] = r > 0 ? r : 0;
    sum += out[a];
  }
  for (let a = 0; a < A; a++) out[a] = sum > 0 ? out[a] / sum : 1 / A;
}

function train(game, iterations = 400, onProgress) {
  const { states, H, hands, truth } = game;
  const S = states.length;
  const priors = [Float64Array.from(hands[0].map((h) => h.prior)), Float64Array.from(hands[1].map((h) => h.prior))];
  const regret = states.map((s) => new Float64Array(H[s.r] * s.numActions));
  const stratSum = states.map((s) => new Float64Array(H[s.r] * s.numActions));
  const sigma = states.map((s) => new Float64Array(H[s.r] * s.numActions));
  const reach = [states.map(() => new Float64Array(H[0])), states.map(() => new Float64Array(H[1]))];
  const W = states.map(() => new Float64Array(H[0] * H[1])); // EV for role 0
  const tmp = new Float64Array(64);

  for (let t = 1; t <= iterations; t++) {
    // Current strategies.
    for (let s = 0; s < S; s++) {
      const st = states[s];
      const A = st.numActions;
      for (let h = 0; h < H[st.r]; h++) {
        currentStrategy(regret[s], A, h, tmp);
        for (let a = 0; a < A; a++) sigma[s][h * A + a] = tmp[a];
      }
    }
    // Forward: each player's own reach, summed over paths.
    for (let s = 0; s < S; s++) { reach[0][s].fill(0); reach[1][s].fill(0); }
    reach[0][0].fill(1);
    reach[1][0].fill(1);
    for (let s = 0; s < S; s++) {
      const st = states[s];
      const A = st.numActions;
      const r = st.r;
      for (let i = 0; i < st.children.length; i++) {
        const c = st.children[i];
        const own = reach[r][c];
        const src = reach[r][s];
        for (let h = 0; h < H[r]; h++) own[h] += src[h] * sigma[s][h * A + i];
        const other = reach[1 - r][c];
        const osrc = reach[1 - r][s];
        for (let h = 0; h < H[1 - r]; h++) other[h] += osrc[h];
      }
    }
    // Backward: expected value for role 0 at each state, for every deal.
    for (let s = S - 1; s >= 0; s--) {
      const st = states[s];
      const A = st.numActions;
      const w = W[s];
      w.fill(0);
      const liar = st.l ? A - 1 : -1;
      const tr = st.l ? truth[st.l] : null;
      for (let x = 0; x < H[0]; x++) {
        for (let y = 0; y < H[1]; y++) {
          const cell = x * H[1] + y;
          const h = st.r === 0 ? x : y;
          let v = 0;
          for (let i = 0; i < st.children.length; i++) v += sigma[s][h * A + i] * W[st.children[i]][cell];
          if (liar >= 0) {
            // Caller is role st.r. Bid holds -> caller loses.
            const callerWins = tr[cell] ? -1 : 1;
            v += sigma[s][h * A + liar] * (st.r === 0 ? callerWins : -callerWins);
          }
          w[cell] = v;
        }
      }
    }
    // Regret and average-strategy updates (CFR+ with linear averaging).
    const cf = new Float64Array(64);
    for (let s = 0; s < S; s++) {
      const st = states[s];
      const A = st.numActions;
      const r = st.r;
      const oppReach = reach[1 - r][s];
      const myReach = reach[r][s];
      const q = new Float64Array(H[1 - r]);
      let any = false;
      for (let y = 0; y < q.length; y++) { q[y] = priors[1 - r][y] * oppReach[y]; if (q[y] > 0) any = true; }
      const sign = r === 0 ? 1 : -1;
      const tr = st.l ? truth[st.l] : null;
      for (let h = 0; h < H[r]; h++) {
        if (any) {
          for (let a = 0; a < A; a++) {
            let v = 0;
            if (a < st.children.length) {
              const wc = W[st.children[a]];
              if (r === 0) for (let y = 0; y < H[1]; y++) v += q[y] * wc[h * H[1] + y];
              else for (let x = 0; x < H[0]; x++) v += q[x] * wc[x * H[1] + h];
              v *= sign;
            } else {
              // liar: +1 if the bid fails
              if (r === 0) for (let y = 0; y < H[1]; y++) v += q[y] * (tr[h * H[1] + y] ? -1 : 1);
              else for (let x = 0; x < H[0]; x++) v += q[x] * (tr[x * H[1] + h] ? -1 : 1);
            }
            cf[a] = v;
          }
          let ev = 0;
          for (let a = 0; a < A; a++) ev += sigma[s][h * A + a] * cf[a];
          for (let a = 0; a < A; a++) {
            const idx = h * A + a;
            regret[s][idx] = Math.max(0, regret[s][idx] + cf[a] - ev);
          }
        }
        for (let a = 0; a < A; a++) stratSum[s][h * A + a] += t * myReach[h] * sigma[s][h * A + a];
      }
    }
    if (onProgress) onProgress(t, iterations);
  }

  // Normalize average strategy into one flat Float32Array.
  let size = 0;
  for (let s = 0; s < S; s++) size += stratSum[s].length;
  const flat = new Float32Array(size);
  let off = 0;
  for (let s = 0; s < S; s++) {
    const st = states[s];
    const A = st.numActions;
    for (let h = 0; h < H[st.r]; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += stratSum[s][h * A + a];
      for (let a = 0; a < A; a++) flat[off + h * A + a] = sum > 0 ? stratSum[s][h * A + a] / sum : 1 / A;
    }
    off += stratSum[s].length;
  }
  // Value of the game for role 0 under the average strategy is not needed at play time.
  return flat;
}

/** A trained solver: maps a public situation and a hand to action probabilities. */
class Solver {
  constructor(game, flat) {
    this.game = game;
    this.flat = flat;
    this.offsets = [];
    let off = 0;
    for (const st of game.states) {
      this.offsets.push(off);
      off += game.H[st.r] * st.numActions;
    }
    this.handIndex = game.hands.map((hs) => new Map(hs.map((h, i) => [h.dice.join(''), i])));
  }

  /**
   * @param role     0 if I opened this round, else 1
   * @param prevBid  bid before the last one (or null)
   * @param lastBid  the bid I'm facing (or null when opening)
   * @param dice     my dice
   */
  policy(role, prevBid, lastBid, dice) {
    const g = this.game;
    const p = prevBid ? g.bidIndex.get(prevBid.count * 10 + prevBid.value) : 0;
    const l = lastBid ? g.bidIndex.get(lastBid.count * 10 + lastBid.value) : 0;
    const s = g.index.get(g.key(p, l, role));
    if (s === undefined) return null;
    const h = this.handIndex[role].get(dice.slice().sort((a, b) => a - b).join(''));
    if (h === undefined) return null;
    const st = g.states[s];
    const A = st.numActions;
    const base = this.offsets[s] + h * A;
    const out = [];
    st.raises.forEach((b, i) => {
      const bid = g.bids[b - 1];
      out.push({ action: { type: 'raise', count: bid.count, value: bid.value }, p: this.flat[base + i] });
    });
    if (st.l) out.push({ action: { type: 'liar' }, p: this.flat[base + A - 1] });
    return out;
  }
}

const SUPPORTED = { maxPerPlayer: 3, maxTotal: 4 };

function supports(n0, n1) {
  return n0 >= 1 && n1 >= 1 && n0 <= SUPPORTED.maxPerPlayer && n1 <= SUPPORTED.maxPerPlayer &&
    n0 + n1 <= SUPPORTED.maxTotal;
}

function cachePath(n0, n1, wilds, iterations) {
  return path.join(CACHE_DIR, `v${FORMAT_VERSION}-${n0}x${n1}-${wilds ? 'wild' : 'plain'}-${iterations}.bin`);
}

const loaded = new Map();

/**
 * Get a solver for this setup: from memory, then the disk cache, then by
 * training (only if `allowTrain`). Returns null if unavailable.
 */
function getSolver(n0, n1, wilds, { iterations = 400, allowTrain = true } = {}) {
  if (!supports(n0, n1)) return null;
  const id = `${n0}x${n1}-${wilds}-${iterations}`;
  if (loaded.has(id)) return loaded.get(id);
  const game = buildGame(n0, n1, wilds);
  const file = cachePath(n0, n1, wilds, iterations);
  let flat = null;
  try {
    const buf = fs.readFileSync(file);
    flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch (err) {
    if (!allowTrain) return null;
    flat = train(game, iterations);
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, Buffer.from(flat.buffer));
    } catch (e) {
      // Read-only disk: keep it in memory only.
    }
  }
  const solver = new Solver(game, flat);
  loaded.set(id, solver);
  return solver;
}

/** Every setup the solver covers, for pre-training. */
function allSetups() {
  const out = [];
  for (const wilds of [false, true]) {
    for (let a = 1; a <= SUPPORTED.maxPerPlayer; a++) {
      for (let b = 1; b <= SUPPORTED.maxPerPlayer; b++) if (supports(a, b)) out.push([a, b, wilds]);
    }
  }
  return out;
}

module.exports = { buildGame, train, Solver, getSolver, supports, allSetups, cachePath };
