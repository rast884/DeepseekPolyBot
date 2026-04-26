const admin = require('firebase-admin');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ── TELEGRAM SETUP ────────────────────────────────────────────────────
let tg = null;
let TG_CHAT_ID = '';

function initTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('[TG] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы');
    return false;
  }
  try {
    tg = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    console.log('[TG] Telegram polling started');
    return true;
  } catch(e) {
    console.error('[TG] Init error:', e.message);
    return false;
  }
}

function getMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['💰 Баланс', '📊 Статус'],
        ['📈 Цена BTC', '⏳ След. ставка'],
        ['▶ Старт', '⏹ Стоп'],
        ['🔄 Сброс']
      ],
      resize_keyboard: true,
      persistent: true
    }
  };
}

async function tgSend(msg) {
  if (!tg) return;
  try {
    await tg.sendMessage(TG_CHAT_ID, msg, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...getMainKeyboard()
    });
  } catch(e) {
    console.error('[TG] Send error:', e.message);
  }
}

async function tgReply(chatId, msg) {
  if (!tg) return;
  try {
    await tg.sendMessage(chatId, msg, {
      parse_mode: 'HTML',
      ...getMainKeyboard()
    });
  } catch(e) {
    console.error('[TG] Reply error:', e.message);
  }
}

// ── FIREBASE ──────────────────────────────────────────────────────────
let db = null;
let STATE_REF = null;
let firebaseReady = false;

function initFirebase() {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_DATABASE_URL) {
      console.error('[FB] Firebase env vars missing');
      console.error('[FB] projectId:', process.env.FIREBASE_PROJECT_ID ? 'OK' : 'MISSING');
      console.error('[FB] clientEmail:', process.env.FIREBASE_CLIENT_EMAIL ? 'OK' : 'MISSING');
      console.error('[FB] privateKey:', privateKey ? 'OK (length ' + privateKey.length + ')' : 'MISSING');
      console.error('[FB] databaseURL:', process.env.FIREBASE_DATABASE_URL ? 'OK' : 'MISSING');
      return false;
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });

    db = admin.database();
    STATE_REF = db.ref('btc15m/main');
    firebaseReady = true;
    console.log('[FB] Firebase initialized');
    return true;
  } catch(e) {
    console.error('[FB] Init error:', e.message);
    return false;
  }
}

// ── CONSTANTS ─────────────────────────────────────────────────────────
const WIN_MULT = 0.92;
const ROUND_MS = 15 * 60 * 1000;
const FIXED_BET = 5;
const WORK_START_UTC = 6;
const WORK_END_UTC = 21;

// ── STATE ─────────────────────────────────────────────────────────────
let state = null;
let currentPrice = 72000;
let priceBuffer = [];
let wsConnected = false;
let roundPlaced = null;
let _userBotOn = true;
let botStarted = false;

function defaultState() {
  return {
    wallet: { balance: 100, pnl: 0, wins: 0, losses: 0, totalBet: 0 },
    stats: { bestStreak: 0, curStreak: 0, totalWin: 0, totalLoss: 0 },
    history: [],
    botOn: false,
    lastRoundId: null,
    pendingBet: null,
    savedAt: Date.now(),
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────
function isWorkingHours() {
  const h = new Date().getUTCHours();
  return h >= WORK_START_UTC && h < WORK_END_UTC;
}

function shouldBotRun() {
  return _userBotOn && isWorkingHours();
}

async function loadState() {
  if (!firebaseReady || !STATE_REF) {
    console.log('[STATE] Firebase not ready, using default state');
    return defaultState();
  }
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const data = snap.val();
      data.history = (data.history || []).slice(0, 200);
      _userBotOn = data.botOn === true;
      console.log(`[STATE] Balance: $${data.wallet?.balance} | botOn: ${_userBotOn}`);
      return data;
    }
  } catch(e) {
    console.error('[STATE] Load error:', e.message);
  }
  return defaultState();
}

async function saveState() {
  if (!firebaseReady || !STATE_REF) return;
  try {
    state.savedAt = Date.now();
    state.botOn = _userBotOn;
    await STATE_REF.set(state);
  } catch(e) {
    console.error('[STATE] Save error:', e.message);
  }
}

const roundId = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain = () => roundId() + ROUND_MS - Date.now();
const fmtWindow = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow'
  });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

function getTimeToNextBet() {
  const rem = roundRemain();
  let msToNext;
  if (rem > 0) {
    msToNext = rem;
  } else {
    msToNext = ROUND_MS + rem;
  }
  const mins = Math.floor(msToNext / 60000);
  const secs = Math.floor((msToNext % 60000) / 1000);
  return `${mins} мин ${secs} сек`;
}

