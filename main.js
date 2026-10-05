'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'qawale.' で始める。
const STORE = 'qawale.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'qawale', text: '山をくずして自分の色を並べる、Gigamic『Kawale』風の対戦パズル。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- ここからアプリ本体 ----
//
// カワレ: 4×4 の盤。各マスは石の山（配列、下から上）。
// 石の値: 1 = 中立（初期配置）、2 = プレイヤー1、3 = プレイヤー2。
// 手番: 山を 1 つ選び、自分の石を積んでから山ごと手に取り、一番下から順に隣へ配り直す
// （直前に来たマスへすぐ戻るのは禁止）。上から見える色が縦横斜め 4 つ揃えば勝ち。

const LINES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
  [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
  [0, 5, 10, 15], [3, 6, 9, 12],
];
const CORNERS = [0, 3, 12, 15];
function neighborsOf(i) {
  const r = (i / 4) | 0, c = i % 4, out = [];
  if (r > 0) out.push(i - 4);
  if (r < 3) out.push(i + 4);
  if (c > 0) out.push(i - 1);
  if (c < 3) out.push(i + 1);
  return out;
}
const NEI = Array.from({ length: 16 }, (_, i) => neighborsOf(i));

function initialBoard() {
  const board = Array.from({ length: 16 }, () => []);
  CORNERS.forEach((c) => { board[c] = [1, 1]; });
  return board;
}
function topColor(stack) { return stack.length ? stack[stack.length - 1] : 0; }
function winningLines(board, color) {
  return LINES.filter((line) => line.every((i) => topColor(board[i]) === color));
}

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面
let thinking = false;

function newGame(mode, strength, humanPlayer) {
  G = {
    mode, strength,
    humanPlayer: humanPlayer || 1,
    board: initialBoard(),
    hands: [8, 8],
    turn: 1,
    winner: null,
    winLines: [],
    sel: null, // { origin, taken, path, prev, cur } 置いている最中の状態
  };
  thinking = false;
  render();
  maybeCpuTurn();
}

function playerLabel(p) {
  if (p === 'draw') return '引き分け';
  if (G.mode === 'cpu') return p === G.humanPlayer ? 'あなた' : 'CPU';
  return p === 1 ? '1人目' : '2人目';
}
function isCpuTurn() { return G.mode === 'cpu' && G.turn !== G.humanPlayer; }
function canInteract() { return !G.winner && !thinking && !isCpuTurn(); }

// ---- 1 手の進行 ----
function startPickup(origin) {
  const color = G.turn + 1;
  G.sel = { origin, taken: G.board[origin].concat(color), path: [], prev: null, cur: origin };
  G.board[origin] = [];
}
function cancelPickup() {
  G.board[G.sel.origin] = G.sel.taken.slice(0, -1); // 積んだ自分の石も外して元に戻す
  G.sel = null;
}
function isLegalTarget(i) {
  return !!G.sel && NEI[G.sel.cur].includes(i) && i !== G.sel.prev;
}
function placeNext(target) {
  const { taken, path } = G.sel;
  G.board[target].push(taken[path.length]);
  path.push(target);
  G.sel.prev = G.sel.cur;
  G.sel.cur = target;
  if (path.length === taken.length) finishMove();
}
function finishMove() {
  const mover = G.turn;
  G.hands[mover - 1]--;
  G.sel = null;
  const lines1 = winningLines(G.board, 2);
  const lines2 = winningLines(G.board, 3);
  if (lines1.length && lines2.length) { G.winner = mover; G.winLines = mover === 1 ? lines1 : lines2; }
  else if (lines1.length) { G.winner = 1; G.winLines = lines1; }
  else if (lines2.length) { G.winner = 2; G.winLines = lines2; }
  else if (G.hands[0] === 0 && G.hands[1] === 0) { G.winner = 'draw'; }
  else { G.turn = mover === 1 ? 2 : 1; }
  render();
  maybeCpuTurn();
}

function onCellTap(i) {
  if (!canInteract()) return;
  if (!G.sel) {
    if (G.board[i].length === 0) return; // 空のマスは選べない
    startPickup(i);
    render();
    return;
  }
  if (G.sel.path.length === 0 && i === G.sel.origin) { cancelPickup(); render(); return; }
  if (!isLegalTarget(i)) return;
  placeNext(i);
  render();
}

