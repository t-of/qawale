import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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

WebAppKit.init({ title: 'qawale', text: '山をくずして配り直し、自分の色を 4 つ並べる対戦ボードゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前にこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let audioCtx = null;
// 石を置く音（短い木の音）。win なら高めの 3 音
function beep(win) {
  try {
    setAudioSession(true);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = win ? [523, 659, 784] : [300];
    notes.forEach((f, k) => {
      const t = audioCtx.currentTime + k * 0.12;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (win ? 0.3 : 0.08));
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.35);
    });
  } catch { /* 音が出なくても遊べる */ }
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
  beep(false);
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
  if (G.winner && G.winner !== 'draw') beep(true);
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

// ---- 3D の盤（three.js）。quarto・quantik と同じ木の質感。ドラッグで回す、ピンチで寄る ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 6, 5.6);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

// 影は付けない。環境光（RoomEnvironment）と弱い向きの光で質感を出す
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 木目（灰色の濃淡）。色はマテリアルの color で付ける
function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN = woodTexture();
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const board = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.36, 4.8), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

const CELL_BASE = 0x4a2e1c;
const GROOVE_BASE = 0x24160d;
const cellGeo = new THREE.CircleGeometry(0.42, 48);
const grooveGeo = new THREE.RingGeometry(0.42, 0.47, 48);
function cellX(i) { return (i % 4) - 1.5; }
function cellZ(i) { return Math.floor(i / 4) - 1.5; }
const GROOVE_MAT = new THREE.MeshStandardMaterial({ color: GROOVE_BASE, roughness: 0.9 });
const cellMeshes = [...Array(16).keys()].map((i) => {
  const m = new THREE.Mesh(cellGeo, wood(CELL_BASE, { roughness: 0.7, clearcoat: 0 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(cellX(i), 0.004, cellZ(i));
  m.userData.cell = i;
  const ring = new THREE.Mesh(grooveGeo, GROOVE_MAT);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(m.position.x, 0.003, m.position.z);
  scene.add(m, ring);
  return m;
});

// 石：先手・後手は quarto と同じ明るい木・暗い木、中立は落ち着いた石の色
const CHIP_H = 0.16, CHIP_R = 0.33;
function chipGeo() {
  const b = 0.035; // ふちの面取り
  const pts = [new THREE.Vector2(0, 0)];
  const arc = (cx, cy, r, a0, a1) => { for (let k = 0; k <= 4; k++) { const a = a0 + ((a1 - a0) * k) / 4; pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a))); } };
  arc(CHIP_R - b, b, b, -Math.PI / 2, 0);
  arc(CHIP_R - b, CHIP_H - b, b, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(0, CHIP_H));
  return new THREE.LatheGeometry(pts, 48);
}
const CHIP_GEO = chipGeo();
const CHIP_MAT = {
  1: new THREE.MeshPhysicalMaterial({ color: 0x8a8070, roughness: 0.85, envMapIntensity: 0.5 }), // 中立：石
  2: wood(0xead3a8),
  3: wood(0x5a3820),
};
function chipMesh(color) { return new THREE.Mesh(CHIP_GEO, CHIP_MAT[color]); }

// 選べる・置ける・いまいる・そろった、の強調は床に薄いリングを重ねて出す
const ringGeo = new THREE.RingGeometry(0.3, 0.35, 40);
const wideRingGeo = new THREE.RingGeometry(0.37, 0.47, 40);
function ringMat(color, opacity) { return new THREE.MeshBasicMaterial({ color, transparent: true, opacity }); }
const RING_STYLE = {
  pickable: [ringGeo, ringMat(0xffd35c, 0.35)],
  legal: [ringGeo, ringMat(0xffd35c, 0.9)],
  cur: [ringGeo, ringMat(0xffffff, 0.8)],
  win: [wideRingGeo, ringMat(0xffd35c, 0.95)],
};
function highlightMesh(kind, i) {
  const [geo, mat] = RING_STYLE[kind];
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cellX(i), 0.006, cellZ(i));
  return m;
}
function cellHighlight(i) {
  if (G.winLines.some((line) => line.includes(i))) return 'win';
  if (G.sel && G.sel.cur === i) return 'cur';
  if (isLegalTarget(i)) return 'legal';
  if (!G.sel && canInteract() && G.board[i].length > 0) return 'pickable';
  return null;
}

let pieceGroup = new THREE.Group();
scene.add(pieceGroup);
function syncScene() {
  scene.remove(pieceGroup);
  pieceGroup = new THREE.Group();
  G.board.forEach((stack, i) => {
    stack.forEach((color, h) => {
      const m = chipMesh(color);
      m.position.set(cellX(i), h * CHIP_H, cellZ(i));
      m.userData.cell = i;
      pieceGroup.add(m);
    });
    const kind = cellHighlight(i);
    if (kind) pieceGroup.add(highlightMesh(kind, i));
  });
  scene.add(pieceGroup);
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面でも盤の横が切れないように、縦の画角を広げる
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!G) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...cellMeshes, pieceGroup], true)[0];
  if (hit && hit.object.userData.cell != null) onCellTap(hit.object.userData.cell);
});

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
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

function statusText() {
  if (thinking) return 'CPU が考え中…';
  if (G.winner) return G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  if (G.sel) return `${playerLabel(G.turn)} の番：置く先をえらぶ`;
  return `${playerLabel(G.turn)} の番：山をえらぶ`;
}

function gameHTML() {
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
      <div class="board3d${thinking ? ' board3d--busy' : ''}" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      ${again}
    </div>`;
}

function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.strength, G.humanPlayer));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();