// ── PRICE FEED ────────────────────────────────────────────────────────
function connectPriceWS() {
  try {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');
    ws.on('open', () => {
      wsConnected = true;
      console.log('[WS] Connected to Polymarket');
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: JSON.stringify({ symbol: 'btc/usd' })
        }]
      }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd') {
          const p = parseFloat(msg.payload.value);
          if (p > 0) {
            currentPrice = p;
            priceBuffer.push(p);
            if (priceBuffer.length > 300) priceBuffer.shift();
          }
        }
      } catch(e) {}
    });
    ws.on('close', () => {
      wsConnected = false;
      console.log('[WS] Disconnected, reconnecting in 5s...');
      setTimeout(connectPriceWS, 5000);
    });
    ws.on('error', (err) => {
      wsConnected = false;
      console.error('[WS] Error:', err.message);
    });
  } catch(e) {
    console.error('[WS] Connection error:', e.message);
    setTimeout(connectPriceWS, 10000);
  }
}

async function fetchPriceFallback() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { timeout: 5000 });
    const d = await r.json();
    const t = d.result?.list?.[0];
    if (t) {
      currentPrice = parseFloat(t.lastPrice);
      priceBuffer.push(currentPrice);
      if (priceBuffer.length > 300) priceBuffer.shift();
    }
  } catch(e) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout: 5000 });
      const d = await r.json();
      if (d.bitcoin?.usd) {
        currentPrice = d.bitcoin.usd;
        priceBuffer.push(currentPrice);
      }
    } catch(e2) {}
  }
}

// ── KLINE BUILDER ─────────────────────────────────────────────────────
function buildKlines() {
  if (priceBuffer.length < 10) return [];
  const buf = priceBuffer.slice(-90);
  const chunkSize = Math.max(1, Math.floor(buf.length / 15));
  const candles = [];
  for (let i = 0; i < 15; i++) {
    const chunk = buf.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!chunk.length) continue;
    candles.push({
      o: chunk[0],
      h: Math.max(...chunk),
      l: Math.min(...chunk),
      c: chunk[chunk.length - 1],
      v: chunk.length,
    });
  }
  return candles;
}

// ── POLYMARKET SENTIMENT ──────────────────────────────────────────────
let pmUpProb = 0.5, pmDownProb = 0.5, pmLastFetch = 0;

async function fetchPolymarketSentiment() {
  if (Date.now() - pmLastFetch < 60000) return;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const slug = `btc-updown-15m-${nowSec - (nowSec % 900)}`;
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout: 4000 });
    if (!r.ok) return;
    const data = await r.json();
    const market = data?.[0]?.markets?.[0];
    if (!market) return;
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    pmUpProb = parseFloat(prices[0]) || 0.5;
    pmDownProb = parseFloat(prices[1]) || 0.5;
    pmLastFetch = Date.now();
  } catch(e) {}
}

