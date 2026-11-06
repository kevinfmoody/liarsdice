'use strict';

// Probability helpers shared by the bots.

const pmfCache = new Map();

/** Binomial pmf as an array [P(X=0) .. P(X=n)]. Cached. */
function binomPmf(n, p) {
  const key = n + ':' + p;
  let pmf = pmfCache.get(key);
  if (pmf) return pmf;
  pmf = new Array(n + 1).fill(0);
  let coef = 1;
  for (let k = 0; k <= n; k++) {
    pmf[k] = coef * Math.pow(p, k) * Math.pow(1 - p, n - k);
    coef = (coef * (n - k)) / (k + 1);
  }
  pmfCache.set(key, pmf);
  return pmf;
}

const tailCache = new Map();

/** P(X >= k) for X ~ Binomial(n, p). */
function binomTail(n, k, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const key = n + ':' + p;
  let tails = tailCache.get(key);
  if (!tails) {
    const pmf = binomPmf(n, p);
    tails = new Array(n + 2).fill(0);
    for (let i = n; i >= 0; i--) tails[i] = tails[i + 1] + pmf[i];
    tailCache.set(key, tails);
  }
  return Math.min(1, tails[k]);
}

/** P(X == k) for X ~ Binomial(n, p). */
function binomExact(n, k, p) {
  if (k < 0 || k > n) return 0;
  return binomPmf(n, p)[k];
}

/** Chance an unseen die matches `value`. */
function faceProb(value, wilds) {
  return wilds && value !== 1 ? 1 / 3 : 1 / 6;
}

/** Convolve two pmfs (distributions of independent counts). */
function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

function tailOfPmf(pmf, k) {
  if (k <= 0) return 1;
  let s = 0;
  for (let i = k; i < pmf.length; i++) s += pmf[i];
  return Math.min(1, s);
}

function pmfAt(pmf, k) {
  return k >= 0 && k < pmf.length ? pmf[k] : 0;
}

// Every multiset of n dice (sorted hands) with its prior probability.
const handsCache = new Map();
function allHands(n) {
  let hands = handsCache.get(n);
  if (hands) return hands;
  hands = [];
  const fact = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const total = Math.pow(6, n);
  const rec = (start, left, cur) => {
    if (left === 0) {
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const d of cur) counts[d]++;
      let ways = fact[n];
      for (let f = 1; f <= 6; f++) ways /= fact[counts[f]];
      hands.push({ dice: cur.slice(), counts, prior: ways / total });
      return;
    }
    for (let f = start; f <= 6; f++) {
      cur.push(f);
      rec(f, left - 1, cur);
      cur.pop();
    }
  };
  rec(1, n, []);
  handsCache.set(n, hands);
  return hands;
}

/** Matches for `value` from a counts array [_, n1..n6]. */
function matchesFromCounts(counts, value, wilds) {
  return counts[value] + (wilds && value !== 1 ? counts[1] : 0);
}

module.exports = {
  binomPmf,
  binomTail,
  binomExact,
  faceProb,
  convolve,
  tailOfPmf,
  pmfAt,
  allHands,
  matchesFromCounts,
};
