const N = 100, M = 100;   // 盤面サイズ
const cell = 6;           // 1マスの表示サイズ
let g = new Uint8Array(N * M);
let stepCount = 0; // 追加: ステップ数カウンタ
let aliveHistory = []; // 追加: 生存セル履歴

// 追加: POST 表示タイマー
let postOkTimestamp = 0;
const POST_DISPLAY_MS = 5000;

// 追加: バージョン番号（スクリプトを編集したら手動で +1 してください）
const VERSION = 1; // <-- increment this value each time you change script.js

// ---------- 追加: GAS 送信用 URL と送信関数 ----------
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwsRh5YSdYbVLL1EH-sEYvz9P6gh3EAO-FAaJBr0Ve8EPbR266lo587td_VzcItO7dWUQ/exec';

async function sendResult(alive, step) {
  // クライアントの外部IPを取得（失敗しても送信は行う）
  let clientIp = '';
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    if (r.ok) {
      const j = await r.json();
      clientIp = j.ip || '';
    }
  } catch (e) {
    clientIp = '';
  }

  const payloadObj = {
    timestamp: new Date().toISOString(),
    ip: clientIp,
    reverse_dns: '',
    alive_final: Number(alive) || 0,
    step_final: Number(step) || 0
  };
  const body = JSON.stringify(payloadObj);

  // sendBeacon を優先（Content-Type: text/plain で送る）
  try {
    if (navigator && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain' });
      const queued = navigator.sendBeacon(GAS_URL, blob);
      if (queued) postOkTimestamp = Date.now(); // queued なら表示
      return;
    }
  } catch (e) {
    // fallthrough to fetch
  }

  // フォールバック fetch（keepalive）
  try {
    const resp = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body,
      keepalive: true
    });
    if (resp && resp.ok) postOkTimestamp = Date.now();
  } catch (e) {
    // ignore
  }
}
// ---------- 追加ここまで ----------

// 追加: K 表記に変換するヘルパー
function formatStep(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const s = k >= 100 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString();
  return s.replace(/\.0$/, '') + 'K';
}

// 追加: 前回・前々回状態を保持して定常検出
let prevGrid = null;
let prev2Grid = null;
let gameOver = false;

// ヘルパー: 配列等値比較
function arraysEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// index計算
function idx(y, x) { return y * M + x; }

// ランダム初期化
function randInit() {
  for (let i = 0; i < g.length; i++) {
    g[i] = Math.random() < 0.2 ? 1 : 0;
  }
  stepCount = 0;
  prevGrid = null;
  prev2Grid = null;
  gameOver = false;
  // 初期の生存数を履歴に登録
  const initAlive = g.reduce((s, v) => s + v, 0);
  aliveHistory = [initAlive];
}

// 次世代計算
function step() {
  const ng = new Uint8Array(g.length);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      let n = 0;
      // 周囲8セル
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const yy = (y + dy + N) % N;
          const xx = (x + dx + M) % M;
          n += g[idx(yy, xx)];
        }
      }
      const a = g[idx(y, x)];
      // ライフゲームのルール（B3/S23）
      ng[idx(y, x)] = (a && (n === 2 || n === 3)) || (!a && n === 3) ? 1 : 0;
    }
  }
  g = ng;
}

