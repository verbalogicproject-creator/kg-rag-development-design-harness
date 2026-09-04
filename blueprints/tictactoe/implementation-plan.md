# Tic-Tac-Toe (vanilla ES6, unbeatable AI)

> A dependency-free browser tic-tac-toe with a pure rules engine and an unbeatable minimax opponent.

**Audience** Mobile and desktop browser users playing offline  
**Scope class** architectural  
**Format** aose-blueprint/v2  
**Generated** 2026-09-04T22:24:05.212Z

## Success criteria

- WHEN a player selects an empty cell THE SYSTEM SHALL place their mark and pass the turn to the other player.
- WHEN a player selects an occupied cell THE SYSTEM SHALL reject the move and leave the board unchanged.
- WHEN three marks of one player align THE SYSTEM SHALL declare that player the winner and highlight the winning line.
- WHEN the board fills with no alignment THE SYSTEM SHALL declare a draw.
- WHILE the opponent is the computer THE SYSTEM SHALL never lose a game.

## Non-goals

- Online or networked multiplayer
- Accounts, persistence across sessions, or a backend

## Constitution

| Article | Rule | Enforced by |
| --- | --- | --- |
| **ART-01** Immutable transitions | Domain state objects are never mutated in place; a transition returns a new object. | review |
| **ART-02** Errors are values | A state transition reports failure by returning a discriminated result or an Error value, never by throwing. | lint |
| **ART-03** Pure core | The game engine performs no DOM access, no I/O and no network calls. | review |
| **ART-04** Every scenario is a named test | Each verification scenario maps to exactly one test whose name matches the scenario's test_name. | gate |
| **ART-05** No runtime dependencies | The shipped game runs from static files with no package installation. | review |

## Architecture

Build order (dependencies first): `core/engine` → `ui/client`

| Domain | Responsibility | Depends on | Exports |
| --- | --- | --- | --- |
| `core/engine` | Deterministic pure state transitions, win detection and minimax search. No I/O, no DOM. | — | `LINES`, `init`, `checkWinner`, `playMove`, `getBestMove` |
| `ui/client` | Render engine state to the DOM, bind player input, drive the AI turn. | `core/engine` | `mount`, `render`, `handleClick`, `handleReset` |

## Decisions

- **DEC-01** Keep the rules engine independent of the DOM and expose it as pure functions.
  - Why: A pure engine is deterministically testable without a browser and can be reused directly by the minimax search.
  - Rejected: Couple rules to DOM event handlers
- **DEC-02** Contracts declare preconditions and postconditions, not just signatures.
  - Why: Generating preconditions alongside postconditions measurably reduces verifier false alarms, so both are required of every contract.
  - Rejected: Postconditions only; Prose descriptions only
  - Source: https://arxiv.org/abs/2510.12702 (verified)
- **DEC-03** Represent the board as a flat 9-cell array with a constant table of the eight winning lines.
  - Why: It removes index arithmetic from win detection, which is where hand-written implementations usually drop a diagonal.
  - Rejected: 3x3 nested array; Bitboards

## Domain `core/engine`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN a move targets an empty cell on an unfinished board THE SYSTEM SHALL return a new state with that cell marked and the turn passed to the other player. | SC-01 |
| REQ-02 | WHEN a move targets an occupied cell, an out-of-range index, or a finished game THE SYSTEM SHALL return an Error and leave the input state unchanged. | SC-02, SC-03, SC-04 |
| REQ-03 | WHEN three cells of one player align THE SYSTEM SHALL report that player as the winner together with the aligned line. | SC-05, SC-06 |
| REQ-04 | WHEN every cell is filled and no line aligns THE SYSTEM SHALL report a draw. | SC-07 |
| REQ-05 | WHILE selecting a move for the computer THE SYSTEM SHALL choose an outcome no worse than a draw against every reply. | SC-08, SC-09, SC-10 |

### Types

```ts
type Player = 'X' | 'O';
type Cell = Player | null;
type Board = Cell[];                       // exactly 9 entries, indices 0..8
type GameStatus = 'IN_PROGRESS' | 'WIN' | 'DRAW';
type Line = [number, number, number];
interface Scores { X: number; O: number; draws: number }
interface State {
  readonly board: Board;
  readonly turn: Player;
  readonly status: GameStatus;
  readonly winner: Player | null;
  readonly winningLine: Line | null;
  readonly scores: Scores;
}
interface WinCheck { winner: Player | null; line: Line | null; isDraw: boolean }
```

### Contracts

- `init(scores: Scores): State` (query)
  - pre: Scores are non-negative integers, or omitted to start at zero.
  - post: Returns an empty board, turn 'X', status 'IN_PROGRESS', no winner and the supplied scores carried forward.
- `checkWinner(board: Board): WinCheck` (query)
  - pre: Board has exactly 9 cells.
  - post: Returns the winner and the aligned line when one of the eight lines is uniformly marked, otherwise isDraw is true only when no cell is null.
- `playMove(state: State, index: number): State | Error` (transition)
  - pre: 0 <= index <= 8, state.board[index] is null, and state.status is 'IN_PROGRESS'.
  - post: Returns a new State with the cell marked, the turn alternated, status and winner recomputed and the score incremented on a terminal result. The input state is never mutated. Returns an Error whose message names the violated precondition when the move is illegal.
