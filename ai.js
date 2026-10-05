// カワレの CPU（Web Worker）。negamax + αβ + 反復深化 + 置換表（最強のみ）。
// 盤は長さ 16 の配列、各マスは石の山（配列、下から上。1=中立 2=プレイヤー1 3=プレイヤー2）。main.js と同じ表し方。

const LINES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
  [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
  [0, 5, 10, 15], [3, 6, 9, 12],
];
function neighborsOf(i) {
  const r = (i / 4) | 0, c = i % 4, out = [];
  if (r > 0) out.push(i - 4);
  if (r < 3) out.push(i + 4);
  if (c > 0) out.push(i - 1);
  if (c < 3) out.push(i + 1);
  return out;
}
const NEI = Array.from({ length: 16 }, (_, i) => neighborsOf(i));
const WIN = 100000;
const TIMEOUT = {};

function topColor(stack) { return stack.length ? stack[stack.length - 1] : 0; }
function someWin(board, color) { return LINES.some((line) => line.every((i) => topColor(board[i]) === color)); }
function cloneBoard(b) { return b.map((s) => s.slice()); }
function boardKey(b) { return b.map((s) => s.join('.')).join('|'); }
function moveKey(mv) { return mv.origin + '/' + mv.path.join(','); }

// 山を 1 つ選んで配り直す手を全列挙し、同じ結果の盤面になる手は 1 つにまとめる。
// 山が高いと道の数が 3^(n-1) で増えるので、1 つの山あたり数で打ち切る
// （ponytail: 現実の対局では起きにくい極端な積み上げのときだけ漏れうる。気になれば MAX_PATHS を上げる）。
const MAX_PATHS = 4000;
function genMovesForOrigin(board, origin, color) {
  const n = board[origin].length + 1;
  const taken = board[origin].concat(color);
  const seen = new Map();
  let count = 0;
  const path = [];
  function rec(prev, cur) {
    if (count >= MAX_PATHS) return;
    if (path.length === n) {
      count++;
      const nb = cloneBoard(board);
      nb[origin] = [];
      path.forEach((cell, idx) => nb[cell].push(taken[idx]));
      const key = boardKey(nb);
      if (!seen.has(key)) seen.set(key, { path: path.slice(), board: nb });
      return;
    }
    for (const nb2 of NEI[cur]) {
      if (nb2 === prev) continue;
      path.push(nb2);
      rec(cur, nb2);
      path.pop();
      if (count >= MAX_PATHS) return;
    }
  }
  rec(null, origin);
  return [...seen.values()].map((v) => ({ origin, path: v.path, board: v.board }));
}
function genMoves(board, color) {
  const moves = [];
  for (let i = 0; i < 16; i++) if (board[i].length > 0) moves.push(...genMovesForOrigin(board, i, color));
  return moves;
}
function findImmediateWin(moves, turn) {
  const moverColor = turn + 1;
  return moves.find((mv) => someWin(mv.board, moverColor)) || null;
}

// 素直な評価: 相手の色が乗っていない線ほど、自分の見える石の数に応じて点を足す（4 つ目は勝ちなので別扱い済み）。
// 積まれて隠れている自分の石は、あとで表に出てきうるので軽く加点する。
const WEIGHT = { 1: 1, 2: 4, 3: 16 };
const HIDDEN_BONUS = 0.3;
function evaluate(board, turn) {
  const mine = turn + 1, opp = turn === 1 ? 3 : 2;
  let score = 0;
  for (const line of LINES) {
    let m = 0, o = 0;
    for (const i of line) {
      const t = topColor(board[i]);
      if (t === mine) m++; else if (t === opp) o++;
    }
    if (o === 0 && m > 0) score += WEIGHT[m] || 0;
    if (m === 0 && o > 0) score -= WEIGHT[o] || 0;
  }
  for (let c = 0; c < 16; c++) {
    const st = board[c];
    for (let i = 0; i < st.length - 1; i++) {
      if (st[i] === mine) score += HIDDEN_BONUS;
      else if (st[i] === opp) score -= HIDDEN_BONUS;
    }
  }
  return score;
}

