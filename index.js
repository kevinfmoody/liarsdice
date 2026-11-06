/* global io, playTurn */
'use strict';

const socket = io();
const gameId = window.location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);
const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let displayName = null;
let password = '';
let Game = null; // latest game state, also handy in the console
let timerInterval = null;

// --------------------------------------------------------------- helpers ---

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function bidText(count, value) {
  return `${count} × ${FACES[value]} ${value}${count === 1 ? '' : 's'}`;
}

function say(text) {
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function showError(message) {
  $('action-error').textContent = message || '';
}

function send(event, data) {
  showError('');
  socket.emit(event, data || {}, (ok, error) => {
    if (!ok) showError(error);
  });
}

// ------------------------------------------- actions (used by logic.js) ---

function raise(count, value) {
  count = parseInt(count, 10);
  value = parseInt(value, 10);
  if (isNaN(count) || isNaN(value)) return showError('Enter a count and a face.');
  say(count === 1 ? `${count} ${value}` : `${count} ${value}'s`);
  send('Raise', { count, value });
}

function liar() {
  say('Liar!');
  send('Liar');
}

function exact() {
  say('Exact!');
  send('Exact');
}

// ------------------------------------------------------------------ join ---

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  displayName = $('displayname').value.trim();
  password = $('password').value;
  joinGame();
});

function joinGame() {
  socket.emit('JoinGame', { gameId, displayName, password }, (ok, error) => {
    $('join-error').textContent = ok ? '' : error;
    if (ok) {
      $('join').hidden = true;
      $('game').hidden = false;
    }
  });
}

// Rejoin automatically if the connection drops and comes back.
socket.on('reconnect', () => {
  if (displayName) joinGame();
});

socket.on('Kicked', () => {
  $('game').hidden = true;
  $('join').hidden = false;
  $('join-error').textContent = 'The host removed you from this game.';
});

socket.on('ActionError', showError);
socket.on('GameUpdate', render);

// ----------------------------------------------------------------- lobby ---

for (let n = 1; n <= 10; n++) {
  $('opt-dice').insertAdjacentHTML('beforeend', `<option value="${n}" ${n === 5 ? 'selected' : ''}>${n}</option>`);
}

$('add-bot').addEventListener('click', () => send('AddBot', { type: $('bot-level').value }));

$('start').addEventListener('click', () => send('StartGame', {
  numDice: parseInt($('opt-dice').value, 10),
  wilds: $('opt-wilds').checked,
  spotOn: $('opt-spoton').checked,
  palifico: $('opt-palifico').checked,
  turnSeconds: parseInt($('opt-timer').value, 10),
}));

$('players').addEventListener('click', (e) => {
  const name = e.target.dataset && e.target.dataset.remove;
  if (name) send('RemovePlayer', { displayName: name });
});

// ----------------------------------------------------------------- table ---

$('raise').addEventListener('click', () => raise($('count').value, $('value').value));
$('liar').addEventListener('click', liar);
$('exact').addEventListener('click', exact);
$('auto').addEventListener('click', () => {
  try {
    playTurn(Game);
  } catch (err) {
    showError('logic.js failed: ' + err.message);
  }
});
$('hint').addEventListener('click', () => {
  socket.emit('Suggest', (ok, error, action) => {
    if (!ok) return showError(error);
    if (action.type === 'raise') {
      $('count').value = action.count;
      $('value').value = action.value;
      $('hint-text').textContent = `A bot would bid ${bidText(action.count, action.value)}.`;
    } else {
      $('hint-text').textContent = `A bot would call ${action.type === 'liar' ? 'liar' : 'exact'}.`;
    }
  });
});

// ---------------------------------------------------------------- render ---

function render(game) {
  Game = game;
  console.log(game);
  const me = game.players[displayName];
  const playing = game.state === 'AwaitingTurn' || game.state === 'AwaitingYourTurn';

  renderStatus(game);
  renderPlayers(game);
  renderTimer(game);

  // Lobby
  $('lobby').hidden = game.state !== 'WaitingForPlayers';
  const isHost = game.host === displayName;
  $('host-controls').hidden = !isHost;
  $('guest-note').hidden = isHost;
  if (!$('bot-level').options.length) {
    $('bot-level').innerHTML = game.levels
      .map((l) => `<option value="${l.type}" ${l.type === 'tactician' ? 'selected' : ''}>${escapeHtml(l.label)}</option>`)
      .join('');
  }

  // Table
  $('table').hidden = !playing;
  if (playing) {
    $('dice').textContent = (me.dice || []).map((d) => FACES[d]).join(' ') || '(out)';
    $('current-bid').textContent = game.currentBid
      ? bidText(game.currentBid.count, game.currentBid.value)
      : 'No bid yet';
    $('bid-by').textContent = game.currentBid ? `by ${game.currentBid.displayName}` : '';
    $('total-dice').textContent = game.totalDice;
  }
  const myTurn = game.state === 'AwaitingYourTurn';
  if (myTurn && $('actions').hidden) {
    // New turn: prefill one above the current bid, clear old hints.
    const bid = game.currentBid;
    $('count').value = bid ? bid.count + 1 : 1;
    $('value').value = bid ? bid.value : 2;
    $('hint-text').textContent = '';
  }
  $('actions').hidden = !myTurn;
  $('liar').disabled = !game.currentBid;
  $('exact').hidden = !game.config.spotOn;
  $('exact').disabled = !game.currentBid;

  renderHistory(game);
}

