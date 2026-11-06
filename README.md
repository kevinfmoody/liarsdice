# Liar's Dice

A multiplayer Liar's Dice server with a rules engine, a simulator, and a ladder of AI opponents, from random up to tree search and a game-theory solver.

## Quick start

```sh
npm install
npm start            # http://localhost:3000
```

1. Open `localhost:3000`; you're redirected to a new game. Share that URL to invite people.
2. Pick a name (the password lets you rejoin from another tab or device).
3. The first player is the host: they add bots, choose rules, and start the game.

**Rules options:** dice per player (1–10), wild 1s (Perudo-style: no opening on 1s, halve the count to switch to 1s, double plus one to leave them), "exact" calls (right: gain a die; wrong: lose one), palifico rounds (after a player first drops to one die, 1s aren't wild and the face is locked), and a turn timer. If a player runs out of time or disconnects, a simple bot plays their turn, so the game never stalls.

In game: **Hint** asks the Tactician bot what it would do; **I'm feeling lucky** runs your own `playTurn` from `logic.js`.

## Project layout

| File | What it is |
| --- | --- |
| `engine.js` | Pure rules engine: state, legal moves, `apply`, the per-player view, seeded RNG. No networking. |
| `server.js` | Express + socket.io: rooms, host controls, bot seats, turn timers, reconnects. |
| `index.html`, `index.js`, `styles.css` | Browser client. |
| `logic.js` | Your own bot (the browser runs it on "I'm feeling lucky"; the simulator can too). |
| `ai/` | Probability helpers, opponent modeling, the bots, and the CFR solver. |
| `sim.js` | Headless tournament runner. |
| `test/` | Engine, AI and end-to-end socket tests (`npm test`). |

## The bots

Each bot is `decide(view) => { type: 'raise', count, value } | { type: 'liar' } | { type: 'exact' }`, where `view` holds only what that player is allowed to see.

| Bot | How it plays |
| --- | --- |
| `random` | Random small raises; calls liar 20% of the time. |
| `naive` | The original sample bot: +1 on the same face. |
| `statistician` | Binomial odds on the unseen dice. Picks whichever of calling and raising is less likely to lose a die. |
| `profiler` | Same decision rule, but reads bids. It keeps a probability for every possible hand of each opponent and updates it from their bids: players tend to bid faces they hold. How closely each opponent's bids follow their dice is fitted from past rounds, where dice were revealed after each challenge. |
| `tactician` | Profiler beliefs plus lookahead. For each raise it predicts whether the next player calls (using their likely hands and a calling threshold learned from past rounds), and in 2-player games what they'd raise to and how well it could answer that. Raises that are unlikely to be challenged become attractive, which is where bluffing comes from. |
| `strategist` | Monte Carlo tree search. It samples opponent hands from the belief model, searches its own decisions with UCB, and simulates opponents with a fast policy that uses their sampled hand. All simulated players read the bids too (a shared "public belief" updated after every simulated raise), so bluffs are only rewarded when real opponents would plausibly fall for them. |
| `solver` | CFR+ strategy for 2-player rounds with up to 4 dice total. Players remember their hand and the last two bids, which turns the game into a small graph that's solved for every hand at once. It plays a mixed, hard-to-exploit strategy. Outside those situations it hands over to the strategist. |
| `expert` | Solver in solved endgames, strategist with a bigger search budget everywhere else. |
| `logic` | Runs your `logic.js` in a sandbox. |

In the lobby the levels are Random, Statistician (easy), Profiler (medium), Tactician (hard) and Expert (hardest).

### How they compare

From `sim.js`, with 5 dice each. Head-to-head win rates are within about ±5 points; free-for-all win rates within ±5–7.

**Head-to-head**

| Matchup | Result |
| --- | --- |
| profiler vs statistician | profiler 86% |
| tactician vs profiler | tactician 77% (84% with wilds) |
| strategist vs tactician | strategist 64% |
| expert vs strategist | expert 59% |
| expert vs tactician | expert 71%; even (48%) with wilds |
| solver vs strategist, 2 dice each | solver 69% |

**Free-for-all** (win %)

| Table | expert | strategist | tactician | profiler | statistician | random |
| --- | --- | --- | --- | --- | --- | --- |
| 4 players | 35 | 33 | 18 | 14 | | |
| 6 players | 34 | 32 | 18 | 13 | 5 | 0 |
| 5 players, wilds + exact + palifico | 37 | 34 | 17 | 11 | 1 | |

Move times: about 1–3 ms for the probability bots and 25–50 ms for strategist/expert.

**Multiplayer bias.** Who sits next to whom swings multiplayer win rates by 20+ points, so the simulator shuffles seats every game when there are 3+ players.

## Simulator

```sh
node sim.js --bots statistician,profiler,tactician --games 1000
node sim.js --bots expert,tactician --dice 3 --wilds --spoton --palifico
node sim.js --bots logic,profiler --games 500      # test your logic.js
node sim.js --help
```

Seats rotate through the same seeds, so each bot gets the same dice from each seat over a cycle. That cuts down luck in comparisons. Output shows win rate with a 95% interval, average finishing place, time per move, and how many moves fell back because a bot errored or played an illegal move.

## Solver cache

The CFR strategies take under a minute to train in total. The server trains them in a background thread on startup and saves them to `ai/.cache/` (gitignored). Until that's done, the Expert uses tree search everywhere. To build the cache ahead of time, run `npm run train`. Set `SKIP_SOLVER_TRAINING=1` to turn the startup training off.

## Writing your own bot

Edit `logic.js`. `playTurn(game)` gets the same view the built-in bots get and calls `raise(count, value)`, `liar()` or `exact()`. While playing in the browser you can inspect it in the console as `Game`. Benchmark it with `node sim.js --bots logic,statistician`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | HTTP port |
| `BOT_DELAY_MS` | 900 | Average pause before a bot moves, so humans can follow |
| `SOLVER_ITERATIONS` | 600 | CFR training iterations |
| `SKIP_SOLVER_TRAINING` | unset | Don't train the solver on startup |
