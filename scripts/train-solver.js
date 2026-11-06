#!/usr/bin/env node
'use strict';

/**
 * Pre-train the CFR solver for every supported setup and save the results to
 * ai/.cache. The server runs this in a background thread on startup when the
 * cache is missing; you can also run it by hand: `npm run train`.
 */

const fs = require('fs');
const { isMainThread, parentPort } = require('worker_threads');
const cfr = require('../ai/cfr');

const ITERATIONS = parseInt(process.env.SOLVER_ITERATIONS || '600', 10);

function trainAll(log = () => {}) {
  for (const [a, b, wilds] of cfr.allSetups()) {
    const file = cfr.cachePath(a, b, wilds, ITERATIONS);
    if (fs.existsSync(file)) continue;
    const started = Date.now();
    cfr.getSolver(a, b, wilds, { iterations: ITERATIONS });
    log(`trained ${a}x${b} ${wilds ? 'wild' : 'plain'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
}

if (!isMainThread) {
  trainAll((msg) => parentPort.postMessage(msg));
  parentPort.postMessage('done');
} else if (require.main === module) {
  trainAll(console.log);
  console.log('solver cache is ready');
}

module.exports = { trainAll, ITERATIONS };
