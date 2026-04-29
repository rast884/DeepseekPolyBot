const admin = require('firebase-admin');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ── TELEGRAM SETUP ────────────────────────────────────────────────────
let tg = null;
let TG_CHAT_ID = '';

function initTelegram() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.error('[TG] Missing tokens');
    return false;
  }
  try {
    tg = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    console.log('[TG] Started');
    return true;
  } catch(e) {
    console.error('[TG] Error:', e.message);
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
    await tg.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true, ...getMainKeyboard() });
  } catch(e) {}
}

async function tgReply(chatId, msg) {
  if (!tg) return;
  try {
    await tg.sendMessage(chatId, msg, { parse_mode: 'HTML', ...getMainKeyboard() });
  } catch(e) {}
}

// ── FIREBASE ──────────────────────────────────────────────────────────
let db = null;
let STATE_REF = null;
let firebaseReady = false;

function initFirebase() {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_DATABASE_URL) {
      console.error('[FB] Missing env vars');
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
    console.log('[FB] Initialized');
    return true;
  } catch(e) {
    console.error('[FB] Error:', e.message);
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
let lastTickLog = 0;

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
  if (!firebaseReady || !STATE_REF) return defaultState();
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const data = snap.val();
      data.history = (data.history || []).slice(0, 200);
      _userBotOn = data.botOn === true;
      console.log(`[STATE] Balance: $${data.wallet?.balance} | botOn: ${_userBotOn}`);
      return data;
    }
  } catch(e) {}
  return defaultState();
}

async function saveState() {
  if (!firebaseReady || !STATE_REF) return;
  try {
    state.savedAt = Date.now();
    state.botOn = _userBotOn;
    await STATE_REF.set(state);
  } catch(e) {}
}

const roundId = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain = () => roundId() + ROUND_MS - Date.now();
const fmtWindow = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