// 描画
const ctx = document.getElementById("cv").getContext("2d");
function draw() {
  ctx.clearRect(0, 0, M * cell, N * cell);
  ctx.fillStyle = "lime";
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      if (g[idx(y, x)]) {
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }

  // ステップ数・バージョン・生存セル数を canvas 上に表示（左上、背景付き）
  const padding = 6;
  const fontSize = 14;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textBaseline = "top";

  const versionText = `v${VERSION}`;
  const stepText = `Step: ${formatStep(stepCount)}`;
  const aliveCount = aliveHistory.length ? aliveHistory[aliveHistory.length - 1] : g.reduce((s, v) => s + v, 0);
  const aliveText = `Alive: ${aliveCount}`;

  const versionWidth = ctx.measureText(versionText).width;
  const stepWidth = ctx.measureText(stepText).width;
  const aliveWidth = ctx.measureText(aliveText).width;
  const textWidth = Math.max(versionWidth, stepWidth, aliveWidth);

  const boxX = 6;
  const boxY = 6;
  const lineGap = 4;
  const lines = 3;
  const boxW = textWidth + padding * 2;
  const boxH = fontSize * lines + padding * 2 + lineGap * (lines - 1);

  ctx.fillStyle = "rgba(0,0,0,0.6)"; // 背景
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = "white"; // 文字色

  // テキスト描画（上段: version、中央: Step、下段: Alive）
  ctx.fillText(versionText, boxX + padding, boxY + padding / 2);
  ctx.fillText(stepText, boxX + padding, boxY + padding / 2 + fontSize + lineGap);
  ctx.fillText(aliveText, boxX + padding, boxY + padding / 2 + (fontSize + lineGap) * 2);

  // POST 表示（送信成功 or queued から一定時間表示）
  if (Date.now() - postOkTimestamp < POST_DISPLAY_MS) {
    const badgeText = 'POST';
    ctx.font = '12px sans-serif';
    const bw = ctx.measureText(badgeText).width + 8;
    const bh = 16;
    const bx = boxX + boxW - bw - 6;
    const by = boxY + 4;
    ctx.fillStyle = 'rgba(0,128,0,0.9)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, bx + bw / 2, by + bh / 2);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'top';
    ctx.font = `${fontSize}px sans-serif`;
  }

  // ゲームオーバー時は中央に大きく表示
  if (gameOver) {
    const cw = M * cell;
    const ch = N * cell;
    const title = "GAME OVER";
    const stepLine = `Step: ${formatStep(stepCount)}`;
    const aliveFinal = aliveHistory.length ? aliveHistory[aliveHistory.length - 1] : g.reduce((s, v) => s + v, 0);
    const aliveLine = `Alive: ${aliveFinal}`;

    const titleSize = Math.max(24, Math.floor(Math.min(cw, ch) / 12));
    const subSize = Math.max(14, Math.floor(titleSize / 2.2));

    // 背景パネル（幅はタイトルと2行分のテキストの最大幅に合わせる）
    const pad = 20;
    ctx.font = `${titleSize}px sans-serif`;
    const tw = ctx.measureText(title).width;
    ctx.font = `${subSize}px sans-serif`;
    const swStep = ctx.measureText(stepLine).width;
    const swAlive = ctx.measureText(aliveLine).width;
    const sw = Math.max(swStep, swAlive);
    const boxW2 = Math.max(tw, sw) + pad * 2;
    const boxH2 = titleSize + subSize * 2 + pad * 2 + 6; // 2行分の余白

    const boxX2 = (cw - boxW2) / 2;
    const boxY2 = (ch - boxH2) / 2;

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(boxX2, boxY2, boxW2, boxH2);

    // テキスト描画（中央揃え）
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "white";
    ctx.font = `${titleSize}px sans-serif`;
    ctx.fillText(title, cw / 2, boxY2 + pad / 2);
    ctx.font = `${subSize}px sans-serif`;
    ctx.fillText(stepLine, cw / 2, boxY2 + pad / 2 + titleSize);
    ctx.fillText(aliveLine, cw / 2, boxY2 + pad / 2 + titleSize + subSize + 4);

    // restore
    ctx.textAlign = "start";
    ctx.textBaseline = "top";

    // 追加: 画面下1/3にグラフを描画（Alive vs Step）
    const graphTop = Math.floor(ch * (2 / 3));
    const graphHeight = ch - graphTop;
    const graphLeft = 0;
    const graphWidth = cw;

    // 背景パネル
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    // 内側パディング
    // gp を広めに取り、ラベルがキャンバス外にはみ出さないようにする
    const gp = 40;          // <-- 変更: 十分な左パディング確保
    const gx = graphLeft + gp;
    const gy = graphTop + gp;
    const gw = graphWidth - gp * 2;
    const gh = graphHeight - gp * 2;

    const data = aliveHistory.slice();
    const n = data.length;
    const maxV = Math.max(1, ...data); // 0除算防止
    // 横軸スケール
    const xScale = (i) => gx + (n <= 1 ? 0 : (i / (n - 1)) * gw);
    // 縦軸スケール（alive -> y）
    const yScale = (v) => gy + (1 - v / maxV) * gh;

    // 軸グリッドと目盛
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle"; // <-- 変更: テキストの基準を中央にして上下切れを防ぐ
    for (let i = 0; i <= 4; i++) {
      // ラベルの Y をグラフ領域内にクランプ（上下はみ出し防止）
      let labelY = gy + (i / 4) * gh;
      const padY = 6;
      if (labelY < gy + padY) labelY = gy + padY;
      if (labelY > gy + gh - padY) labelY = gy + gh - padY;

      const y = gy + (i / 4) * gh;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx + gw, y);
      ctx.stroke();
      const v = Math.round(maxV * (1 - i / 4));
      ctx.fillText(String(v), gx - 8, labelY); // gx-8 は左余白内で確実に描画される
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // 領域塗り & 線グラフ
    if (n > 0) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xScale(i);
        const y = yScale(data[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // 線の描画
      ctx.strokeStyle = "lime";
      ctx.lineWidth = 2;
      ctx.stroke();

      // 下側を塗る
      ctx.lineTo(xScale(n - 1), gy + gh);
      ctx.lineTo(xScale(0), gy + gh);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,255,0,0.12)";
      ctx.fill();

      // 最新値を強調して表示
      const lastX = xScale(n - 1);
      const lastY = yScale(data[n - 1]);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "12px sans-serif";
      const aliveLabel = `Alive: ${data[n - 1]}`;
      const stepLabel = `Step: ${formatStep(stepCount)}`;
      const aliveW = ctx.measureText(aliveLabel).width;
      const stepW = ctx.measureText(stepLabel).width;
      const labelW = Math.max(aliveW, stepW);
      const labelH = 14; // テキスト行の高さ想定

      // ラベル位置をグラフ内にクランプ（右端で見切れないように左側に配置）
      const labelPadding = 6;
      let lx = lastX + labelPadding;
      const maxLabelX = gx + gw - labelW - 6;
      if (lx > maxLabelX) lx = lastX - labelPadding - labelW;
      if (lx < gx) lx = gx;

      let ly = lastY - labelH - 2;
      if (ly < gy) ly = gy;
      if (ly + labelH * 2 + 4 > gy + gh) ly = gy + gh - (labelH * 2 + 4);

      // 背景パネル（読みやすくする）、パネルはグラフ内に収める
      const panelX = Math.max(gx, lx - 4);
      const panelY = ly - 2;
      const panelW = Math.min(labelW + 8, gx + gw - panelX);
      const panelH = labelH * 2 + 6;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(panelX, panelY, panelW, panelH);

      // テキスト描画
      ctx.fillStyle = "white";
      ctx.textBaseline = "top";
      ctx.fillText(aliveLabel, lx, ly);
      ctx.fillText(stepLabel, lx, ly + labelH + 2);

      // reset
      ctx.textAlign = "start";
      ctx.textBaseline = "top";
    }
  }
}

// メインループ
function loop() {
  if (gameOver) return;

  // 前回・前々回を保持
  prev2Grid = prevGrid ? prevGrid.slice() : null;
  prevGrid = g.slice();

  step();
  stepCount++;

  // 生存数を履歴に追加
  const alive = g.reduce((s, v) => s + v, 0);
  aliveHistory.push(alive);

  // 定常検出: 1ステップ不変 または 2ステップ反復
  if (arraysEqual(g, prevGrid)) {
    gameOver = true;
    // 送信：最終スコアをGASへ（Content-Type: text/plain の JSON 文字列）
    sendResult(alive, stepCount);
    draw();
    return;
  }
  if (prev2Grid && arraysEqual(g, prev2Grid)) {
    gameOver = true;
    sendResult(alive, stepCount);
    draw();
    return;
  }

  draw();
  requestAnimationFrame(loop);
}

randInit();
draw();
loop();