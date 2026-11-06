let playTurn = (function() {
  /**
   *
   * Add helper variables and functions here.
   *
   * The `game` object you get has:
   *   game.me            your name
   *   game.players       { name: { numRemainingDice, dice (yours only) } }
   *   game.order         living players, starting with whoever's turn it is
   *   game.turns         every round's turns; the last array is this round
   *   game.currentBid    { count, value, displayName } or null
   *   game.totalDice     dice in play
   *   game.config        { numDice, wilds, spotOn, palifico }
   *   game.palifico      true in a palifico round (1s not wild)
   *
   * Test your bot against the built-in ones:
   *   node sim.js --bots logic,statistician,profiler --games 500
   *
   */

  // Sample helper function
  function getPreviousTurn(game) {
    // Get the current round from the game history
    const currentRound = game.turns[game.turns.length - 1];

    // Get the previous turn from the round history
    return currentRound[currentRound.length - 1];
  }

  /**
   *
   * This is your core turn logic.
   *
   * Call one of the following methods:
   *
   * return raise(<count>, <value>);
   *
   * -OR-
   *
   * return liar();
   *
   * -OR- (only if the game allows exact calls)
   *
   * return exact();
   *
   */

  // Sample implementation
  return function playTurnImpl(game) {
    // Get the previous turn from the round history
    const previousTurn = getPreviousTurn(game);

    // Open the round with one 2 (you can't open on 1s when they're wild)
    if (!previousTurn) {
      return raise(1, 2);
    }

    // Up the count by one if the previous count is less than 10
    if (previousTurn.count < 10 && previousTurn.count < game.totalDice) {
      return raise(previousTurn.count + 1, previousTurn.value);
    }

    // Call liar if all else fails
    return liar();
  };

})();