// ── AI SIGNAL ─────────────────────────────────────────────────────────
function aiSignal(klines) {
  if (klines.length < 5)
    return { direction: 'UP', confidence: 52, skip: true, reason: 'Нет данных', score: 0 };

  const n = klines.length, c = klines.map(k => k.c), o = klines.map(k => k.o),
    v = klines.map(k => k.v);
  let score = 0;
  const signals = [];

  const rA = (c[n - 1] + c[n - 2] + c[n - 3]) / 3, eA = (c[0] + c[1] + c[2]) / 3;
  if (rA > eA * 1.001) { score += 2.5; signals.push('Тренд▲'); }
  else if (rA < eA * 0.999) { score -= 2.5; signals.push('Тренд▼'); }
  else signals.push('Флет');

  let bullC = 0, bearC = 0;
  for (let i = n - 4; i < n; i++) { if (c[i] > o[i]) bullC++; else bearC++; }
  if (bullC >= 3) { score += 2.5; signals.push(`${bullC}×Bull`); }
  if (bearC >= 3) { score -= 2.5; signals.push(`${bearC}×Bear`); }

  const avgV = v.slice(0, -1).reduce((a, b) => a + b, 0) / (n - 1);
  if (v[n - 1] > avgV * 1.5) { score += (c[n - 1] > o[n - 1] ? 1.5 : -1.5); signals.push('VolSpike'); }

  const gains = [], losses = [];
  for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; if (d > 0) gains.push(d); else losses.push(Math.abs(d)); }
  const aG = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
  const aL = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0.001;
  const rsi = 100 - 100 / (1 + aG / aL);
  if (rsi > 75) { score -= 2; signals.push(`RSI${rsi.toFixed(0)}OB`); }
  else if (rsi < 25) { score += 2; signals.push(`RSI${rsi.toFixed(0)}OS`); }

  if (pmUpProb >= 0.65) { score += 4; signals.push(`PM▲${(pmUpProb * 100).toFixed(0)}%`); }
  else if (pmUpProb <= 0.35) { score -= 4; signals.push(`PM▼${(pmDownProb * 100).toFixed(0)}%`); }
  else if (pmUpProb >= 0.57) { score += 2; signals.push(`PM▲${(pmUpProb * 100).toFixed(0)}%`); }
  else if (pmUpProb <= 0.43) { score -= 2; signals.push(`PM▼${(pmDownProb * 100).toFixed(0)}%`); }

  if (priceBuffer.length >= 60) {
    const recent = priceBuffer.slice(-60);
    const range = Math.max(...recent) - Math.min(...recent);
    if (range < 30) { score *= 0.3; signals.push(`Флет⚠$${range.toFixed(0)}`); }
  }

  const absScore = Math.abs(score);
  const skip = absScore < 3.5;
  const dir = score >= 0 ? 'UP' : 'DOWN';
  const conf = Math.min(87, Math.max(52, 52 + absScore * 4));
  return {
    direction: dir,
    confidence: conf,
    skip,
    reason: `${dir} ${conf.toFixed(0)}% | Скор:${score.toFixed(1)} | ${signals.join(',')}`,
    score
  };
}

// ── BOT LOGIC ─────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced === rid) return;
  if (!botStarted) return;
  if (!shouldBotRun()) return;
  if (state.wallet.balance < FIXED_BET) {
    await tgSend('❌ Баланс < $5. Остановка.');
    _userBotOn = false;
    await saveState();
    return;
  }
  roundPlaced = rid;
  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const klines = buildKlines();
  const sig = aiSignal(klines);
  if (sig.skip) {
    state.history.unshift({
      id: rid, direction: sig.direction, confidence: sig.confidence,
      reason: sig.reason, betAmount: 0, startPrice: currentPrice,
      endPrice: null, window: fmtWindow(rid), result: 'skip', pnl: 0,
      balanceAfter: state.wallet.balance, ts: new Date().toISOString()
    });
    if (state.history.length > 200) state.history = state.history.slice(0, 200);
    state.lastRoundId = rid;
    await saveState();
    console.log(`[BOT] Skip round ${fmtWindow(rid)} | score: ${sig.score.toFixed(1)}`);
    return;
  }
  state.wallet.balance = parseFloat((state.wallet.balance - FIXED_BET).toFixed(2));
  state.wallet.totalBet += FIXED_BET;
  state.lastRoundId = rid;
  state.pendingBet = {
    id: rid, direction: sig.direction, confidence: sig.confidence,
    reason: sig.reason, betAmount: FIXED_BET, startPrice: currentPrice,
    endPrice: null, window: fmtWindow(rid), result: 'pending', pnl: 0,
    ts: new Date().toISOString()
  };
  await saveState();
  const dirEmoji = sig.direction === 'UP' ? '🟢' : '🔴';
  const msg = [
    `${dirEmoji} <b>${sig.direction}</b> $${FIXED_BET} @ $${Math.round(currentPrice)}`,
    `🕐 ${fmtWindow(rid)}`,
    `🎯 Уверенность: ${sig.confidence.toFixed(0)}%`,
    `💰 Баланс: $${state.wallet.balance.toFixed(2)}`,
    `📈 ${sig.reason}`,
  ].join('\n');
  console.log(`[BOT] BET: ${sig.direction} $${FIXED_BET} | ${fmtWindow(rid)}`);
  await tgSend(msg);
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;
  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;
  const up = bet.endPrice >= bet.startPrice;
  const won = (bet.direction === 'UP' && up) || (bet.direction === 'DOWN' && !up);
  if (won) {
    const p = parseFloat((FIXED_BET * WIN_MULT).toFixed(2));
    state.wallet.balance = parseFloat((state.wallet.balance + FIXED_BET + p).toFixed(2));
    state.wallet.pnl = parseFloat((state.wallet.pnl + p).toFixed(2));
    state.wallet.wins++;
    state.stats.curStreak++;
    state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result = 'win';
    bet.pnl = p;
    const msg = [
      `✅ <b>WIN</b> +$${p.toFixed(2)}`,
      `💰 Баланс: $${state.wallet.balance.toFixed(2)}`,
      `🔥 Серия: ${state.stats.curStreak}`,
      `📊 W${state.wallet.wins}/L${state.wallet.losses}`,
    ].join('\n');
    console.log(`[BOT] WIN +$${p.toFixed(2)} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(msg);
  } else {
    state.wallet.pnl = parseFloat((state.wallet.pnl - FIXED_BET).toFixed(2));
    state.wallet.losses++;
    state.stats.curStreak = 0;
    state.stats.totalLoss += FIXED_BET;
    bet.result = 'loss';
    bet.pnl = -FIXED_BET;
    const msg = [
      `❌ <b>LOSS</b> -$${FIXED_BET}`,
      `💰 Баланс: $${state.wallet.balance.toFixed(2)}`,
      `📊 W${state.wallet.wins}/L${state.wallet.losses}`,
    ].join('\n');
    console.log(`[BOT] LOSS -$${FIXED_BET} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(msg);
  }
  bet.balanceAfter = state.wallet.balance;
  state.history.unshift({ ...bet });
  if (state.history.length > 200) state.history = state.history.slice(0, 200);
  state.pendingBet = null;
  await saveState();
  if (state.wallet.balance < FIXED_BET) {
    _userBotOn = false;
    await saveState();
    await tgSend('⚠️ Баланс < $5. Бот остановлен.');
  }
}

