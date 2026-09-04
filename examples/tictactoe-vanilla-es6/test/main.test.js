import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal browser-like DOM environment for Node testing of main.js
class MockClassList {
  constructor() {
    this._classes = new Set();
  }
  add(...names) {
    names.forEach(n => this._classes.add(n));
  }
  remove(...names) {
    names.forEach(n => this._classes.delete(n));
  }
  contains(name) {
    return this._classes.has(name);
  }
  toString() {
    return Array.from(this._classes).join(' ');
  }
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new MockClassList();
    this.textContent = '';
    this.disabled = false;
    this.type = '';
    this.eventListeners = {};
    this.id = '';
  }

  get className() {
    return Array.from(this.classList._classes).join(' ');
  }

  set className(val) {
    this.classList._classes.clear();
    String(val).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(event, handler) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(handler);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const handlers = this.eventListeners[event.type] || [];
    for (const handler of handlers) {
      handler(event);
    }
    if (this.parentElement && event.bubbles !== false) {
      this.parentElement.dispatchEvent(event);
    }
  }

  closest(selector) {
    if (selector === '[data-idx]' && this.dataset && this.dataset.idx !== undefined) {
      return this;
    }
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (selector === '.cell' && child.classList.contains('cell')) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get innerHTML() {
    return '';
  }
  set innerHTML(val) {
    if (val === '') {
      this.children = [];
    }
  }
}

// Setup global window and document
const elementsById = new Map();

global.document = {
  readyState: 'complete',
  createElement(tagName) {
    return new MockElement(tagName);
  },
  getElementById(id) {
    return elementsById.get(id) || null;
  },
  querySelectorAll(selector) {
    const results = [];
    for (const el of elementsById.values()) {
      results.push(...el.querySelectorAll(selector));
    }
    return results;
  },
  addEventListener() {}
};

global.window = global;

// Dynamically import main.js after mocking document
const mainModule = await import('../main.js');