- `getBestMove(board: Board, aiPlayer: Player): number` (query)
  - pre: Board has at least one empty cell and the game is not already won.
  - post: Returns the index of a move that is optimal under minimax with a depth penalty, so a faster win is preferred to a slower one.
  - algorithm: minimax over the flat board, terminal scoring +10 for the AI, -10 for the opponent, 0 for a draw, each reduced by search depth

### Verification

Suite: `test/engine.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | an empty board | X plays a legal cell | a new state is returned with the cell marked, the turn passed to O, and the original state untouched | `immutably updates board and alternates turn` |
| SC-02 | a board with a marked cell | a move targets that cell | an Error is returned | `returns an Error when playing on an occupied cell` |
| SC-03 | any board | a move targets an index outside 0..8 | an Error is returned | `returns an Error when index is invalid or out of bounds` |
| SC-04 | a finished game | any further move is attempted | an Error is returned | `returns an Error when game is already finished` |
| SC-05 | each of the eight winning lines in turn | the line is completed | the winner and that line are reported and the winner's score increments | `correctly records a WIN and increments winner score` |
| SC-06 | the constant line table | it is inspected | all eight rows, columns and diagonals are present | `should define all 8 winning line combinations` |
| SC-07 | a full board with no aligned line | the final move is played | the status is DRAW and the draw counter increments | `correctly records a DRAW and increments draws score` |
| SC-08 | a board where the AI can win this turn | the best move is computed | the winning cell is chosen | `takes an immediate winning move` |
| SC-09 | a board where the opponent would win next turn | the best move is computed | the threatening cell is taken | `blocks an immediate winning move of the opponent` |
| SC-10 | an empty board | the AI plays itself to completion | the game always ends in a draw | `minimax tie: AI vs AI self-play from initial board always ends in a DRAW` |

### Task

Deliverables: `engine.js`, `test/engine.test.js`

Gate: `node --test test/engine.test.js` — Exit code 0 with one passing test per verification scenario, each named exactly as the scenario's test_name.

## Domain `ui/client`

### Requirements

| Id | Requirement (EARS) | Verified by |
| --- | --- | --- |
| REQ-01 | WHEN the client mounts THE SYSTEM SHALL create nine addressable cell controls indexed 0 to 8. | SC-01 |
| REQ-02 | WHEN engine state changes THE SYSTEM SHALL render the board, the turn indicator and the disabled state of every cell from that state alone. | SC-02 |
| REQ-03 | WHEN a game ends in a win THE SYSTEM SHALL highlight the three winning cells. | SC-03 |
| REQ-04 | IF a click targets an occupied cell or a finished game THE SYSTEM SHALL ignore it. | SC-04 |
| REQ-05 | WHILE the opponent is the computer THE SYSTEM SHALL play the computer's reply after the player's move. | SC-05 |
| REQ-06 | WHEN the player resets THE SYSTEM SHALL clear the board and any winning-line highlight while keeping the running scores. | SC-06 |

### Types

```ts
type Mode = 'ai' | 'pvp';
type RenderResult = { ok: true } | { ok: false; error: 'NOT_MOUNTED' };
interface ClientState { mode: Mode; mounted: boolean }
```

### Contracts

- `mount(root: HTMLElement): RenderResult` (transition)
  - pre: root is an element present in the document and not already mounted.
  - post: Nine button cells carrying data-idx 0..8 exist under root and input handlers are bound. Returns an error result when root is absent.
  - errors: NOT_MOUNTED
- `render(state: State): RenderResult` (transition)
  - pre: The client is mounted and state is a valid engine State.
  - post: Every cell's text, disabled flag and winning-cell class, plus the status line, match the supplied state exactly. Nothing is read from the DOM to decide what to draw.
  - errors: NOT_MOUNTED
- `handleClick(event: Event): void` (query)
  - pre: The event originates from a mounted cell control.
  - post: A legal move advances the engine and re-renders; an illegal move changes nothing. In AI mode the computer's reply follows.
- `handleReset(): void` (query)
  - pre: The client is mounted.
  - post: The board returns to the initial state with scores preserved and any winning-line highlight cleared.

### Verification

Suite: `test/main.test.js`

| Id | Given | When | Then | Test name |
| --- | --- | --- | --- | --- |
| SC-01 | a fresh root element | the client mounts | nine cells numbered 0 to 8 exist | `mount() creates 9 button cells with data-idx 0..8` |
| SC-02 | an arbitrary engine state | it is rendered | cell text, disabled flags and the status line match that state | `render() syncs board state, disabled attributes, and status` |
| SC-03 | a won game | it is rendered | the three winning cells are highlighted | `render() highlights winning cells and updates win-line SVG coordinates` |
| SC-04 | an occupied cell or a finished game | the cell is clicked | nothing changes | `handleClick() guards if cell is already occupied or game is won` |
| SC-05 | AI mode after the player moves | the turn passes | the computer plays its reply | `in AI mode, AI responds automatically after player move` |
| SC-06 | a board mid-game | reset is triggered | the board clears and the winning line is removed | `handleReset() resets board and clears winning line` |

### Task

Deliverables: `main.js`, `index.html`, `style.css`, `test/main.test.js`

Gate: `node --test test/main.test.js` — Exit code 0 with one passing test per verification scenario, using a DOM double rather than a real browser.

## Research ledger

| Source | Claim | Confidence | Verification |
| --- | --- | --- | --- |
| [Beyond Postconditions: Can Large Language Models Infer Formal Contracts from Natural Language?](https://arxiv.org/abs/2510.12702) | Generating preconditions alongside postconditions reduces false alarms when the resulting contracts are checked by a verifier. | medium | verified |
