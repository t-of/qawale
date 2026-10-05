// カワレの CPU（Web Worker）。negamax + αβ + 反復深化 + 置換表 + Zobrist ハッシュ（最強のみ）。
// main.js とは長さ16の配列（各マスは石の山の配列。1=中立 2=プレイヤー1 3=プレイヤー2）でやり取りするが、
// 探索中は盤を複製しない。1つのグローバルな「盤」（Uint8Array の山＋高さ＋Zobrist ハッシュ）を
// make/unmake で押し引きしながら使う（Worker は 1 手につき 1 回しか bestMove を呼ばないので安全）。

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

// --- 盤の実体 ---------------------------------------------------------
// 石は全部で 24 個（中立 8 + 各プレイヤー 8）なので、1 マスの山の高さは最大 24。
const CAP = 24;
const stacks = new Uint8Array(16 * CAP); // stacks[cell*CAP + level] = 色（1..3）
const heights = new Uint8Array(16);

function rnd32() { return (Math.random() * 0x100000000) >>> 0; }
// Zobrist: マス × 段 × 色ごとに 32bit を 2 本（衝突を減らす）。手番の違いは別キーで混ぜる。
const ZA = new Uint32Array(16 * CAP * 4);
const ZB = new Uint32Array(16 * CAP * 4);
for (let i = 0; i < ZA.length; i++) { ZA[i] = rnd32(); ZB[i] = rnd32(); }
const TURN_A = [0, rnd32()], TURN_B = [0, rnd32()]; // turn=1→0番、turn=2→1番
function zIdx(cell, level, color) { return (cell * CAP + level) * 4 + color; }

let hashA = 0, hashB = 0; // 今の盤面の Zobrist（手番は混ぜない。置換表を引くときだけ混ぜる）

function topColor(cell) { const h = heights[cell]; return h ? stacks[cell * CAP + h - 1] : 0; }
function someWin(color) {
  for (const line of LINES) {
    let ok = true;
    for (const i of line) { if (topColor(i) !== color) { ok = false; break; } }
    if (ok) return true;
  }
  return false;
}
// マスごとに、それが属する線（最大3本: 縦・横・対角）。手で変わったマスの線だけ見れば勝敗は分かる。
const LINE_OF = Array.from({ length: 16 }, () => []);
LINES.forEach((line, li) => line.forEach((cell) => LINE_OF[cell].push(li)));
const lineMark = new Uint8Array(10);
const touchedLines = new Int8Array(10);
// origin と path で変わったマスに関わる線だけ調べて、2・3 それぞれの勝ちがあるか返す（全10本を見るより軽い）。
function winAffected(originCell, path) {
  let w1 = false, w2 = false, tcount = 0;
  const mark = (cell) => {
    const arr = LINE_OF[cell];
    for (let k = 0; k < arr.length; k++) {
      const li = arr[k];
      if (lineMark[li]) continue;
      lineMark[li] = 1; touchedLines[tcount++] = li;
      const line = LINES[li];
      const t0 = topColor(line[0]);
      if (t0 !== 0 && topColor(line[1]) === t0 && topColor(line[2]) === t0 && topColor(line[3]) === t0) {
        if (t0 === 2) w1 = true; else if (t0 === 3) w2 = true;
      }
    }
  };
  mark(originCell);
  for (let i = 0; i < path.length; i++) mark(path[i]);
  for (let i = 0; i < tcount; i++) lineMark[touchedLines[i]] = 0;
  return { w1, w2 };
}