describe('main.js - DOM Binding and Loop', () => {
  let gridEl;
  let statusEl;
  let winLineEl;
  let resetBtn;
  let scoreXEl;
  let scoreOEl;
  let scoreDrawsEl;

  beforeEach(() => {
    elementsById.clear();

    gridEl = new MockElement('div');
    gridEl.id = 'grid';
    elementsById.set('grid', gridEl);

    statusEl = new MockElement('div');
    statusEl.id = 'status';
    elementsById.set('status', statusEl);

    winLineEl = new MockElement('line');
    winLineEl.id = 'win-line';
    elementsById.set('win-line', winLineEl);

    resetBtn = new MockElement('button');
    resetBtn.id = 'reset';
    elementsById.set('reset', resetBtn);

    scoreXEl = new MockElement('span');
    scoreXEl.id = 'score-x';
    elementsById.set('score-x', scoreXEl);

    scoreOEl = new MockElement('span');
    scoreOEl.id = 'score-o';
    elementsById.set('score-o', scoreOEl);

    scoreDrawsEl = new MockElement('span');
    scoreDrawsEl.id = 'score-draws';
    elementsById.set('score-draws', scoreDrawsEl);

    const modeAiBtn = new MockElement('button');
    modeAiBtn.id = 'mode-ai';
    elementsById.set('mode-ai', modeAiBtn);

    const modePvpBtn = new MockElement('button');
    modePvpBtn.id = 'mode-pvp';
    elementsById.set('mode-pvp', modePvpBtn);

    mainModule.mount(gridEl);
    mainModule.setupEventListeners();
    mainModule.setMode('pvp'); // Use pvp for deterministic sync testing
  });

  it('mount() creates 9 button cells with data-idx 0..8', () => {
    const cells = gridEl.querySelectorAll('.cell');
    assert.equal(cells.length, 9);
    cells.forEach((cell, idx) => {
      assert.equal(cell.dataset.idx, String(idx));
      assert.equal(cell.getAttribute('role'), 'gridcell');
    });
  });

  it('render() syncs board state, disabled attributes, and status', () => {
    const testState = {
      board: ['X', null, 'O', null, null, null, null, null, null],
      turn: 'X',
      status: 'IN_PROGRESS',
      winner: null,
      winningLine: null,
      scores: { X: 1, O: 2, draws: 0 }
    };

    mainModule.render(testState);

    const cells = gridEl.querySelectorAll('.cell');
    assert.equal(cells[0].textContent, 'X');
    assert.equal(cells[0].disabled, true);
    assert.equal(cells[0].getAttribute('data-cell'), 'X');

    assert.equal(cells[1].textContent, '');
    assert.equal(cells[1].disabled, false);

    assert.equal(cells[2].textContent, 'O');
    assert.equal(cells[2].disabled, true);
    assert.equal(cells[2].getAttribute('data-cell'), 'O');

    assert.equal(statusEl.textContent, "Player X's Turn");
    assert.equal(scoreXEl.textContent, '1');
    assert.equal(scoreOEl.textContent, '2');
  });

  it('render() highlights winning cells and updates win-line SVG coordinates', () => {
    const winState = {
      board: ['X', 'X', 'X', 'O', 'O', null, null, null, null],
      turn: 'O',
      status: 'WIN',
      winner: 'X',
      winningLine: [0, 1, 2],
      scores: { X: 1, O: 0, draws: 0 }
    };

    mainModule.render(winState);

    const cells = gridEl.querySelectorAll('.cell');
    assert.equal(cells[0].classList.contains('winning-cell'), true);
    assert.equal(cells[1].classList.contains('winning-cell'), true);
    assert.equal(cells[2].classList.contains('winning-cell'), true);
    assert.equal(cells[3].classList.contains('winning-cell'), false);

    assert.equal(statusEl.textContent, '🎉 Player X Wins!');
    assert.equal(winLineEl.classList.contains('active'), true);
    assert.notEqual(winLineEl.getAttribute('x1'), '0');
  });

  it('handleClick() guards if cell is already occupied or game is won', () => {
    mainModule.handleReset();
    const cells = gridEl.querySelectorAll('.cell');

    // Click cell 0
    mainModule.handleClick({
      target: cells[0],
      closest: (sel) => (sel === '[data-idx]' ? cells[0] : null)
    });

    assert.equal(cells[0].textContent, 'X');

    // Clicking cell 0 again should do nothing (guarded)
    mainModule.handleClick({
      target: cells[0],
      closest: (sel) => (sel === '[data-idx]' ? cells[0] : null)
    });

    assert.equal(cells[0].textContent, 'X');
  });

  it('handleReset() resets board and clears winning line', () => {
    const winState = {
      board: ['X', 'X', 'X', null, null, null, null, null, null],
      turn: 'O',
      status: 'WIN',
      winner: 'X',
      winningLine: [0, 1, 2],
      scores: { X: 1, O: 0, draws: 0 }
    };

    mainModule.render(winState);
    assert.equal(winLineEl.classList.contains('active'), true);

    mainModule.handleReset();
    assert.equal(winLineEl.classList.contains('active'), false);
    const cells = gridEl.querySelectorAll('.cell');
    assert.equal(cells.every(c => c.textContent === ''), true);
  });

  it('in AI mode, AI responds automatically after player move', async () => {
    mainModule.setMode('ai');
    mainModule.handleReset();
    const cells = gridEl.querySelectorAll('.cell');

    // Player X plays center (index 4)
    mainModule.handleClick({
      target: cells[4],
      closest: (sel) => (sel === '[data-idx]' ? cells[4] : null)
    });

    assert.equal(cells[4].textContent, 'X');

    // Wait for AI setTimeout (200ms)
    await new Promise((resolve) => setTimeout(resolve, 250));

    // After AI turn, there should be an 'O' on the board
    const oCells = cells.filter(c => c.textContent === 'O');
    assert.equal(oCells.length, 1, 'AI should have played exactly one move');
  });
});