function getTimeToNextBet() {
  const rem = roundRemain();
  const msToNext = rem > 0 ? rem : ROUND_MS + rem;
  const mins = Math.floor(msToNext / 60000);
  const secs = Math.floor((msToNext % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2,'0')}`;
}

// ── PRICE FEED ────────────────────────────────────────────────────────
function connectPriceWS() {
  try {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');
    ws.on('open', () => {
      wsConnected = true;
      console.log('[WS] Connected');
      ws.send(JSON.stringify({ action:'subscribe', subscriptions:[{ topic:'crypto_prices_chainlink', type:'*', filters:JSON.stringify({ symbol:'btc/usd' }) }] }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.symbol === 'btc/usd') {
          const p = parseFloat(msg.payload.value);
          if (p > 0) { currentPrice = p; priceBuffer.push(p); if (priceBuffer.length > 300) priceBuffer.shift(); }
        }
      } catch(e) {}
    });
    ws.on('close', () => { wsConnected = false; setTimeout(connectPriceWS, 5000); });
    ws.on('error', () => { wsConnected = false; });
  } catch(e) { setTimeout(connectPriceWS, 10000); }
}

async function fetchPriceFallback() {
  try {
    const r = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT', { timeout:5000 });
    const d = await r.json();
    const t = d.result?.list?.[0];
    if (t) { currentPrice = parseFloat(t.lastPrice); priceBuffer.push(currentPrice); if (priceBuffer.length > 300) priceBuffer.shift(); }
  } catch(e) {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { timeout:5000 });
      const d = await r.json();
      if (d.bitcoin?.usd) { currentPrice = d.bitcoin.usd; priceBuffer.push(currentPrice); }
    } catch(e2) {}
  }
}

// ── POLYMARKET SENTIMENT ──────────────────────────────────────────────
let pmUpProb = 0.5, pmDownProb = 0.5, pmLastFetch = 0;
async function fetchPolymarketSentiment() {
  if (Date.now() - pmLastFetch < 30000) return;
  try {
    const nowSec = Math.floor(Date.now()/1000);
    const slug = `btc-updown-15m-${nowSec - (nowSec % 900)}`;
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout:4000 });
    if (!r.ok) return;
    const data = await r.json();
    const market = data?.[0]?.markets?.[0];
    if (!market) return;
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    pmUpProb = parseFloat(prices[0]) || 0.5;
    pmDownProb = parseFloat(prices[1]) || 0.5;
    pmLastFetch = Date.now();
    console.log(`[PM] UP:${(pmUpProb*100).toFixed(0)}% DOWN:${(pmDownProb*100).toFixed(0)}%`);
  } catch(e) {}
}

// ── ADVANCED SIGNAL (RSI + MACD + TREND + PM) ────────────────────────
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const changes = [];
  for (let i = prices.length - period; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const gains = changes.filter(c => c > 0).reduce((a,b) => a+b, 0) / period;
  const losses = changes.filter(c => c < 0).map(c => Math.abs(c)).reduce((a,b) => a+b, 0) / period;
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function aiSignal() {
  if (priceBuffer.length < 20) {
    // Мало данных — ставим по последней свече
    if (priceBuffer.length >= 2) {
      const dir = priceBuffer[priceBuffer.length-1] >= priceBuffer[priceBuffer.length-2] ? 'UP' : 'DOWN';
      return { direction: dir, confidence: 52, reason: `${dir} (min data)`, score: 0 };
    }
    return { direction: 'UP', confidence: 50, reason: 'UP (default)', score: 0 };
  }

  let score = 0;
  const signals = [];

  // 1. RSI
  const rsi = calcRSI(priceBuffer);
  if (rsi < 35) { score += 3; signals.push(`RSI:${rsi.toFixed(0)}▲`); }
  else if (rsi > 65) { score -= 3; signals.push(`RSI:${rsi.toFixed(0)}▼`); }
  else if (rsi > 50) { score += 1; signals.push(`RSI:${rsi.toFixed(0)}▲`); }
  else { score -= 1; signals.push(`RSI:${rsi.toFixed(0)}▼`); }

  // 2. EMA тренд
  const ema9 = calcEMA(priceBuffer, 9);
  const ema21 = calcEMA(priceBuffer, 21);
  if (ema9 > ema21) { score += 2; signals.push('EMA▲'); }
  else { score -= 2; signals.push('EMA▼'); }

  // 3. MACD (упрощённый)
  const ema12 = calcEMA(priceBuffer, 12);
  const ema26 = calcEMA(priceBuffer, 26);
  const macd = ema12 - ema26;
  if (macd > 0) { score += 1.5; signals.push('MACD▲'); }
  else { score -= 1.5; signals.push('MACD▼'); }

  // 4. Краткосрочный моментум
  if (priceBuffer.length >= 6) {
    const now5 = priceBuffer.slice(-5).reduce((a,b)=>a+b,0)/5;
    const prev5 = priceBuffer.slice(-10, -5).reduce((a,b)=>a+b,0)/5;
    if (now5 > prev5) { score += 1.5; signals.push('5m▲'); }
    else { score -= 1.5; signals.push('5m▼'); }
  }

  // 5. Polymarket
  if (pmUpProb > 0.60) { score += 3; signals.push(`PM:${(pmUpProb*100).toFixed(0)}%▲`); }
  else if (pmDownProb > 0.60) { score -= 3; signals.push(`PM:${(pmDownProb*100).toFixed(0)}%▼`); }
  else if (pmUpProb > 0.52) { score += 1.5; signals.push(`PM:${(pmUpProb*100).toFixed(0)}%▲`); }
  else if (pmDownProb > 0.52) { score -= 1.5; signals.push(`PM:${(pmDownProb*100).toFixed(0)}%▼`); }

  // 6. Волатильность
  if (priceBuffer.length >= 20) {
    const last20 = priceBuffer.slice(-20);
    const high = Math.max(...last20);
    const low = Math.min(...last20);
    const range = ((high - low) / low) * 100;
    if (range < 0.15) { score *= 0.5; signals.push(`Флет:${range.toFixed(2)}%`); }
    else if (range > 0.5) { score *= 1.2; signals.push(`Вола:${range.toFixed(2)}%`); }
  }

  const dir = score > 0 ? 'UP' : 'DOWN';
  const absScore = Math.abs(score);
  const conf = Math.min(80, Math.max(51, 50 + absScore * 3));

  return {
    direction: dir,
    confidence: parseFloat(conf.toFixed(0)),
    reason: `${dir} ${conf.toFixed(0)}% | ${signals.join(' | ')}`,
    score: parseFloat(score.toFixed(1))
  };
}

// ── BOT LOGIC ─────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced === rid) return;
  if (!botStarted) return;
  if (!shouldBotRun()) return;
  if (state.wallet.balance < FIXED_BET) {
    await tgSend('❌ Баланс < $5. Остановка.');
    _userBotOn = false; await saveState(); return;
  }

  console.log(`[BOT] ██████ НОВАЯ СТАВКА ${fmtWindow(rid)} ██████`);
  roundPlaced = rid;
  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const sig = aiSignal();

  state.wallet.balance = parseFloat((state.wallet.balance - FIXED_BET).toFixed(2));
  state.wallet.totalBet += FIXED_BET;
  state.lastRoundId = rid;
  state.pendingBet = {
    id:rid, direction:sig.direction, confidence:sig.confidence,
    reason:sig.reason, betAmount:FIXED_BET, startPrice:currentPrice,
    endPrice:null, window:fmtWindow(rid), result:'pending', pnl:0,
    ts:new Date().toISOString()
  };
  await saveState();

  const dirEmoji = sig.direction === 'UP' ? '🟢' : '🔴';
  console.log(`[BOT] >>> BET: ${sig.direction} | Score: ${sig.score} | ${sig.reason}`);
  await tgSend(`${dirEmoji} <b>${sig.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'}</b> · ${fmtWindow(rid)}\nВход: $${Math.round(currentPrice).toLocaleString()} · $${FIXED_BET}\nСигнал: ${sig.reason}\nБаланс: $${state.wallet.balance.toFixed(2)}`);
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;

  console.log(`[BOT] ██ РЕЗОЛВ ${fmtWindow(bet.id)} ██`);
  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;
  const up = bet.endPrice >= bet.startPrice;
  const won = (bet.direction === 'UP' && up) || (bet.direction === 'DOWN' && !up);

  if (won) {
    const p = parseFloat((FIXED_BET * WIN_MULT).toFixed(2));
    state.wallet.balance = parseFloat((state.wallet.balance + FIXED_BET + p).toFixed(2));
    state.wallet.pnl = parseFloat((state.wallet.pnl + p).toFixed(2));
    state.wallet.wins++; state.stats.curStreak++; state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result = 'win'; bet.pnl = p;
    console.log(`[BOT] >>> WIN +$${p.toFixed(2)} | Balance: $${state.wallet.balance.toFixed(2)} | Streak: ${state.stats.curStreak}`);
    await tgSend(`✅ <b>ВЫИГРЫШ #${state.wallet.wins}</b>\n${bet.direction} · ${bet.window}\nВход: $${Math.round(bet.startPrice).toLocaleString()} → Выход: $${Math.round(bet.endPrice).toLocaleString()}\nПрибыль: +$${p.toFixed(2)} · Баланс: $${state.wallet.balance.toFixed(2)}\nСерия: ${state.stats.curStreak} · W/L: ${state.wallet.wins}/${state.wallet.losses}`);
  } else {
    state.wallet.pnl = parseFloat((state.wallet.pnl - FIXED_BET).toFixed(2));
    state.wallet.losses++; state.stats.curStreak = 0; state.stats.totalLoss += FIXED_BET;
    bet.result = 'loss'; bet.pnl = -FIXED_BET;
    console.log(`[BOT] >>> LOSS -$${FIXED_BET} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`❌ <b>ПРОИГРЫШ #${state.wallet.losses}</b>\n${bet.direction} · ${bet.window}\nВход: $${Math.round(bet.startPrice).toLocaleString()} → Выход: $${Math.round(bet.endPrice).toLocaleString()}\nПрибыль: -$${FIXED_BET} · Баланс: $${state.wallet.balance.toFixed(2)}\nW/L: ${state.wallet.wins}/${state.wallet.losses}`);
  }

  bet.balanceAfter = state.wallet.balance;
  state.history.unshift({ ...bet });
  if (state.history.length > 200) state.history = state.history.slice(0,200);
  state.pendingBet = null;
  await saveState();

  if (state.wallet.balance < FIXED_BET) {
    _userBotOn = false; await saveState();
    await tgSend('⚠️ Баланс < $5. Бот остановлен.');
  }
}

// ── MAIN TICK ─────────────────────────────────────────────────────────
async function tick() {
  if (!state || !botStarted) return;
  const rid = roundId();
  const rem = roundRemain();

  // Лог каждые 30 секунд
  if (Date.now() - lastTickLog > 30000) {
    console.log(`[TICK] ${fmtWindow(rid)} | Rem: ${Math.floor(rem/1000)}s | BTC: $${Math.round(currentPrice)} | Run: ${shouldBotRun()} | Buffer: ${priceBuffer.length}`);
    lastTickLog = Date.now();
  }

  // Резолв за 10 секунд до конца (и до 1 секунды после)
  if (rem < 10000 && rem > -2000 && state.pendingBet?.result === 'pending') {
    await resolveBet();
  }

  // Ставка в первые 12 секунд нового раунда
  if (rem > ROUND_MS - 12000 && shouldBotRun()) {
    await placeBet(rid);
  }

  // Подстраховка: если пропустили окно ставки, ставим в любую секунду до 30-й
  if (rem > ROUND_MS - 30000 && roundPlaced !== rid && shouldBotRun()) {
    await placeBet(rid);
  }

  if (!wsConnected && Date.now() % 30000 < 3000) {
    await fetchPriceFallback();
  }
}

// ── LISTENERS ─────────────────────────────────────────────────────────
function listenForCommands() {
  if (!firebaseReady) return;
  STATE_REF.child('botOn').on('value', async snap => {
    const val = snap.val();
    if (typeof val === 'boolean' && val !== _userBotOn) {
      _userBotOn = val;
      await tgSend(_userBotOn ? '▶ Бот запущен' : '■ Бот остановлен');
    }
  });
  db.ref('btc15m/command').on('value', async snap => {
    if (snap.val() === 'reset') {
      state = defaultState(); roundPlaced = null; await saveState();
      await db.ref('btc15m/command').remove();
      await tgSend('↺ Сброс. Баланс: $100');
    }
  });
}

// ── TELEGRAM COMMANDS ─────────────────────────────────────────────────
function setupTelegramListeners() {
  if (!tg) return;

  tg.onText(/\/start/, async (msg) => {
    await tgReply(msg.chat.id, '🤖 <b>BTC 15M</b>\nСтавка $5 каждые 15 мин\nRSI + EMA + MACD + Polymarket');
  });

  tg.onText(/\/balance|💰 Баланс/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const w = state.wallet; const s = state.stats;
    const total = w.wins + w.losses;
    const wr = total > 0 ? ((w.wins/total)*100).toFixed(0) : 0;
    await tgReply(msg.chat.id, `<b>💰 БАЛАНС</b>\n\n$${w.balance.toFixed(2)} · P&L: ${w.pnl>=0?'+':''}$${w.pnl.toFixed(2)}\nСтавок: ${total} · WR: ${wr}%\nW:${w.wins} L:${w.losses}\nСерия: ${s.curStreak} · Рекорд: ${s.bestStreak}`);
  });

  tg.onText(/\/status|📊 Статус/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const now = new Date();
    const timeMSK = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
    const w = state.wallet; const s = state.stats;
    const total = w.wins + w.losses;
    const wr = total > 0 ? ((w.wins/total)*100).toFixed(0) : 0;
    const bet = state.pendingBet;
    let betInfo = '';
    if (bet && bet.result === 'pending') {
      const diff = Math.round(currentPrice) - Math.round(bet.startPrice);
      const sign = diff >= 0 ? '+' : '';
      betInfo = `\n<b>📌 АКТИВНАЯ</b>\n${bet.direction==='UP'?'🟢 ВВЕРХ':'🔴 ВНИЗ'} · ${bet.window}\n$${Math.round(bet.startPrice).toLocaleString()} → $${Math.round(currentPrice).toLocaleString()} (${sign}$${diff})`;
    }
    await tgReply(msg.chat.id, `📊 <b>СТАТУС</b> · ${timeMSK} МСК\n\n🤖 ${_userBotOn?'✅':'⏸'} | ⏰ ${isWorkingHours()?'✅':'🌙'}\nBTC: $${Math.round(currentPrice).toLocaleString()}\n💰 $${w.balance.toFixed(2)} · P&L: ${w.pnl>=0?'+':''}$${w.pnl.toFixed(2)}\nСтавок: ${total} · WR: ${wr}%\n⏳ До ставки: ${getTimeToNextBet()}${betInfo}`);
  });

  tg.onText(/\/price|📈 Цена BTC/, async (msg) => {
    const rsi = priceBuffer.length >= 15 ? calcRSI(priceBuffer).toFixed(0) : '—';
    await tgReply(msg.chat.id, `📈 <b>BTC</b>\n$${Math.round(currentPrice).toLocaleString()}\nRSI(14): ${rsi}`);
  });

  tg.onText(/\/nextbet|⏳ След. ставка/, async (msg) => {
    await tgReply(msg.chat.id, `⏳ Ставка через: <b>${getTimeToNextBet()}</b>`);
  });

  tg.onText(/\/startbot|▶ Старт/, async (msg) => {
    _userBotOn = true; await saveState();
    await tgReply(msg.chat.id, '▶ Бот запущен');
  });

  tg.onText(/\/stopbot|⏹ Стоп/, async (msg) => {
    _userBotOn = false; await saveState();
    await tgReply(msg.chat.id, '■ Бот остановлен');
  });

  tg.onText(/\/reset|🔄 Сброс/, async (msg) => {
    state = defaultState(); roundPlaced = null; await saveState();
    await tgReply(msg.chat.id, '↺ Сброс. $100');
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 15M Bot v2.0 — RSI+EMA+MACD+PM');

  initFirebase();
  initTelegram();

  state = await loadState();
  if (state.pendingBet?.result === 'pending') {
    console.log('[INIT] Clearing stale pending bet');
    state.pendingBet = null;
    await saveState();
  }
  console.log(`[INIT] Balance: $${state.wallet.balance.toFixed(2)}`);

  connectPriceWS();
  await fetchPriceFallback();
  console.log(`[INIT] BTC: $${Math.round(currentPrice)}`);

  if (firebaseReady) listenForCommands();
  setupTelegramListeners();

  botStarted = true;
  setInterval(tick, 2000);

  setInterval(async () => {
    if (!firebaseReady) return;
    try { await db.ref('btc15m/heartbeat').set({ ts:Date.now(), working:isWorkingHours(), userBotOn:_userBotOn, shouldRun:shouldBotRun() }); } catch(e) {}
  }, 30000);

  await tgSend(`🚀 <b>BTC 15M v2.0</b>\n💰 $${state.wallet.balance.toFixed(2)}\n💵 Ставка: $5 / 15 мин\n📊 RSI+EMA+MACD+PM`);
  console.log('[INIT] ✅ Bot is live');
  await tick();
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });