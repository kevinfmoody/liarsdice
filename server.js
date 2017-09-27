var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);

function hash() {
  const chars = '0123456789abcdef';
  let hash = '';
  for (let i = 0; i < 32; i++) {
    const index = Math.floor(Math.random() * 16);
    hash += chars[index];
  }
  return hash;
}

class GameManager {
  constructor() {
    this.games = {};
  }

  createGame() {
    let id;
    while (true) {
      id = hash();
      if (!this.games[id]) {
        break;
      }
    }
    this.games[id] = new LiarsDiceGame(id);
    setTimeout(() => {
      delete this.games[id];
    }, 12 * 60 * 60 * 1000);
    return id;
  }

  getGame(id) {
    return this.games[id] || null;
  }
}

class LiarsDiceGame {
  constructor(id) {
    this.id = id;
    this.players = {};
    this.order = [];
    this.turns = [];
    this.numStartingDice;
    this.enableWilds;
    this.state = 'WaitingForPlayers';
  }

  currentRoundTurns() {
    return this.turns[this.turns.length - 1];
  }

  previousTurnThisRound() {
    const currentRoundTurns = this.currentRoundTurns();
    return currentRoundTurns[currentRoundTurns.length - 1];
  }

  currentPlayer() {
    return this.players[this.order[0]];
  }

  liar(displayName) {
    if (this.state !== 'AwaitingTurn') {
      return false;
    }
    if (this.currentPlayer().displayName !== displayName) {
      return false;
    }
    if (!this.previousTurnThisRound()) {
      return false;
    }
    const previousTurn = this.previousTurnThisRound();
    const value = previousTurn.value;
    const actualCount = this.order.reduce((sum, displayName) => {
      return sum + this.players[displayName].dice.filter((die) => {
        return die === value || (this.enableWilds && die === 1);
      }).length;
    }, 0);
    let winner;
    let loser;
    if (actualCount >= previousTurn.count) {
      winner = previousTurn.displayName;
      loser = displayName;
    } else {
      winner = displayName;
      loser = previousTurn.displayName;
    }
    this.currentRoundTurns().push({
      action: 'Liar',
      displayName,
      actualCount,
      winner,
      loser,
      dice: this.getDice()
    });
    this.players[loser].numRemainingDice -= 1;
    this.order.push(this.order.shift());
    this.order = this.order.filter((displayName) => {
      return this.players[displayName].numRemainingDice > 0;
    });
    this.startRound();
    this.updatePlayers();
    return true;
  }

  raise(displayName, count, value) {
    if (this.state !== 'AwaitingTurn') {
      return false;
    }
    if (this.currentPlayer().displayName !== displayName) {
      return false;
    }
    count = parseInt(count, 10);
    value = parseInt(value, 10);
    if (count < 1 || value < 1 || value > 6) {
      return false;
    }
    const previousTurn = this.previousTurnThisRound();
    if (previousTurn && (count < previousTurn.count || (count === previousTurn.count
        && value <= previousTurn.value))) {
      return false;
    }
    this.currentRoundTurns().push({
      action: 'Raise',
      displayName,
      count,
      value
    });
    this.order.push(this.order.shift());
    this.updatePlayers();
    return true;
  }

  joinGame(displayName, password, socket) {
    if (this.state !== 'WaitingForPlayers'
        && this.players[displayName]
        && this.players[displayName].password === password) {
      this.players[displayName].socket = socket;
      this.updatePlayer(displayName);
      return true;
    }
    if (this.state !== 'WaitingForPlayers'
        || (this.players[displayName]
        && this.players[displayName].password !== password)) {
      return false;
    } 
    this.players[displayName] = {
      displayName,
      password,
      socket,
      numRemainingDice: 0,
      dice: []
    };
    this.updatePlayers();
    return true;
  }

  startGame(numDice, enableWilds) {
    if (this.state !== 'WaitingForPlayers') {
      return false;
    }
    numDice = parseInt(numDice, 10);
    if (isNaN(numDice) || numDice < 1 || numDice > 6) {
      return false;
    }
    if (enableWilds !== true && enableWilds !== false) {
      return false;
    }
    this.numStartingDice = numDice;
    this.enableWilds = enableWilds;
    this.order = this.chooseOrder();
    this.issueDice();
    this.startRound();
    this.updatePlayers();
    return true;
  }

  issueDice() {
    for (let displayName in this.players) {
      this.players[displayName].numRemainingDice = this.numStartingDice;
    }
  }

  startRound() {
    if (this.order.length == 1) {
      this.state = 'GameOver';
      return;
    }
    this.turns.push([]);
    this.order.forEach((displayName) => {
      const player = this.players[displayName];
      player.dice = this.rollDice(player.numRemainingDice);
    });
    this.state = 'AwaitingTurn';
  }

  chooseOrder() {
    let displayNames = Object.keys(this.players);
    for (let i = displayNames.length - 1; i > 0; i--) {
      let j = Math.floor(Math.random() * (i + 1));
      [displayNames[i], displayNames[j]] = [displayNames[j], displayNames[i]];
    }
    return displayNames;
  }

  rollDice(n) {
    let dice = [];
    for (let i = 0; i < n; i++) {
      dice.push(this.rollDie());
    }
    return dice.sort();
  }
  
  rollDie() {
    return 1 + Math.floor(Math.random() * 6);
  }

  updatePlayer(displayName) {
    const player = this.players[displayName];
    player.socket.emit('GameUpdate', this.toJson(player));
  }

  updatePlayers() {
    for (let displayName in this.players) {
      this.updatePlayer(displayName);
    }
  }

  getDice(p) {
    let dice = {};
    this.order.forEach((displayName) => {
      dice[displayName] = this.players[displayName].dice;
    });
    return dice;
  }

  getPlayersForPlayer(p) {
    const players = {};
    for (let displayName in this.players) {
      const player = this.players[displayName];
      if (player.displayName === p.displayName) {
        players[displayName] = {
          displayName: player.displayName,
          numRemainingDice: player.numRemainingDice,
          dice: player.dice
        };
      } else {
        players[displayName] = {
          displayName: player.displayName,
          numRemainingDice: player.numRemainingDice
        };
      }
    }
    return players;
  }

  getStateForPlayer(p) {
    switch (this.state) {
      case 'AwaitingTurn':
        if (this.order[0] === p.displayName) {
          return 'AwaitingYourTurn';
        }
        break;
    }
    return this.state;
  }

  toJson(p) {
    return {
      id: this.id,
      state: this.getStateForPlayer(p),
      displayNames: Object.keys(this.players),
      order: this.order,
      players: this.getPlayersForPlayer(p),
      turns: this.turns
    };
  }
}

const gameManager = new GameManager();

app.get('/styles.css', (req, res) => {
  res.sendFile(__dirname + '/styles.css');
});

app.get('/index.js', (req, res) => {
  res.sendFile(__dirname + '/index.js');
});

app.get('/logic.js', (req, res) => {
  res.sendFile(__dirname + '/logic.js');
});

app.get('/', (req, res) => {
  const gameId = gameManager.createGame();
  res.redirect(`/games/${gameId}`);
});

app.get('/games/:id', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {

  let game = null;
  let displayName;

  socket.on('JoinGame', (data, cb) => {
    console.log('JoinGame Request');
    game = gameManager.getGame(data.gameId);
    if (!game) {
      return cb(false);
    }
    const success = game.joinGame(data.displayName, data.password, socket);
    if (success) {
      displayName = data.displayName;
    }
    cb(success);
  });

  socket.on('StartGame', (data) => {
    console.log('StartGame Request');
    if (!game) {
      return;
    }
    game.startGame(data.numDice, data.enableWilds);
  });

  socket.on('Raise', (data) => {
    console.log('Raise Request');
    if (!game) {
      return;
    }
    game.raise(displayName, data.count, data.value);
  });

  socket.on('Liar', () => {
    console.log('Liar Request');
    if (!game) {
      return;
    }
    game.liar(displayName);
  });

  socket.on('GameUpdate', () => {
    console.log('GameUpdate Request');
    if (!game) {
      return;
    }
    game.updatePlayer(displayName);
  });

});

http.listen(3000, () => {
  console.log('listening on *:3000');
});