let nodes = 0;
// turn の番として最善手を探す。返り値は turn から見た評価値と、たどり着いた最善の手。
function search(board, hands, turn, depth, alpha, beta, ply, deadline, tt) {
  if ((++nodes & 255) === 0 && performance.now() > deadline) throw TIMEOUT;

  const key = turn + '#' + hands.join(',') + '#' + boardKey(board);
  const entry = tt.get(key);
  let ttMoveKey = null;
  if (entry) {
    ttMoveKey = entry.moveKey;
    if (entry.depth >= depth) {
      if (entry.flag === 0) return { value: entry.value, move: entry.move };
      if (entry.flag === 1 && entry.value >= beta) return { value: entry.value, move: entry.move };
      if (entry.flag === 2 && entry.value <= alpha) return { value: entry.value, move: entry.move };
    }
  }

  const moverColor = turn + 1, oppColor = turn === 1 ? 3 : 2;
  const moves = genMoves(board, moverColor).map((mv) => {
    const w1 = someWin(mv.board, 2), w2 = someWin(mv.board, 3);
    const movingWin = (moverColor === 2 && w1) || (moverColor === 3 && w2);
    const oppWin = (oppColor === 2 && w1) || (oppColor === 3 && w2);
    const score = movingWin ? 1e9 : oppWin ? -1e9 : evaluate(mv.board, turn);
    return { mv, w1, w2, score, key: moveKey(mv) };
  });
  // 並べ替え: 置換表の最善手 → 即勝ち・評価の高い順（相手の即勝ちになる手は最後）
  moves.sort((a, b) => (b.key === ttMoveKey) - (a.key === ttMoveKey) || b.score - a.score);

  const a0 = alpha;
  let best = -Infinity, bestMove = null, bestKey = null;
  for (const { mv, w1, w2 } of moves) {
    const nh = hands.slice();
    nh[turn - 1]--;
    let val;
    if (w1 && w2) val = WIN - ply; // 両方同時に揃ったら、手を指した側（turn）の勝ち
    else if ((turn === 1 && w1) || (turn === 2 && w2)) val = WIN - ply;
    else if (w1 || w2) val = -(WIN - ply); // 相手の色だけ揃ってしまった
    else if (nh[0] === 0 && nh[1] === 0) val = 0; // 両者置き終えて引き分け
    else if (depth <= 1) val = evaluate(mv.board, turn);
    else val = -search(mv.board, nh, turn === 1 ? 2 : 1, depth - 1, -beta, -alpha, ply + 1, deadline, tt).value;

    if (val > best) { best = val; bestMove = mv; bestKey = moveKey(mv); }
    if (val > alpha) alpha = val;
    if (alpha >= beta) break;
  }
  tt.set(key, { depth, value: best, flag: best <= a0 ? 2 : best >= beta ? 1 : 0, move: bestMove, moveKey: bestKey });
  return { value: best, move: bestMove };
}

export function bestMove(board, hands, turn, strength) {
  nodes = 0;
  const moves = genMoves(board, turn + 1);
  if (!moves.length) return null;

  if (strength === 'weak') {
    return findImmediateWin(moves, turn) || moves[(Math.random() * moves.length) | 0];
  }

  const tt = new Map();
  if (strength === 'mid') {
    const deadline = performance.now() + 1300;
    try {
      const r = search(board, hands, turn, 3, -Infinity, Infinity, 0, deadline, tt);
      if (r.move) return r.move;
    } catch (e) { if (e !== TIMEOUT) throw e; }
    return findImmediateWin(moves, turn) || moves[(Math.random() * moves.length) | 0];
  }

  // 最強: 時間の許す限り反復深化。残り手数まで読み切ったら、それ以上深くしない
  const remain = hands[0] + hands[1];
  const deadline = performance.now() + 2800;
  let best = null;
  for (let depth = 1; depth <= remain; depth++) {
    try {
      const r = search(board, hands, turn, depth, -Infinity, Infinity, 0, deadline, tt);
      if (r.move) best = r.move;
      if (r.move && Math.abs(r.value) >= WIN - 30) break; // 勝ち負けが確定
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
  return best || findImmediateWin(moves, turn) || moves[0];
}

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => {
    const { id, board, hands, turn, strength } = e.data;
    const mv = bestMove(board, hands, turn, strength);
    self.postMessage({ id, origin: mv.origin, path: mv.path });
  };
}