// ── MAIN TICK ─────────────────────────────────────────────────────────
async function tick() {
  if (!state || !botStarted) return;
  const rid = roundId();
  const rem = roundRemain();
  // Resolve
  if (rem < 10000 && state.pendingBet?.result === 'pending' && state.pendingBet?.id === rid) {
    await resolveBet();
  }
  // Place
  if (rem > ROUND_MS - 25000 && shouldBotRun()) {
    await placeBet(rid);
  }
  // Fallback price
  if (!wsConnected && Date.now() % 30000 < 5000) {
    await fetchPriceFallback();
  }
  // Resolve if outside working hours
  if (!isWorkingHours() && state.pendingBet?.result === 'pending') {
    await resolveBet();
  }
}

// ── LISTENERS ─────────────────────────────────────────────────────────
function listenForCommands() {
  if (!firebaseReady) return;
  STATE_REF.child('botOn').on('value', async snap => {
    const val = snap.val();
    if (typeof val === 'boolean' && val !== _userBotOn) {
      _userBotOn = val;
      console.log(`[STATE] botOn changed to: ${_userBotOn}`);
      await tgSend(_userBotOn ? '▶ Бот запущен' : '■ Бот остановлен');
      if (!_userBotOn && state.pendingBet?.result === 'pending') await resolveBet();
    }
  });
  db.ref('btc15m/command').on('value', async snap => {
    if (snap.val() === 'reset') {
      state = defaultState();
      roundPlaced = null;
      await saveState();
      await db.ref('btc15m/command').remove();
      console.log('[STATE] Reset command received');
      await tgSend('↺ Сброс. Баланс: $100');
    }
  });
}

