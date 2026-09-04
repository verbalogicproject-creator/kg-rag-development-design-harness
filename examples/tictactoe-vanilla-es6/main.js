import { init, playMove, checkWinner, getBestMove } from './engine.js';

/**
 * Global game state
 */
export let state = init();
export let mode = 'ai'; // 'ai' | 'pvp'
export let isAiThinking = false;

// DOM references (resolved on boot)
let gridEl = null;
let statusEl = null;
let winLineEl = null;
let scoreXEl = null;
let scoreOEl = null;
let scoreDrawsEl = null;
let labelXEl = null;
let labelOEl = null;
let resetBtn = null;
let resetScoresBtn = null;
let modeAiBtn = null;
let modePvpBtn = null;

/**
 * Mounts the 9 button cells with data-idx 0..8 into the root element.
 * @param {HTMLElement} root 
 */
export function mount(root) {
  if (!root) return;
  const target = root.id === 'grid' ? root : (root.querySelector('#grid') || root);
  gridEl = target;
  target.innerHTML = '';

  for (let i = 0; i < 9; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cell';
    btn.dataset.idx = String(i);
    btn.setAttribute('role', 'gridcell');
    btn.setAttribute('aria-label', `Cell ${i + 1}, Empty`);
    target.appendChild(btn);
  }
}

/**
 * Synchronizes DOM cells, toggles .winning-cell, updates status text,
 * renders winning SVG line overlay, and updates scores.
 * @param {import('./engine.js').State} currentState 
 */
export function render(currentState = state) {
  state = currentState;

  statusEl = document.getElementById('status');
  winLineEl = document.getElementById('win-line');
  scoreXEl = document.getElementById('score-x');
  scoreOEl = document.getElementById('score-o');
  scoreDrawsEl = document.getElementById('score-draws');

  // 1. Sync Cells
  const cells = gridEl ? gridEl.querySelectorAll('.cell') : document.querySelectorAll('.cell');
  cells.forEach((cell) => {
    const idx = parseInt(cell.dataset.idx, 10);
    const cellValue = state.board[idx];

    cell.textContent = cellValue || '';

    if (cellValue) {
      cell.setAttribute('data-cell', cellValue);
      cell.setAttribute('aria-label', `Cell ${idx + 1}, occupied by ${cellValue}`);
      cell.disabled = true;
    } else {
      cell.removeAttribute('data-cell');
      cell.setAttribute('aria-label', `Cell ${idx + 1}, Empty`);
      cell.disabled = (state.status !== 'IN_PROGRESS' || isAiThinking);
    }

    // Toggle winning cell class
    if (state.winningLine && state.winningLine.includes(idx)) {
      cell.classList.add('winning-cell');
    } else {
      cell.classList.remove('winning-cell');
    }
  });

  // 2. Sync Status Text
  if (statusEl) {
    statusEl.className = '';
    if (state.status === 'WIN') {
      statusEl.classList.add('win');
      if (mode === 'ai') {
        statusEl.textContent = state.winner === 'X' ? '🎉 You Win!' : '🤖 AI Wins!';
      } else {
        statusEl.textContent = `🎉 Player ${state.winner} Wins!`;
      }
    } else if (state.status === 'DRAW') {
      statusEl.classList.add('draw');
      statusEl.textContent = "🤝 It's a Draw!";
    } else {
      if (isAiThinking) {
        statusEl.textContent = '🤖 AI is thinking...';
      } else if (mode === 'ai') {
        statusEl.textContent = state.turn === 'X' ? 'Your Turn (X)' : "AI's Turn (O)";
      } else {
        statusEl.textContent = `Player ${state.turn}'s Turn`;
      }
    }
  }

  // 3. Sync Win-line SVG Overlay
  if (winLineEl) {
    if (state.winningLine) {
      const [a, , c] = state.winningLine;
      const colA = a % 3;
      const rowA = Math.floor(a / 3);
      const colC = c % 3;
      const rowC = Math.floor(c / 3);

      const x1 = colA * 100 + 50;
      const y1 = rowA * 100 + 50;
      const x2 = colC * 100 + 50;
      const y2 = rowC * 100 + 50;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const extend = 35; // Extend line slightly beyond cell centers

      winLineEl.setAttribute('x1', String(x1 - ux * extend));
      winLineEl.setAttribute('y1', String(y1 - uy * extend));
      winLineEl.setAttribute('x2', String(x2 + ux * extend));
      winLineEl.setAttribute('y2', String(y2 + uy * extend));
      winLineEl.classList.add('active');
    } else {
      winLineEl.classList.remove('active');
      winLineEl.setAttribute('x1', '0');
      winLineEl.setAttribute('y1', '0');
      winLineEl.setAttribute('x2', '0');
      winLineEl.setAttribute('y2', '0');
    }
  }

  // 4. Sync Scoreboard
  if (scoreXEl && scoreOEl && scoreDrawsEl) {
    scoreXEl.textContent = String(state.scores.X);
    scoreOEl.textContent = String(state.scores.O);
    scoreDrawsEl.textContent = String(state.scores.draws);
  }
}