function pushStone(cell, color) {
  const l = heights[cell];
  stacks[cell * CAP + l] = color;
  heights[cell] = l + 1;
  const zi = zIdx(cell, l, color);
  hashA = (hashA ^ ZA[zi]) >>> 0; hashB = (hashB ^ ZB[zi]) >>> 0;
}
function popStone(cell) {
  const l = heights[cell] - 1;
  const color = stacks[cell * CAP + l];
  const zi = zIdx(cell, l, color);
  hashA = (hashA ^ ZA[zi]) >>> 0; hashB = (hashB ^ ZB[zi]) >>> 0;
  heights[cell] = l;
}
// main.js の配列表現を読み込み、内部状態（高さ・ハッシュ）を作る。
function loadBoard(board) {
  heights.fill(0); hashA = 0; hashB = 0;
  for (let c = 0; c < 16; c++) {
    const st = board[c];
    for (let l = 0; l < st.length; l++) {
      stacks[c * CAP + l] = st[l];
      const zi = zIdx(c, l, st[l]);
      hashA = (hashA ^ ZA[zi]) >>> 0; hashB = (hashB ^ ZB[zi]) >>> 0;
    }
    heights[c] = st.length;
  }
}
// 1 手を適用する: origin の山 + 新しい石(color) を path の順に配る。戻すための taken を返す。
function makeMove(origin, path, color) {
  const ho = heights[origin];
  const n = ho + 1;
  const taken = new Uint8Array(n);
  for (let i = 0; i < ho; i++) taken[i] = stacks[origin * CAP + i];
  taken[ho] = color;
  for (let i = 0; i < ho; i++) popStone(origin); // origin を空にする（ハッシュからも外す）
  for (let i = 0; i < n; i++) pushStone(path[i], taken[i]);
  return taken;
}
function unmakeMove(origin, path, taken) {
  const n = taken.length;
  for (let i = n - 1; i >= 0; i--) popStone(path[i]);
  for (let i = 0; i < n - 1; i++) pushStone(origin, taken[i]);
}
function samePath(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 山を 1 つ選んで配り直す手を全列挙し、同じ結果の盤面になる手は 1 つにまとめる（Zobrist で判定）。
// 複製はせず、再帰の各段で 1 石だけ push/pop する（共有する前半部分を何度も作り直さない）。
// 評価（evaluate）はここでは呼ばない。並べ替えは置換表の手・キラー手・勝敗だけで十分なことが多く、
// 手ごとに評価を呼ぶと手の数（100 を超えることもある）だけ重くなり、肝心の深さが稼げなくなるため
// （ponytail: 並べ替えの質は少し落ちるが、置換表の手が強く効くので探索の速さを優先）。
// 打ち切りの MAX_PATHS は「重複を除いたあとの数」で数える（重複ばかりの山では打ち切らない）。
// ただし山が高いと生の道の数は 3^(n-1) で指数的に増え、重複がほとんど無い盤面もありうるので、
// 生の道の数にも別の上限 MAX_RAW を設ける（探索の速さを守るための安全弁）。
// 手を指した側がその場で勝てる手が見つかったら、それ以上は探さずに打ち切る（即勝ちは必ず最善）。
const MAX_PATHS = 200;
const MAX_RAW = 500;
function genMovesForOrigin(origin, moverColor, oppColor, out, seen) {
  const ho = heights[origin];
  const n = ho + 1;
  const taken = new Uint8Array(n);
  for (let i = 0; i < ho; i++) taken[i] = stacks[origin * CAP + i];
  taken[ho] = moverColor;
  for (let i = 0; i < ho; i++) popStone(origin);

  const path = new Int8Array(n);
  const seenBase = seen.size;
  let raw = 0;
  function rec(prev, cur, idx) {
    if (raw >= MAX_RAW || seen.size - seenBase >= MAX_PATHS) return false;
    if (idx === n) {
      raw++;
      const hk = hashA;
      if (seen.has(hk)) return false;
      seen.add(hk);
      const { w1, w2 } = winAffected(origin, path);
      const movingWin = (moverColor === 2 && w1) || (moverColor === 3 && w2);
      const oppWin = (oppColor === 2 && w1) || (oppColor === 3 && w2);
      out.push({ origin, path: path.slice(), w1, w2, oppWin }); // Int8Array のまま複製（通常の配列よりメモリが軽い）
      return movingWin;
    }
    for (const nb of NEI[cur]) {
      if (nb === prev) continue;
      pushStone(nb, taken[idx]);
      path[idx] = nb;
      const stop = rec(cur, nb, idx + 1);
      popStone(nb);
      if (stop || raw >= MAX_RAW || seen.size - seenBase >= MAX_PATHS) return stop;
    }
    return false;
  }
  const stop = rec(null, origin, 0);

  for (let i = 0; i < ho; i++) pushStone(origin, taken[i]); // 山を戻す
  return stop;
}
function genMoves(turn) {
  const moverColor = turn + 1, oppColor = turn === 1 ? 3 : 2;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < 16; i++) {
    if (heights[i] > 0 && genMovesForOrigin(i, moverColor, oppColor, out, seen)) break; // 即勝ちが見つかった
  }
  return out;
}
// 手の生成は重い（3^(n-1) の道を辿る）ので、盤面ごとに結果をキャッシュする。
// 反復深化は同じ局面（特に根に近いところ）を深さを変えて何度も訪れるので、これだけで大きく効く。
// 常に上書き（固定長の型付き配列。衝突時は新しい方が残る＝実害はほぼない）。
// 手の数が多い局面はキャッシュに入れない（まれだが、入れるとメモリを大きく食うため）。
const MC_BITS = 12; // bestMove の呼び出しごとに作り直す（局面をまたいで大きくなり続けない）
const MC_SIZE = 1 << MC_BITS;
const MC_MASK = MC_SIZE - 1;
const MC_MAX_LEN = 100; // メモリの上限を抑えるため、手の多い局面はキャッシュしない
const mcUsed = new Uint8Array(MC_SIZE);
const mcA = new Uint32Array(MC_SIZE);
const mcB = new Uint32Array(MC_SIZE);
const mcMoves = new Array(MC_SIZE).fill(null);
function genMovesCached(turn) {
  const ta = (hashA ^ TURN_A[turn - 1]) >>> 0, tb = (hashB ^ TURN_B[turn - 1]) >>> 0;
  const idx = (Math.imul(ta | 0, 2654435761) ^ tb) & MC_MASK;
  if (mcUsed[idx] && mcA[idx] === ta && mcB[idx] === tb) return mcMoves[idx];
  const moves = genMoves(turn);
  if (moves.length > MC_MAX_LEN) return moves;
  mcUsed[idx] = 1; mcA[idx] = ta; mcB[idx] = tb; mcMoves[idx] = moves;
  return moves;
}

