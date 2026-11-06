'use strict';

/**
 * Runs the browser bot in logic.js (or --logic PATH) inside a sandbox, so
 * you can test your own bot with the simulator.
 *
 * logic.js must define `playTurn(game)` and call `raise(count, value)`,
 * `liar()` or `exact()`, exactly as in the browser.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = {
  description: 'Your own bot from logic.js',
  create(options = {}) {
    const file = path.resolve(options.logicPath || path.join(__dirname, '..', '..', 'logic.js'));
    const code = fs.readFileSync(file, 'utf8');
    let chosen = null;
    const sandbox = {
      console,
      Math,
      raise: (count, value) => { chosen = { type: 'raise', count: Number(count), value: Number(value) }; },
      liar: () => { chosen = { type: 'liar' }; },
      exact: () => { chosen = { type: 'exact' }; },
    };
    vm.createContext(sandbox);
    vm.runInContext(code + '\n;this.__playTurn = playTurn;', sandbox, { filename: file });
    return {
      decide(view) {
        chosen = null;
        sandbox.__playTurn(JSON.parse(JSON.stringify(view)));
        return chosen;
      },
    };
  },
};
