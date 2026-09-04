import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, init, checkWinner, playMove, getBestMove } from '../engine.js';

describe('engine.js - TicTacToe Core Logic', () => {
  describe('LINES constant', () => {
    it('should define all 8 winning line combinations', () => {
      assert.equal(LINES.length, 8);
      const expectedLines = [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 3, 6],
        [1, 4, 7],
        [2, 5, 8],
        [0, 4, 8],
        [2, 4, 6]
      ];
      assert.deepEqual(LINES, expectedLines);
    });
  });

  describe('init()', () => {
    it('should initialize a fresh game state with default values', () => {
      const state = init();
      assert.deepEqual(state.board, Array(9).fill(null));
      assert.equal(state.turn, 'X');
      assert.equal(state.status, 'IN_PROGRESS');
      assert.equal(state.winner, null);
      assert.equal(state.winningLine, null);
      assert.deepEqual(state.scores, { X: 0, O: 0, draws: 0 });
    });

    it('should retain existing scores when provided', () => {
      const existingScores = { X: 3, O: 2, draws: 1 };
      const state = init(existingScores);
      assert.deepEqual(state.scores, existingScores);
      assert.notEqual(state.scores, existingScores); // Must be a clone
    });
  });

  describe('checkWinner() - 8 patterns & terminal states', () => {
    const patterns = [
      { name: 'Row 0', line: [0, 1, 2] },
      { name: 'Row 1', line: [3, 4, 5] },
      { name: 'Row 2', line: [6, 7, 8] },
      { name: 'Col 0', line: [0, 3, 6] },
      { name: 'Col 1', line: [1, 4, 7] },
      { name: 'Col 2', line: [2, 5, 8] },
      { name: 'Diagonal \\', line: [0, 4, 8] },
      { name: 'Diagonal /', line: [2, 4, 6] }
    ];

    for (const { name, line } of patterns) {
      it(`detects win for player X along ${name} (${line.join(',')})`, () => {
        const board = Array(9).fill(null);
        line.forEach(idx => (board[idx] = 'X'));
        const result = checkWinner(board);
        assert.equal(result.winner, 'X');
        assert.deepEqual(result.line, line);
        assert.equal(result.isDraw, false);
      });

      it(`detects win for player O along ${name} (${line.join(',')})`, () => {
        const board = Array(9).fill(null);
        line.forEach(idx => (board[idx] = 'O'));
        const result = checkWinner(board);
        assert.equal(result.winner, 'O');
        assert.deepEqual(result.line, line);
        assert.equal(result.isDraw, false);
      });
    }

    it('detects a draw state when board is full and no winner', () => {
      // Board:
      // X O X
      // X X O
      // O X O
      const board = [
        'X', 'O', 'X',
        'X', 'X', 'O',
        'O', 'X', 'O'
      ];
      const result = checkWinner(board);
      assert.equal(result.winner, null);
      assert.equal(result.line, null);
      assert.equal(result.isDraw, true);
    });

    it('detects in-progress state when empty or partially filled with no winner', () => {
      const emptyBoard = Array(9).fill(null);
      assert.deepEqual(checkWinner(emptyBoard), {
        winner: null,
        line: null,
        isDraw: false
      });

      const partialBoard = ['X', 'O', null, null, 'X', null, null, null, null];
      assert.deepEqual(checkWinner(partialBoard), {
        winner: null,
        line: null,
        isDraw: false
      });
    });
  });

  describe('playMove() - immutability and transitions', () => {
    it('immutably updates board and alternates turn', () => {
      const initialState = init();
      const frozenBoard = [...initialState.board];
      Object.freeze(initialState.board);
      Object.freeze(initialState);

      const nextState = playMove(initialState, 4);

      assert(!(nextState instanceof Error));
      assert.notEqual(nextState, initialState);
      assert.equal(initialState.board[4], null);
      assert.equal(nextState.board[4], 'X');
      assert.equal(nextState.turn, 'O');
      assert.equal(nextState.status, 'IN_PROGRESS');
      assert.equal(nextState.winner, null);
      assert.equal(nextState.winningLine, null);
    });

    it('correctly records a WIN and increments winner score', () => {
      // Setup state where X is about to win at index 2
      const state = {
        board: ['X', 'X', null, 'O', 'O', null, null, null, null],
        turn: 'X',
        status: 'IN_PROGRESS',
        winner: null,
        winningLine: null,
        scores: { X: 1, O: 2, draws: 0 }
      };

      const nextState = playMove(state, 2);

      assert(!(nextState instanceof Error));
      assert.equal(nextState.status, 'WIN');
      assert.equal(nextState.winner, 'X');
      assert.deepEqual(nextState.winningLine, [0, 1, 2]);
      assert.equal(nextState.scores.X, 2);
      assert.equal(nextState.scores.O, 2);
      assert.equal(nextState.scores.draws, 0);
    });

    it('correctly records a DRAW and increments draws score', () => {
      // 8 cells filled, 9th will make it a draw
      // X O X
      // X X O
      // O X [ ] -> fill index 8 with O
      const state = {
        board: ['X', 'O', 'X', 'X', 'X', 'O', 'O', 'X', null],
        turn: 'O',
        status: 'IN_PROGRESS',
        winner: null,
        winningLine: null,
        scores: { X: 0, O: 0, draws: 0 }
      };

      const nextState = playMove(state, 8);

      assert(!(nextState instanceof Error));
      assert.equal(nextState.status, 'DRAW');
      assert.equal(nextState.winner, null);
      assert.equal(nextState.winningLine, null);
      assert.equal(nextState.scores.draws, 1);
    });

    it('returns an Error when playing on an occupied cell', () => {
      const state = init();
      const move1 = playMove(state, 0);
      assert(!(move1 instanceof Error));

      const move2 = playMove(move1, 0);
      assert(move2 instanceof Error);
      assert.match(move2.message, /already occupied/);
    });

    it('returns an Error when index is invalid or out of bounds', () => {
      const state = init();
      assert(playMove(state, -1) instanceof Error);
      assert(playMove(state, 9) instanceof Error);
      assert(playMove(state, 3.5) instanceof Error);
      assert(playMove(state, '0') instanceof Error);
    });

    it('returns an Error when game is already finished', () => {
      const state = {
        board: ['X', 'X', 'X', 'O', 'O', null, null, null, null],
        turn: 'O',
        status: 'WIN',
        winner: 'X',
        winningLine: [0, 1, 2],
        scores: { X: 1, O: 0, draws: 0 }
      };

      const result = playMove(state, 5);
      assert(result instanceof Error);
      assert.match(result.message, /already finished/);
    });
  });

  describe('getBestMove() - Minimax AI', () => {
    it('takes an immediate winning move', () => {
      // AI is O; AI has [0] and [1], can win at [2]
      const board = [
        'O', 'O', null,
        'X', 'X', null,
        null, null, null
      ];
      const bestMove = getBestMove(board, 'O');
      assert.equal(bestMove, 2);
    });

    it('blocks an immediate winning move of the opponent', () => {
      // Human is X; X has [0] and [1], AI (O) must block at [2]
      const board = [
        'X', 'X', null,
        'O', null, null,
        null, null, null
      ];
      const bestMove = getBestMove(board, 'O');
      assert.equal(bestMove, 2);
    });

    it('prioritizes winning over blocking', () => {
      // AI (O) has [0, 1, _] to win.
      // Human (X) has [3, 4, _] to win.
      // AI should pick 2 to win immediately!
      const board = [
        'O', 'O', null,
        'X', 'X', null,
        null, null, null
      ];
      const bestMove = getBestMove(board, 'O');
      assert.equal(bestMove, 2);
    });

    it('minimax tie: AI vs AI self-play from initial board always ends in a DRAW', () => {
      let state = init();
      let turnsCount = 0;

      while (state.status === 'IN_PROGRESS' && turnsCount < 9) {
        const move = getBestMove(state.board, state.turn);
        assert.notEqual(move, -1, 'Should always find a valid move');
        assert.equal(state.board[move], null, 'Move must be on an empty cell');
        const nextState = playMove(state, move);
        assert(!(nextState instanceof Error));
        state = nextState;
        turnsCount++;
      }

      assert.equal(state.status, 'DRAW', 'Minimax self-play must result in a DRAW');
      assert.equal(state.winner, null);
      assert.equal(state.board.every(c => c !== null), true);
    });

    it('minimax as player O never loses against any first move by player X', () => {
      // Test all 9 possible first moves by X
      for (let firstMove = 0; firstMove < 9; firstMove++) {
        let state = init();
        // X plays firstMove
        state = playMove(state, firstMove);

        // O uses minimax, X uses minimax for remaining moves to simulate optimal play
        while (state.status === 'IN_PROGRESS') {
          const move = getBestMove(state.board, state.turn);
          state = playMove(state, move);
          assert(!(state instanceof Error));
        }

        // Minimax as O must never allow X to win
        assert.notEqual(state.winner, 'X', `X should never win when O uses minimax (starting move: ${firstMove})`);
      }
    });
  });
});