// 素直な評価: 相手の色が乗っていない線ほど、自分の見える石の数に応じて点を足す（4 つ目は勝ちなので別扱い済み）。
// 積まれて隠れている自分の石は、あとで表に出てきうるので軽く加点する。
// 整数で持つため 10 倍スケール（HIDDEN_BONUS の 0.3 は 3 にしている）。
const WEIGHT = { 1: 1, 2: 4, 3: 16 };
const HIDDEN_BONUS = 3;
function evaluate(turn) {
  const mine = turn + 1, opp = turn === 1 ? 3 : 2;
  let score = 0;
  for (const line of LINES) {
    let m = 0, o = 0;
    for (const i of line) {
      const t = topColor(i);
      if (t === mine) m++; else if (t === opp) o++;
    }
    if (o === 0 && m > 0) score += (WEIGHT[m] || 0) * 10;
    if (m === 0 && o > 0) score -= (WEIGHT[o] || 0) * 10;
  }
  for (let c = 0; c < 16; c++) {
    const h = heights[c];
    for (let i = 0; i < h - 1; i++) {
      const s = stacks[c * CAP + i];
      if (s === mine) score += HIDDEN_BONUS;
      else if (s === opp) score -= HIDDEN_BONUS;
    }
  }
  return score;
}

// --- 置換表（固定長の型付き配列。Map より速い。常に上書き＝深いほうを残す単純な方式） ---
const TT_BITS = 20;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttUsed = new Uint8Array(TT_SIZE);
const ttA = new Uint32Array(TT_SIZE);
const ttB = new Uint32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttValue = new Int32Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE); // 0 exact, 1 lower(β打ち切り), 2 upper(α以下)
const ttMoveOrigin = new Int8Array(TT_SIZE);
const ttMovePath = new Array(TT_SIZE).fill(null);
function ttIndex(a, b) { return (Math.imul(a | 0, 2654435761) ^ b) & TT_MASK; }
function ttStore(a, b, depth, value, flag, origin, path) {
  const idx = ttIndex(a, b);
  if (!ttUsed[idx] || ttDepth[idx] <= depth) {
    ttUsed[idx] = 1; ttA[idx] = a; ttB[idx] = b; ttDepth[idx] = depth;
    ttValue[idx] = value; ttFlag[idx] = flag; ttMoveOrigin[idx] = origin; ttMovePath[idx] = path;
  }
}