// ---- CPU（ai.js を Worker で動かす） ----
const cpu = new Worker('./ai.js', { type: 'module' });
let cpuAsk = 0; // やり直したあとに前の局の答えが届いても使わない
function maybeCpuTurn() {
  if (!G || G.winner || !isCpuTurn()) return;
  thinking = true;
  render();
  const game = G;
  const id = ++cpuAsk;
  cpu.onmessage = (e) => {
    if (e.data.id !== cpuAsk || G !== game) return;
    thinking = false;
    animateCpuMove(e.data.origin, e.data.path);
  };
  cpu.postMessage({ id, board: G.board, hands: G.hands, turn: G.turn, strength: G.strength });
}
function animateCpuMove(origin, path) {
  startPickup(origin);
  render();
  let i = 0;
  const step = () => {
    placeNext(path[i]);
    i++;
    if (G.sel) render(); // 手の途中（まだ続く）。最後は placeNext 内の finishMove が render 済み
    if (i < path.length) setTimeout(step, 250);
  };
  setTimeout(step, 250);
}

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
  bindGame();
}

function titleHTML() {
  return `
    <div class="title">
      <h2>カワレ</h2>
      <p class="hint">山を選んで自分の石を積み、山ごと配り直す。上から見える自分の色が 4 つ並んだら勝ち。</p>
      <div class="opts">
        <label>強さ
          <select id="strength">
            <option value="weak">よわい</option>
            <option value="mid" selected>ふつう</option>
            <option value="strong">最強</option>
          </select>
        </label>
        <label>手番
          <select id="order">
            <option value="first">先手</option>
            <option value="second">後手</option>
          </select>
        </label>
      </div>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
    </div>`;
}
function bindTitle() {
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.start;
    const strength = mode === 'cpu' ? document.getElementById('strength').value : null;
    const order = mode === 'cpu' ? document.getElementById('order').value : null;
    newGame(mode, strength, order === 'second' ? 2 : 1);
  }));
}

const COLOR_CLASS = { 0: 'empty', 1: 'n', 2: 'a', 3: 'b' };
function cellHTML(i) {
  const stack = G.board[i];
  const under = stack.slice(0, -1).map((c) => `<span class="chip chip--${COLOR_CLASS[c]}"></span>`).join('');
  const top = stack.length ? `<span class="chip chip--top chip--${COLOR_CLASS[topColor(stack)]}"></span>` : '';
  const cls = ['cell'];
  if (G.sel && G.sel.cur === i) cls.push('cell--cur');
  if (isLegalTarget(i)) cls.push('cell--legal');
  if ((!G.sel) && canInteract() && stack.length > 0) cls.push('cell--pickable');
  if (G.winLines.some((line) => line.includes(i))) cls.push('cell--win');
  return `<button class="${cls.join(' ')}" data-cell="${i}" type="button">
    <span class="cell__height">${stack.length || ''}</span>
    <span class="cell__chips">${under}</span>
    ${top}
  </button>`;
}

function statusText() {
  if (thinking) return 'CPU が考え中…';
  if (G.winner) return G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  if (G.sel) return `${playerLabel(G.turn)} の番：置く先をえらぶ`;
  return `${playerLabel(G.turn)} の番：山をえらぶ`;
}

function gameHTML() {
  const board = [...Array(16).keys()].map(cellHTML).join('');
  const handsRow = `
    <div class="hands">
      <span class="hands__p${G.turn === 1 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--a"></span>${playerLabel(1)} 残り ${G.hands[0]} 個</span>
      <span class="hands__p${G.turn === 2 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--b"></span>${playerLabel(2)} 残り ${G.hands[1]} 個</span>
    </div>`;
  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';
  return `
    <div class="game">
      <p class="status">${statusText()}</p>
      ${handsRow}
      <div class="board${thinking ? ' board--busy' : ''}">${board}</div>
      ${again}
    </div>`;
}

function bindGame() {
  document.querySelectorAll('[data-cell]').forEach((b) => b.addEventListener('click', () => onCellTap(Number(b.dataset.cell))));
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.strength, G.humanPlayer));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();
