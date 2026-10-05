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
  if (G.mode === 'watch') return p === 1 ? '先手 CPU' : '後手 CPU';
  return p === 1 ? '1人目' : '2人目';
}
function isCpuTurn() { return G.mode === 'watch' || (G.mode === 'cpu' && G.turn !== G.humanPlayer); }
function canInteract() { return !G.winner && !thinking && !isCpuTurn(); }

// ---- 1 手の進行 ----
function startPickup(origin) {
  const color = G.turn + 1;
  const taken = G.board[origin].concat(color);
  G.sel = { origin, taken, path: [], prev: null, cur: origin };
  G.board[origin] = [];
  // 山は浮き上がって手に、積む自分の石は上から降りてくる
  dropHandMotion();
  taken.forEach((_, k) => fly('hand:' + k, k < taken.length - 1 ? stackPos(origin, k) : [cellX(origin), 3, cellZ(origin)]));
}
function cancelPickup() {
  const rest = G.sel.taken.slice(0, -1); // 積んだ自分の石も外して元に戻す
  dropHandMotion();
  rest.forEach((_, k) => fly(`${G.sel.origin}:${k}`, handPos(G.sel.origin, k)));
  G.board[G.sel.origin] = rest;
  G.sel = null;
}
function isLegalTarget(i) {
  return !!G.sel && NEI[G.sel.cur].includes(i) && i !== G.sel.prev;
}
function placeNext(target) {
  const { taken, path, cur } = G.sel;
  // 手の一番下の石が弧を描いて target へ。残りの手は target の上へ移る
  const left = taken.length - path.length;
  const handFrom = [...Array(left).keys()].map((k) => handPos(cur, k));
  dropHandMotion();
  G.board[target].push(taken[path.length]);
  fly(`${target}:${G.board[target].length - 1}`, handFrom[0]);
  for (let k = 1; k < left; k++) fly('hand:' + (k - 1), handFrom[k]);
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
// CPU が石を 1 個配る間（ミリ秒）。タイトルで選び、次に開いたときも同じにする
const CPU_STEP = { slow: 650, mid: 250, fast: 90 };
let cpuSpeed = CPU_STEP[load('speed', 'mid')] ? load('speed', 'mid') : 'mid';
function animateCpuMove(origin, path) {
  const game = G;
  startPickup(origin);
  render();
  let i = 0;
  const step = () => {
    if (G !== game) return; // 途中でホームに戻った
    placeNext(path[i]);
    i++;
    if (G.sel) render(); // 手の途中（まだ続く）。最後は placeNext 内の finishMove が render 済み
    if (i < path.length) setTimeout(step, CPU_STEP[cpuSpeed]);
  };
  setTimeout(step, CPU_STEP[cpuSpeed]);
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
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
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

const DESK = new THREE.Group(); // 机の天板と盤の影。ホームでは消す
scene.add(DESK);
// ---- 机の天板。盤の下に木の板を敷き、地平線まで続ける ----
{
  const box = new THREE.Box3().setFromObject(board);
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) { // 木目の線
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2); // 板のすき間
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const FAR = 1500; // 地平線まで続いて見える広さ
  tex.repeat.set(FAR / (w * 3.2), FAR / (w * 3.2));
  const table = new THREE.Mesh(new THREE.PlaneGeometry(FAR, FAR),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = box.min.y - 0.01;
  table.renderOrder = -1;
  DESK.add(table);
  // 盤の落とす影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const shade = sg.createRadialGradient(128, 128, 0, 128, 128, 128 * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sg.fillStyle = shade; sg.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y - 0.005;
  DESK.add(shadow);
}

// ホーム画面では盤を斜め上からの向きで止め、机を消して宙に浮かべる。対局に入ったら机を戻す
{
  const HOME_CAM = camera.position.clone();
  let wasHome = false;
  const watch = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title, #homeBoard');
    if (home !== wasHome) {
      DESK.visible = controls.enabled = !home;
      camera.position.copy(HOME_CAM); controls.update(); draw();
      wasHome = home;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

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
  if (!G) return null; // タイトル画面の見本の盤
  if (G.winLines.some((line) => line.includes(i))) return 'win';
  if (G.sel && G.sel.cur === i) return 'cur';
  if (isLegalTarget(i)) return 'legal';
  if (!G.sel && canInteract() && G.board[i].length > 0) return 'pickable';
  return null;
}

// ---- 動き：手に取る・配る・戻す石は弧を描いて飛ぶ。手の石は浮いて揺れ、そろった石は跳ねる ----
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLY_MS = 220;
const motion = new Map(); // 'マス:高さ' か 'hand:k'（k=0 が次に置く石）→ { from: [x, y, z], t0 }
function stackPos(i, h) { return [cellX(i), h * CHIP_H, cellZ(i)]; }
function handPos(i, k) { return [cellX(i), (G.board[i].length + 3 + k) * CHIP_H, cellZ(i)]; }
function fly(key, from) { if (!CALM) motion.set(key, { from, t0: performance.now() }); }
function dropHandMotion() { for (const k of motion.keys()) if (k.startsWith('hand:')) motion.delete(k); }

let pieceGroup = new THREE.Group();
scene.add(pieceGroup);
function addChip(color, key, to, extra) {
  const m = chipMesh(color);
  const mv = motion.get(key);
  if (mv && performance.now() - mv.t0 >= FLY_MS) motion.delete(key);
  Object.assign(m.userData, { base: to, tw: motion.get(key) }, extra);
  m.position.set(...(m.userData.tw ? m.userData.tw.from : to));
  pieceGroup.add(m);
}
function syncScene(b = G.board) {
  scene.remove(pieceGroup);
  pieceGroup = new THREE.Group();
  const winCells = G ? G.winLines.flat() : [];
  b.forEach((stack, i) => {
    stack.forEach((color, h) => {
      const w = h === stack.length - 1 ? winCells.indexOf(i) : -1;
      addChip(color, `${i}:${h}`, stackPos(i, h), { cell: i, win: w < 0 ? null : w });
    });
    const kind = cellHighlight(i);
    if (kind) pieceGroup.add(highlightMesh(kind, i));
  });
  if (G && G.sel) G.sel.taken.slice(G.sel.path.length).forEach((color, k) => addChip(color, 'hand:' + k, handPos(G.sel.cur, k), { hand: true }));
  scene.add(pieceGroup);
  draw();
  animate();
}

let looping = false;
function animate() {
  if (!looping) { looping = true; requestAnimationFrame(frame); }
}
function frame(now) {
  let busy = false;
  for (const m of pieceGroup.children) {
    const u = m.userData;
    if (!u.base) continue;
    const [x, y, z] = u.base;
    let p = [x, y, z];
    if (u.tw) {
      const t = Math.min(1, (now - u.tw.t0) / FLY_MS);
      if (t < 1) {
        busy = true;
        const e = 1 - (1 - t) ** 3, f = u.tw.from;
        p = [f[0] + (x - f[0]) * e, f[1] + (y - f[1]) * e + 0.4 * Math.sin(Math.PI * t), f[2] + (z - f[2]) * e];
      } else u.tw = null;
    }
    if (!CALM && u.hand) { busy = true; p[1] += 0.04 * Math.sin(now / 300); }
    if (!CALM && u.win != null) { busy = true; p[1] += 0.3 * Math.max(0, Math.sin(now / 220 - u.win * 0.7)) ** 2; }
    m.position.set(...p);
  }
  // 置けるマスのリングは脈打つ
  if (!CALM && G && G.sel) { busy = true; RING_STYLE.legal[1].opacity = 0.6 + 0.35 * Math.sin(now / 180); }
  draw();
  if (busy) requestAnimationFrame(frame); else looping = false;
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
  if (!G) {
    stage.innerHTML = titleHTML();
    document.getElementById('board3d').appendChild(canvas);
    syncScene(DEMO);
    bindTitle();
    return;
  }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

// タイトル画面に出す見本の局面（中盤。中立 8 個、先手 5 個、後手 4 個）
const DEMO = [
  [1], [1, 2], [], [1, 1],
  [], [3], [1, 2, 3], [],
  [], [2], [1, 3, 2], [],
  [1, 1, 3], [2], [], [1],
];

function titleHTML() {
  return `
    <div class="title">
      <h2>カワレ</h2>
      <p class="hint">山を選んで自分の石を積み、山ごと配り直す。上から見える自分の色が 4 つ並んだら勝ち。</p>
      <div class="board3d" id="board3d"></div>
      <div class="opts">
        <label>強さ
          <select id="strength">
            <option value="weak">よわい</option>
            <option value="mid" selected>ふつう</option>
            <option value="strong">最強</option>
          </select>
        </label>
        <label>CPU の速さ
          <select id="speed">
            <option value="slow"${cpuSpeed === 'slow' ? ' selected' : ''}>ゆっくり</option>
            <option value="mid"${cpuSpeed === 'mid' ? ' selected' : ''}>ふつう</option>
            <option value="fast"${cpuSpeed === 'fast' ? ' selected' : ''}>はやい</option>
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
      <button class="pill pill--big" data-start="watch">CPU 同士の対戦を見る</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
      ${rulesHTML()}
    </div>`;
}

// ---- ルール説明の図（上から見た盤・横から見た山。色は 3D の石と同じ） ----
const FU = 24; // 図の 1 マスの大きさ
const FIG_KIND = { 1: 'n', 2: 'a', 3: 'b' };
const figPos = (i) => [4 + ((i % 4) + 0.5) * FU, 4 + (((i / 4) | 0) + 0.5) * FU];
// off: 線を横へずらす量（行きと戻りの矢印が重ならないように）
function figArrow(a, b, cls = 'fig__arrow', off = 0) {
  let [x1, y1] = figPos(a), [x2, y2] = figPos(b);
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  x1 -= (dy / len) * off; x2 -= (dy / len) * off; y1 += (dx / len) * off; y2 += (dx / len) * off;
  const k = 0.3; // 石に重ならないよう両端を縮める
  return `<line class="${cls}" x1="${x1 + dx * k}" y1="${y1 + dy * k}" x2="${x2 - dx * k}" y2="${y2 - dy * k}" marker-end="url(#figArrow)"/>`;
}
// 上から見た 4×4。stacks: { マス: [下から上の石] }。山は一番上の色で塗り、2 個以上なら数を書く。
// o: { path: [マス…] 配った道すじ, ng: [から, へ] だめな動き, mark: [マス…] 光らせるマス, empty: マス 手に取った後の空き }
function figTop(stacks, o = {}) {
  const w = 4 * FU + 8;
  let svg = `<rect class="fig__board" width="${w}" height="${w}" rx="6"/>`;
  for (let i = 0; i < 16; i++) {
    const [x, y] = figPos(i);
    svg += `<circle class="fig__hole${(o.mark || []).includes(i) ? ' fig__hole--on' : ''}${o.empty === i ? ' fig__hole--from' : ''}" cx="${x}" cy="${y}" r="${FU * 0.4}"/>`;
    const st = stacks[i];
    if (!st || !st.length) continue;
    svg += `<circle class="fig__${FIG_KIND[st[st.length - 1]]}" cx="${x}" cy="${y}" r="${FU * 0.32}"/>`;
    if (st.length > 1) svg += `<text class="fig__num" x="${x}" y="${y}">${st.length}</text>`;
  }
  const p = o.path || [];
  for (let k = 1; k < p.length; k++) svg += figArrow(p[k - 1], p[k]);
  if (o.ng) {
    svg += figArrow(o.ng[0], o.ng[1], 'fig__arrow fig__arrow--ng', 7);
    const [x1, y1] = figPos(o.ng[0]), [x2, y2] = figPos(o.ng[1]);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2 - 7 * Math.sign(x1 - x2), d = 4;
    svg += `<path class="fig__x" d="M${cx - d} ${cy - d}L${cx + d} ${cy + d}M${cx + d} ${cy - d}L${cx - d} ${cy + d}"/>`;
  }
  return `<svg class="fig" viewBox="0 0 ${w} ${w}" width="${w * 1.5}" aria-hidden="true">${svg}</svg>`;
}
// 横から見た山。stacks: [[下から上の石]…] を左から並べる。arrow なら山と山の間に矢印
function figSide(stacks, arrow) {
  const cw = 34, ch = 9, gap = arrow ? 28 : 10, h = 6 * ch + 14;
  const w = stacks.length * cw + (stacks.length - 1) * gap + 8;
  let svg = `<rect class="fig__board" y="${h - 8}" width="${w}" height="8" rx="3"/>`;
  stacks.forEach((st, k) => {
    const x = 4 + k * (cw + gap);
    st.forEach((c, j) => { svg += `<rect class="fig__${FIG_KIND[c]}" x="${x + 3}" y="${h - 8 - (j + 1) * ch}" width="${cw - 6}" height="${ch - 1}" rx="2"/>`; });
    if (arrow && k > 0) svg += `<line class="fig__arrow" x1="${x - gap + 4}" y1="${h / 2}" x2="${x - 4}" y2="${h / 2}" marker-end="url(#figArrow)"/>`;
  });
  return `<svg class="fig" viewBox="0 0 ${w} ${h}" width="${w * 1.5}" aria-hidden="true">${svg}</svg>`;
}
function figItem(svg, text) {
  return `<figure class="figs__item">${svg}<figcaption>${text}</figcaption></figure>`;
}

function rulesHTML() {
  const start = { 0: [1, 1], 3: [1, 1], 12: [1, 1], 15: [1, 1] };
  return `
    <details class="rules">
      <summary>ルール</summary>
      <svg width="0" height="0" style="position:absolute"><defs><marker id="figArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ffd35c"/></marker></defs></svg>
      <h3>1. 盤と石</h3>
      <div class="figs">
        ${figItem(figTop(start), '4×4 の盤。四隅に中立の石（灰）が 2 個ずつの山。手持ちは明るい木・暗い木が 8 個ずつで、明るい木が先手。数字は山の高さ')}
      </div>
      <h3>2. 山を選んで積む</h3>
      <div class="figs">
        ${figItem(figSide([[1, 1], [1, 1, 2]], true), '石のある山を 1 つ選び、手持ちの自分の石を 1 個いちばん上に積む')}
      </div>
      <h3>3. 山ごと配り直す</h3>
      <div class="figs">
        ${figItem(figTop({ 1: [1], 3: [1, 1], 5: [1], 6: [2], 12: [1, 1], 15: [1, 1] }, { path: [0, 1, 5, 6], empty: 0 }), 'その山を全部手に取り、いちばん下の石から 1 個ずつ、縦か横の隣のマスへ置きながら進む。空きマスにも石のある山の上にも置ける。積んだ自分の石が最後に置かれる')}
        ${figItem(figTop({ 5: [1], 6: [1] }, { path: [5, 6], ng: [6, 5] }), '× 直前にいたマスへすぐ戻るのはだめ。回り道してから同じマスに来るのはよい')}
      </div>
      <h3>4. 勝ち負け</h3>
      <div class="figs">
        ${figItem(figTop({ 4: [1, 2], 5: [3, 2], 6: [2], 7: [1, 1, 2], 1: [3], 10: [1, 3], 15: [1] }, { mark: [4, 5, 6, 7] }), '上から見える色が自分の色で、縦・横・斜めに 4 つ並んだら勝ち。下に何が埋まっていてもよい')}
      </div>
      <ul>
        <li>配った結果、両方の色が同時に並んだら、配った人の勝ち。</li>
        <li>2 人とも手持ちを使い切っても並ばなければ引き分け。</li>
      </ul>
    </details>`;
}
function bindTitle() {
  document.getElementById('speed').addEventListener('change', (e) => { cpuSpeed = e.target.value; save('speed', cpuSpeed); });
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.start;
    const strength = mode !== '2p' ? document.getElementById('strength').value : null;
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
      ${G.winner ? '' : '<button class="pill game__home" data-title>ホームに戻る</button>'}
      ${again}
    </div>`;
}

function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.strength, G.humanPlayer));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => {
    // 対局の途中なら、押し間違いで消えないように確かめる
    if (G.mode !== 'watch' && !G.winner && (G.sel || G.hands[0] + G.hands[1] < 16) && !confirm('対局をやめてホームに戻りますか？')) return;
    G = null;
    thinking = false;
    render();
  });
}

render();