// キラー手（各深さで β 打ち切りを起こした「勝敗が絡まない」手を 1 つ覚え、並べ替えに使う）
const MAX_PLY = 32;
const killerOrigin = new Int8Array(MAX_PLY).fill(-1);
const killerPath = new Array(MAX_PLY).fill(null);

let nodes = 0;
// turn の番として最善手を探す（negamax + αβ + PVS）。盤はグローバルな stacks/heights を直接 make/unmake する。
function search(hands, turn, depth, alpha, beta, ply, deadline) {
  if ((++nodes & 255) === 0 && performance.now() > deadline) throw TIMEOUT;

  const ta = (hashA ^ TURN_A[turn - 1]) >>> 0, tb = (hashB ^ TURN_B[turn - 1]) >>> 0;
  const idx = ttIndex(ta, tb);
  let ttOrigin = -1, ttPath = null;
  if (ttUsed[idx] && ttA[idx] === ta && ttB[idx] === tb) {
    ttOrigin = ttMoveOrigin[idx]; ttPath = ttMovePath[idx];
    if (ttDepth[idx] >= depth) {
      const v = ttValue[idx], f = ttFlag[idx];
      if (f === 0) return { value: v, origin: ttOrigin, path: ttPath };
      if (f === 1 && v >= beta) return { value: v, origin: ttOrigin, path: ttPath };
      if (f === 2 && v <= alpha) return { value: v, origin: ttOrigin, path: ttPath };
    }
  }

  const moves = genMovesCached(turn);
  // 並べ替え: 即勝ち → 置換表の最善手 → キラー手 → ふつう（相手の即勝ちを許す手は最後）
  for (const mv of moves) {
    const isWin = (turn === 1 ? mv.w1 : mv.w2) || (mv.w1 && mv.w2);
    const isTT = !isWin && mv.origin === ttOrigin && samePath(mv.path, ttPath);
    const isKiller = !isWin && !isTT && ply < MAX_PLY && mv.origin === killerOrigin[ply] && samePath(mv.path, killerPath[ply]);
    mv.rank = isWin ? 3 : isTT ? 2 : isKiller ? 1 : mv.oppWin ? -1 : 0;
  }
  moves.sort((a, b) => b.rank - a.rank);

  const a0 = alpha;
  let best = -Infinity, bestOrigin = null, bestPath = null, first = true, moveIdx = 0;
  for (const mv of moves) {
    const nh = hands.slice();
    nh[turn - 1]--;
    const moverColor = turn + 1;
    let val;
    if (mv.w1 && mv.w2) val = WIN - ply; // 両方同時に揃ったら、手を指した側（turn）の勝ち
    else if ((turn === 1 && mv.w1) || (turn === 2 && mv.w2)) val = WIN - ply;
    else if (mv.w1 || mv.w2) val = -(WIN - ply); // 相手の色だけ揃ってしまった
    else if (nh[0] === 0 && nh[1] === 0) val = 0; // 両者置き終えて引き分け
    else if (depth <= 1) val = evaluate(turn);
    else {
      const taken = makeMove(mv.origin, mv.path, moverColor);
      const nextTurn = turn === 1 ? 2 : 1;
      // LMR: 並べ替えで後ろのほう（置換表の手でもキラー手でもない、相手に即勝ちも許さないふつうの手）は
      // まず浅く読み、alpha を超えたときだけ普通の深さで読み直す。
      const reduced = (moveIdx >= 5 && depth >= 4 && mv.rank === 0) ? 1 : 0;
      if (first) {
        val = -search(nh, nextTurn, depth - 1, -beta, -alpha, ply + 1, deadline).value;
      } else {
        val = -search(nh, nextTurn, depth - 1 - reduced, -alpha - 1, -alpha, ply + 1, deadline).value;
        if (reduced && val > alpha) {
          val = -search(nh, nextTurn, depth - 1, -alpha - 1, -alpha, ply + 1, deadline).value;
        }
        if (val > alpha && val < beta) {
          val = -search(nh, nextTurn, depth - 1, -beta, -alpha, ply + 1, deadline).value;
        }
      }
      unmakeMove(mv.origin, mv.path, taken);
    }
    moveIdx++;
    first = false;

    if (val > best) { best = val; bestOrigin = mv.origin; bestPath = mv.path; }
    if (val > alpha) alpha = val;
    if (alpha >= beta) {
      if (!(mv.w1 || mv.w2) && ply < MAX_PLY) { killerOrigin[ply] = mv.origin; killerPath[ply] = mv.path; }
      break;
    }
  }
  if (bestOrigin !== null) {
    const flag = best <= a0 ? 2 : best >= beta ? 1 : 0;
    ttStore(ta, tb, depth, best, flag, bestOrigin, bestPath);
  }
  return { value: best, origin: bestOrigin, path: bestPath };
}

