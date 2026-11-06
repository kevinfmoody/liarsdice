'use strict';

/**
 * Bot registry. Every bot is `create(options) => { decide(view) => action }`
 * where action is { type: 'raise', count, value } | { type: 'liar' } | { type: 'exact' }.
 */

const engine = require('../engine');
const basic = require('./bots/basic');

const registry = {
  random: basic.random,
  naive: basic.naive,
  statistician: basic.statistician,
  profiler: basic.profiler,
};

// Heavier bots are loaded lazily so the server starts fast.
const lazy = {
  tactician: () => require('./bots/tactician'),
  strategist: () => require('./bots/strategist'),
  solver: () => require('./bots/solver'),
  expert: () => require('./bots/expert'),
  logic: () => require('./bots/logic'),
};

const LEVELS = [
  { type: 'random', label: 'Random' },
  { type: 'statistician', label: 'Statistician (easy)' },
  { type: 'profiler', label: 'Profiler (medium)' },
  { type: 'tactician', label: 'Tactician (hard)' },
  { type: 'expert', label: 'Expert (hardest)' },
];

function getBotType(type) {
  if (registry[type]) return registry[type];
  if (lazy[type]) return (registry[type] = lazy[type]());
  throw new Error(`unknown bot "${type}". Options: ${listBotTypes().join(', ')}`);
}

function listBotTypes() {
  return Object.keys(registry).concat(Object.keys(lazy).filter((k) => !registry[k]));
}

/**
 * Create a bot. With `safe: true` (the default), an illegal action or a
 * thrown error falls back to the statistician so a game never stalls.
 */
function createBot(type, options = {}) {
  const bot = getBotType(type).create(options);
  if (options.safe === false) return bot;
  const fallback = basic.statistician.create();
  return {
    type,
    errors: 0,
    decide(view) {
      try {
        const action = bot.decide(view);
        const legal = engine.legalActionsFromView(view);
        if (action && legal.some((a) => engine.sameAction(a, action))) return action;
        throw new Error('illegal action ' + JSON.stringify(action));
      } catch (err) {
        this.errors++;
        if (options.onError) options.onError(err);
        return fallback.decide(view);
      }
    },
  };
}

module.exports = { createBot, listBotTypes, getBotType, LEVELS };