// ── TELEGRAM COMMANDS ─────────────────────────────────────────────────
function setupTelegramListeners() {
  if (!tg) return;

  tg.onText(/\/start/, async (msg) => {
    await tgReply(msg.chat.id, '🤖 <b>BTC 15M Бот</b>\nВыберите действие:');
  });

  tg.onText(/\/balance|💰 Баланс/, async (msg) => {
    if (!state) {
      await tgReply(msg.chat.id, '⏳ Бот ещё не загрузился...');
      return;
    }
    const w = state.wallet;
    const s = state.stats;
    const text = [
      '<b>Баланс</b>',
      `💰 Баланс: $${w.balance.toFixed(2)}`,
      `📈 PnL: $${w.pnl.toFixed(2)}`,
      `✅ Побед: ${w.wins}`,
      `❌ Поражений: ${w.losses}`,
      `🔥 Серия: ${s.curStreak}`,
      `🏆 Рекорд: ${s.bestStreak}`,
      `💵 Ставок: ${w.wins + w.losses}`,
    ].join('\n');
    await tgReply(msg.chat.id, text);
  });

  tg.onText(/\/status|📊 Статус/, async (msg) => {
    if (!state) {
      await tgReply(msg.chat.id, '⏳ Бот ещё не загрузился...');
      return;
    }
    const text = [
      '<b>Статус</b>',
      `🤖 Бот: ${_userBotOn ? '🟢 Вкл' : '🔴 Выкл'}`,
      `⏰ Расписание: ${isWorkingHours() ? '🟢 Работает' : '🔴 Ночь'}`,
      `📈 Цена BTC: $${Math.round(currentPrice)}`,
      `⏳ До ставки: ${getTimeToNextBet()}`,
      `💰 Баланс: $${state.wallet.balance.toFixed(2)}`,
    ].join('\n');
    await tgReply(msg.chat.id, text);
  });

  tg.onText(/\/price|📈 Цена BTC/, async (msg) => {
    await tgReply(msg.chat.id, `📈 <b>BTC</b>: $${Math.round(currentPrice)}`);
  });

  tg.onText(/\/nextbet|⏳ След. ставка/, async (msg) => {
    await tgReply(msg.chat.id, `⏳ До следующей ставки: <b>${getTimeToNextBet()}</b>`);
  });

  tg.onText(/\/startbot|▶ Старт/, async (msg) => {
    if (!isWorkingHours()) {
      await tgReply(msg.chat.id, '⏰ Нерабочее время. Бот работает 09:00–00:00 МСК.');
      return;
    }
    _userBotOn = true;
    await saveState();
    await tgReply(msg.chat.id, '▶ Бот запущен');
  });

  tg.onText(/\/stopbot|⏹ Стоп/, async (msg) => {
    _userBotOn = false;
    await saveState();
    await tgReply(msg.chat.id, '■ Бот остановлен');
  });

  tg.onText(/\/reset|🔄 Сброс/, async (msg) => {
    state = defaultState();
    roundPlaced = null;
    await saveState();
    await tgReply(msg.chat.id, '↺ Сброс. Баланс: $100');
  });

  tg.onText(/\/help/, async (msg) => {
    const text = [
      '<b>Команды:</b>',
      '/balance – Баланс и статистика',
      '/status – Текущий статус',
      '/price – Цена BTC',
      '/nextbet – Время до следующей ставки',
      '/startbot – Запустить бота',
      '/stopbot – Остановить бота',
      '/reset – Сбросить баланс до $100',
      '/help – Эта справка',
    ].join('\n');
    await tgReply(msg.chat.id, text);
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 15M Bot starting...');
  console.log('[INIT] Checking environment...');

  // Init Firebase
  const fbOk = initFirebase();
  if (!fbOk) {
    console.error('[FATAL] Firebase init failed. Check env vars.');
  }

  // Init Telegram
  const tgOk = initTelegram();
  if (!tgOk) {
    console.error('[FATAL] Telegram init failed. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
  }

  if (!fbOk && !tgOk) {
    console.error('[FATAL] Nothing works. Exiting.');
    process.exit(1);
  }

  // Load state
  console.log('[INIT] Loading state...');
  state = await loadState();
  console.log(`[INIT] State loaded. Balance: $${state.wallet.balance.toFixed(2)}`);

  // Connect price feed
  console.log('[INIT] Connecting price feed...');
  connectPriceWS();

  // Start fallback price fetcher
  setTimeout(fetchPriceFallback, 10000);

  // Setup listeners
  if (firebaseReady) listenForCommands();
  setupTelegramListeners();

  // Start main loop
  botStarted = true;
  setInterval(tick, 5000);
  console.log('[INIT] Main loop started (tick every 5s)');

  // Heartbeat
  setInterval(async () => {
    if (!firebaseReady) return;
    try {
      await db.ref('btc15m/heartbeat').set({
        ts: Date.now(),
        working: isWorkingHours(),
        userBotOn: _userBotOn,
        shouldRun: shouldBotRun(),
      });
    } catch(e) {}
  }, 30000);

  // Welcome message
  const hourMSK = (new Date().getUTCHours() + 3) % 24;
  if (tgOk) {
    const msg = [
      '🚀 <b>BTC 15M Бот запущен</b>',
      `💰 Баланс: $${state.wallet.balance.toFixed(2)}`,
      `⏰ МСК: ${hourMSK}:XX`,
      `📅 Расписание: 09:00–00:00`,
      `💵 Ставка: $${FIXED_BET} фикс`,
      `📈 BTC: $${Math.round(currentPrice)}`,
      `⏳ До ставки: ${getTimeToNextBet()}`,
    ].join('\n');
    await tgSend(msg);
    console.log('[INIT] Welcome message sent to Telegram');
  }

  // First tick
  await tick();
  console.log('[INIT] Bot fully started');
}

start().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