// main.js には必ずふつうの配列で返す（内部は Int8Array で軽く持っているため）。
function toExternal(origin, path) { return { origin, path: Array.from(path) }; }

export function bestMove(board, hands, turn, strength) {
  nodes = 0;
  loadBoard(board);
  const moves = genMoves(turn);
  if (!moves.length) return null;
  const immediateWin = () => moves.find((mv) => (turn === 1 ? mv.w1 : mv.w2));
  const randomMove = () => moves[(Math.random() * moves.length) | 0];

  if (strength === 'weak') {
    const mv = immediateWin() || randomMove();
    return toExternal(mv.origin, mv.path);
  }

  if (strength === 'mid') {
    const deadline = performance.now() + 1300;
    try {
      const r = search(hands, turn, 3, -Infinity, Infinity, 0, deadline);
      if (r.origin !== null) return toExternal(r.origin, r.path);
    } catch (e) { if (e !== TIMEOUT) throw e; }
    const mv = immediateWin() || randomMove();
    return toExternal(mv.origin, mv.path);
  }

  killerOrigin.fill(-1); killerPath.fill(null);
  mcUsed.fill(0); // 手の生成キャッシュは局面ごとに大きいので、指し手が変わるたびに作り直す

  // 最強: 時間の許す限り反復深化。残り手数まで読み切ったら、それ以上深くしない
  const remain = hands[0] + hands[1];
  const deadline = performance.now() + 2800;
  let best = null;
  for (let depth = 1; depth <= remain; depth++) {
    try {
      const r = search(hands, turn, depth, -Infinity, Infinity, 0, deadline);
      if (r.origin !== null) best = r;
      if (r.origin !== null && Math.abs(r.value) >= WIN - 30) break; // 勝ち負けが確定
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
  if (best) return toExternal(best.origin, best.path);
  const mv = immediateWin() || moves[0];
  return toExternal(mv.origin, mv.path);
}

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => {
    const { id, board, hands, turn, strength } = e.data;
    const mv = bestMove(board, hands, turn, strength);
    self.postMessage({ id, origin: mv.origin, path: mv.path });
  };
}
