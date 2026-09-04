/**
 * TicTacToe Game Engine
 * Pure logic, state transitions, win detection, and minimax AI.
 * 
 * @typedef {'X' | 'O'} Player
 * @typedef {Player | null} Cell
 * @typedef {Cell[]} Board // length 9, index 0..8
 * @typedef {'IN_PROGRESS' | 'WIN' | 'DRAW'} GameStatus
 * 
 * @typedef {Object} State
 * @property {Board} board
 * @property {Player} turn
 * @property {GameStatus} status
 * @property {Player | null} winner
 * @property {[number, number, number] | null} winningLine
 * @property {Record<Player | 'draws', number>} scores
 */

/**
 * 8 Winning line combinations (3 horizontal, 3 vertical, 2 diagonal)
 */
export const LINES = [
  [0, 1, 2], // Row 0
  [3, 4, 5], // Row 1
  [6, 7, 8], // Row 2
  [0, 3, 6], // Col 0
  [1, 4, 7], // Col 1
  [2, 5, 8], // Col 2
  [0, 4, 8], // Diagonal \
  [2, 4, 6]  // Diagonal /
];

/**
 * Initializes a new game state.
 * @param {Record<Player | 'draws', number>} [scores]
 * @returns {State}
 */
export function init(scores = { X: 0, O: 0, draws: 0 }) {
  return {
    board: Array(9).fill(null),
    turn: 'X',
    status: 'IN_PROGRESS',
    winner: null,
    winningLine: null,
    scores: {
      X: scores?.X ?? 0,
      O: scores?.O ?? 0,
      draws: scores?.draws ?? 0
    }
  };
}

/**
 * Checks for a winner or draw on the board.
 * @param {Board} board
 * @returns {{ winner: Player | null, line: [number, number, number] | null, isDraw: boolean }}
 */
export function checkWinner(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) {
      return {
        winner: board[a],
        line: [a, b, c],
        isDraw: false
      };
    }
  }

  const isDraw = board.every((cell) => cell !== null);
  return {
    winner: null,
    line: null,
    isDraw
  };
}

/**
 * Immutably applies a move to the state.
 * Alternates turn, checks lines, and updates scores on terminal states.
 * 
 * @param {State} state 
 * @param {number} index 
 * @returns {State | Error}
 */
export function playMove(state, index) {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8) {
    return new Error(`Invalid board index: ${index}`);
  }
  if (state.status !== 'IN_PROGRESS') {
    return new Error(`Game is already finished with status: ${state.status}`);
  }
  if (state.board[index] !== null) {
    return new Error(`Cell ${index} is already occupied by ${state.board[index]}`);
  }

  // Immutable copy
  const newBoard = [...state.board];
  newBoard[index] = state.turn;

  const { winner, line, isDraw } = checkWinner(newBoard);

  let newStatus = 'IN_PROGRESS';
  const newScores = { ...state.scores };

  if (winner) {
    newStatus = 'WIN';
    newScores[winner] = (newScores[winner] || 0) + 1;
  } else if (isDraw) {
    newStatus = 'DRAW';
    newScores.draws = (newScores.draws || 0) + 1;
  }

  const nextTurn = state.turn === 'X' ? 'O' : 'X';

  return {
    board: newBoard,
    turn: nextTurn,
    status: newStatus,
    winner: winner ?? null,
    winningLine: line ?? null,
    scores: newScores
  };
}

/**
 * Recursive minimax evaluation with terminal scoring (+10 - depth / -10 + depth / 0)
 * and alpha-beta pruning.
 * 
 * @param {Board} board 
 * @param {number} depth 
 * @param {boolean} isMaximizing 
 * @param {Player} aiPlayer 
 * @param {Player} opponent 
 * @param {number} alpha 
 * @param {number} beta 
 * @returns {number}
 */
function minimax(board, depth, isMaximizing, aiPlayer, opponent, alpha, beta) {
  const result = checkWinner(board);
  if (result.winner === aiPlayer) {
    return 10 - depth;
  }
  if (result.winner === opponent) {
    return -10 + depth;
  }
  if (result.isDraw) {
    return 0;
  }

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = aiPlayer;
        const score = minimax(board, depth + 1, false, aiPlayer, opponent, alpha, beta);
        board[i] = null;
        if (score > maxEval) {
          maxEval = score;
        }
        alpha = Math.max(alpha, score);
        if (beta <= alpha) {
          break;
        }
      }
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = opponent;
        const score = minimax(board, depth + 1, true, aiPlayer, opponent, alpha, beta);
        board[i] = null;
        if (score < minEval) {
          minEval = score;
        }
        beta = Math.min(beta, score);
        if (beta <= alpha) {
          break;
        }
      }
    }
    return minEval;
  }
}

/**
 * Computes the optimal move for aiPlayer using recursive minimax.
 * 
 * @param {Board} board 
 * @param {Player} aiPlayer 
 * @returns {number} index (0..8) of best move, or -1 if no move available
 */
export function getBestMove(board, aiPlayer) {
  const opponent = aiPlayer === 'X' ? 'O' : 'X';
  let bestScore = -Infinity;
  let bestMove = -1;

  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = aiPlayer;
      const score = minimax(board, 0, false, aiPlayer, opponent, -Infinity, Infinity);
      board[i] = null;
      if (score > bestScore) {
        bestScore = score;
        bestMove = i;
      }
    }
  }

  return bestMove;
}
