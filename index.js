const s = io();
const gameId = (() => {
  const urlParts = window.location.href.split('/');
  return urlParts[urlParts.length - 1];
})();
let displayName;
let currentGameState;

$joingameContainer = $('#joingame-container');
$displayname = $('#displayname');
$password = $('#password');
$joingame = $('#joingame');

$gameContainer = $('#game-container');
$players = $('#players');
$order = $('#order');
$numRemaining = $('#numremaining');
$state = $('#state');
$startGame = $('#startgame');
$dice = $('#dice');

$turnActions = $('#turn-actions');
$count = $('#count');
$value = $('#value');
$raise = $('#raise');
$liar = $('#liar');
$auto = $('#auto');

$turnHistory = $('#turn-history');

$joingame.click(function() {
  displayName = $displayname.val().trim();
  const password = $password.val().trim();
  s.emit('JoinGame', {gameId, displayName, password}, (success) => {
    if (success) {
      $joingameContainer.hide();
      $gameContainer.show();
    }
  });
});

$startGame.click(function() {
  let numDice;
  let enableWilds;
  while (true) {
    numDice = parseInt(prompt('How many dice should each player have to start?'), 10);
    if (!isNaN(numDice) && numDice > 0 && numDice <= 6) {
      break;
    }
  }
  while (true) {
    const response = prompt('Play with wilds? yes/no').toLowerCase()[0];
    if (response === 'y') {
      enableWilds = true;
      break;
    } else if (response === 'n') {
      enableWilds = false;
      break;
    }
  }
  s.emit('StartGame', {numDice, enableWilds});
});

function raise(count, value) {
  if (!isNaN(count) && !isNaN(value)) {
    if (count === 1) {
      say(`${count} ${value}`);
    } else {
      say(`${count} ${value}'s`);
    }
    s.emit('Raise', {count, value});
    $count.val('');
    $value.val('');
  }
}

function liar() {
  $count.val('');
  $value.val('');
  say('Liar!');
  s.emit('Liar');
}

function say(text) {
  const msg = new SpeechSynthesisUtterance(text);
  speechSynthesis.speak(msg);
}

$raise.click(function() {
  const count = parseInt($count.val().trim(), 10);
  const value = parseInt($value.val().trim(), 10);
  raise(count, value);
});

$liar.click(function() {  
  liar();
});

$auto.click(function() {
  playTurn(currentGameState);
});

s.on('GameUpdate', (game) => {
  renderGame(game);
});

function renderTotalNumRemainingDie(game) {
  if (game.state !== 'WaitingForPlayers') {
    const totalNumRemainingDice = game.order.reduce((sum, displayName) => {
      return sum + game.players[displayName].numRemainingDice;
    }, 0);
    $numRemaining.show().text(totalNumRemainingDice);
  }
}

function renderPlayers(game) {
  $players.html(game.displayNames.map((displayName) => {
    if (game.state === 'WaitingForPlayers') {
      return displayName;
    }
    return game.players[displayName].numRemainingDice
        ? displayName
        : `<span style="text-decoration:line-through">${displayName}</span>`;
  }).join(', '));
}

function renderOrder(game) {
  $order.text(game.order.length ? game.order.map((displayName) => {
    return `${displayName} (${game.players[displayName].numRemainingDice})`
  }).join(', ') : 'No order yet');
}

function renderDiceHtml(dice) {
  return dice.map((die) => {
    return `&#${9855 + die}`;
  }).join(' ');
}

function renderDice(game, me) {
  if (game.state !== 'WaitingForPlayers' && game.state !== 'GameOver') {
    $dice.show();
    $dice.html(renderDiceHtml(me.dice));
  }
}

function renderTurnHistory(game) {
  game.turns.forEach((round, i) => {
    if (!round.length) {
      return;
    }
    $turnHistory.prepend('<table>'
      + `<tr><th>Round ${i + 1}</th><th>Count</th><th>Value</th></tr>`
      + round.map((turn) => {
        if (turn.action === 'Liar') {
          const outcome = turn.displayName === turn.winner ? 'Won' : 'Lost';
          const diceHtml = Object.keys(turn.dice).map((displayName) => {
            return `${displayName}: ${renderDiceHtml(turn.dice[displayName])}`;
          }).join(', ');
          return `<tr><td>${turn.displayName}</td><td>Liar!</td>`
              + `<td>${outcome} (${turn.actualCount}) [${diceHtml}]</td></tr>`;
        } else {
          return `<tr><td>${turn.displayName}</td>`
              + `<td>${turn.count}</td><td>${turn.value}</td></tr>`;
        }
      }).reverse().join('')
      + '</table>'
    );
  });
}

function renderRaiseBet(game) {
  if ($count.val() || $value.val()) {
    return;
  }
  const currentRound = game.turns[game.turns.length - 1];
  if (!currentRound.length) {
    return;
  }
  const previousTurn = currentRound[currentRound.length - 1];
  $count.val(previousTurn.count);
  $value.val(previousTurn.value);
}

function renderGame(game) {
  currentGameState = game;
  console.log(game);
  const me = game.players[displayName];
  $startGame.hide();
  $dice.hide();
  $turnActions.hide();
  $numRemaining.hide();
  $turnHistory.empty();
  this.renderPlayers(game);
  this.renderOrder(game);
  this.renderTotalNumRemainingDie(game);
  this.renderDice(game, me);
  this.renderTurnHistory(game);
  switch(game.state) {
    case 'WaitingForPlayers':
      $state.text('Waiting for more players to join.');
      $startGame.show();
      break;
    case 'AwaitingYourTurn':
      this.renderRaiseBet(game);
      $state.text('It\'s your turn!');
      $turnActions.show();
      break;
    case 'AwaitingTurn':
      $state.text(`Awaiting ${game.order[0]}'s turn...`);
      break;
    case 'GameOver':
      $state.text(`${game.order[0]} wins the game!`);
      break;
    default:
      $state.text('The game has started...');
  }
}