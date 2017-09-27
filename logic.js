let playTurn = (function() {
  /**
   *
   * Add helper variables and functions here.
   * 
   */

  // Sample constants
  const START_COUNT = 1;
  const START_VALUE = 1;

  // Sample global variable
  let numTurns = 0;

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
   * Call one of the following two methods:
   * 
   * return raise(<count>, <value>);
   * 
   * -OR-
   * 
   * return liar();
   * 
   */
  
  // Sample implementation
  return function playTurnImpl(game) {
    // Increment the number of turns I've taken this game
    numTurns++;

    // Get the previous turn from the round history
    const previousTurn = getPreviousTurn(game);

    // Start with the default if this is the first turn of the round
    if (!previousTurn) {
      return raise(START_COUNT, START_VALUE);
    }
  
    // Up the count by one if the previous count is less than 10
    if (previousTurn.count < 10) {
      return raise(previousTurn.count + 1, previousTurn.value);
    }
    
    // Call liar if all else fails
    return liar();
  };

})();