/**
 * Handles click on the board cells.
 * Guards if cell is occupied or status != IN_PROGRESS.
 * Plays move, triggers AI turn if single-player, and re-renders.
 * 
 * @param {Event} e 
 */
export function handleClick(e) {
  const cell = e.target.closest('[data-idx]');
  if (!cell) return;

  const index = parseInt(cell.dataset.idx, 10);
  if (Number.isNaN(index)) return;

  // Guard: status must be IN_PROGRESS, cell must be empty, AI must not be thinking
  if (state.status !== 'IN_PROGRESS' || isAiThinking || state.board[index] !== null) {
    return;
  }

  const nextState = playMove(state, index);
  if (nextState instanceof Error) {
    console.error('Move error:', nextState.message);
    return;
  }

  state = nextState;
  render(state);

  // Single-player vs Minimax AI: AI turn
  if (mode === 'ai' && state.status === 'IN_PROGRESS' && state.turn === 'O') {
    isAiThinking = true;
    render(state);

    setTimeout(() => {
      const aiMove = getBestMove(state.board, 'O');
      if (aiMove !== -1) {
        const afterAiState = playMove(state, aiMove);
        if (!(afterAiState instanceof Error)) {
          state = afterAiState;
        }
      }
      isAiThinking = false;
      render(state);
    }, 200);
  }
}

/**
 * Resets the game board retaining scores.
 */
export function handleReset() {
  state = init(state.scores);
  isAiThinking = false;
  render(state);
}

/**
 * Resets all scores to 0.
 */
export function handleResetScores() {
  state = init({ X: 0, O: 0, draws: 0 });
  isAiThinking = false;
  render(state);
}

/**
 * Changes game mode.
 * @param {'ai' | 'pvp'} newMode 
 */
export function setMode(newMode) {
  if (mode === newMode) return;
  mode = newMode;

  if (modeAiBtn && modePvpBtn) {
    if (mode === 'ai') {
      modeAiBtn.classList.add('active');
      modePvpBtn.classList.remove('active');
      if (labelXEl) labelXEl.textContent = 'Player (X)';
      if (labelOEl) labelOEl.textContent = 'AI (O)';
    } else {
      modePvpBtn.classList.add('active');
      modeAiBtn.classList.remove('active');
      if (labelXEl) labelXEl.textContent = 'Player X';
      if (labelOEl) labelOEl.textContent = 'Player O';
    }
  }

  handleReset();
}

/**
 * Sets up all DOM event listeners.
 */
export function setupEventListeners() {
  if (gridEl) {
    gridEl.addEventListener('click', handleClick);
  }

  resetBtn = document.getElementById('reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', handleReset);
  }

  resetScoresBtn = document.getElementById('reset-scores');
  if (resetScoresBtn) {
    resetScoresBtn.addEventListener('click', handleResetScores);
  }

  modeAiBtn = document.getElementById('mode-ai');
  if (modeAiBtn) {
    modeAiBtn.addEventListener('click', () => setMode('ai'));
  }

  modePvpBtn = document.getElementById('mode-pvp');
  if (modePvpBtn) {
    modePvpBtn.addEventListener('click', () => setMode('pvp'));
  }

  labelXEl = document.getElementById('label-x');
  labelOEl = document.getElementById('label-o');
}

/**
 * Initializes and mounts application.
 */
export function initApp() {
  const root = document.getElementById('grid') || document.getElementById('app');
  if (root) {
    mount(root);
    setupEventListeners();
    render(state);
  }
}

// Auto-run in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