function renderStatus(game) {
  let text;
  switch (game.state) {
    case 'WaitingForPlayers': text = 'Waiting for players'; break;
    case 'AwaitingYourTurn': text = 'Your turn'; break;
    case 'AwaitingTurn': text = `Waiting for ${game.order[0]}…`; break;
    case 'GameOver': text = game.winner === displayName ? 'You win! 🎉' : `${game.winner} wins the game`; break;
    default: text = '';
  }
  if (game.palifico && game.state !== 'GameOver') text += ' · Palifico round';
  $('status').textContent = text;

  const c = game.config;
  const rules = [`${c.numDice} dice each`];
  if (c.wilds) rules.push('1s wild');
  if (c.spotOn) rules.push('exact calls');
  if (c.palifico) rules.push('palifico');
  $('rules').textContent = game.state === 'WaitingForPlayers' ? '' : rules.join(' · ');
}

function renderPlayers(game) {
  const isHost = game.host === displayName;
  const current = game.state === 'AwaitingTurn' || game.state === 'AwaitingYourTurn' ? game.order[0] : null;
  $('players').innerHTML = game.displayNames.map((name) => {
    const p = game.players[name];
    const out = game.state !== 'WaitingForPlayers' && p.numRemainingDice === 0;
    const tags = [];
    if (name === displayName) tags.push('you');
    if (game.bots[name]) tags.push('bot');
    if (name === game.host) tags.push('host');
    if (!game.connected[name]) tags.push('away');
    let right = '';
    if (game.state === 'WaitingForPlayers') {
      if (isHost && name !== displayName) {
        right = `<button class="remove" data-remove="${escapeHtml(name)}" title="Remove">×</button>`;
      }
    } else {
      right = `${p.numRemainingDice} ${p.numRemainingDice === 1 ? 'die' : 'dice'}`;
    }
    return `<li class="${name === current ? 'turn' : ''} ${out ? 'out' : ''}">
      <span>${escapeHtml(name)}<span class="tag">${tags.join(' · ')}</span></span>
      <span>${right}</span></li>`;
  }).join('');
}

function renderTimer(game) {
  clearInterval(timerInterval);
  const el = $('timer');
  if (!game.deadline) {
    el.hidden = true;
    return;
  }
  const tick = () => {
    const left = Math.max(0, Math.ceil((game.deadline - Date.now()) / 1000));
    el.textContent = `${left}s`;
  };
  el.hidden = false;
  tick();
  timerInterval = setInterval(tick, 500);
}

function renderHistory(game) {
  const html = [];
  game.turns.forEach((round, i) => {
    if (!round.length) return;
    const palifico = game.rounds[i] && game.rounds[i].palifico ? ' (palifico)' : '';
    const rows = round.map((turn) => {
      const who = escapeHtml(turn.displayName);
      if (turn.action === 'Raise') return `<tr><td>${who}</td><td>${bidText(turn.count, turn.value)}</td></tr>`;
      const dice = Object.keys(turn.dice)
        .map((n) => `${escapeHtml(n)}: ${turn.dice[n].map((d) => FACES[d]).join('')}`)
        .join(' &nbsp; ');
      const outcome = turn.action === 'Liar'
        ? `Liar! There were ${turn.actualCount}. ${escapeHtml(turn.loser)} loses a die.`
        : `Exact! There were ${turn.actualCount}. ${turn.correct ? `${who} gains a die.` : `${who} loses a die.`}`;
      return `<tr><td>${who}</td><td>${outcome}<div class="reveal">${dice}</div></td></tr>`;
    }).reverse().join('');
    html.unshift(`<table><tr><th>Round ${i + 1}${palifico}</th><th></th></tr>${rows}</table>`);
  });
  $('history').innerHTML = html.join('') || '<p class="muted">Nothing yet.</p>';
}
