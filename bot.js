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
    await tg.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true, ...getMainKeyboard() });
  } catch(e) {
    console.error('[TG] Send error:', e.message);
  }
}

async function tgReply(chatId, msg) {
  if (!tg) return;
  try {
    await tg.sendMessage(chatId, msg, { parse_mode: 'HTML', ...getMainKeyboard() });
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
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

function getTimeToNextBet() {
  const rem = roundRemain();
  const msToNext = rem > 0 ? rem : ROUND_MS + rem;
  const mins = Math.floor(msToNext / 60000);
  const secs = Math.floor((msToNext % 60000) / 1000);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
  } catch(e) {}
}

// ── AI SIGNAL ─────────────────────────────────────────────────────────
function aiSignal() {
  if (priceBuffer.length < 2) {
    return { direction: 'UP', confidence: 55, reason: 'UP (по умолчанию)', score: 0.5 };
  }
  let score = 0;
  const signals = [];
  if (priceBuffer.length >= 10) {
    const recent = priceBuffer.slice(-5);
    const older = priceBuffer.slice(-10, -5);
    const recentAvg = recent.reduce((a,b) => a+b, 0) / recent.length;
    const olderAvg = older.reduce((a,b) => a+b, 0) / older.length;
    if (recentAvg > olderAvg) { score += 1; signals.push('Цена▲'); }
    else { score -= 1; signals.push('Цена▼'); }
  }
  if (priceBuffer.length >= 3) {
    const last = priceBuffer[priceBuffer.length - 1];
    const prev = priceBuffer[priceBuffer.length - 3];
    if (last > prev) { score += 1; signals.push('Движ▲'); }
    else { score -= 1; signals.push('Движ▼'); }
  }
  if (pmUpProb > 0.55) { score += 2; signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`); }
  else if (pmUpProb < 0.45) { score -= 2; signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`); }
  else if (pmUpProb > 0.50) { score += 1; signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`); }
  else if (pmUpProb < 0.50) { score -= 1; signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`); }
  const dir = score >= 0 ? 'UP' : 'DOWN';
  const conf = Math.min(70, Math.max(53, 55 + Math.abs(score) * 3));
  return { direction: dir, confidence: conf, reason: `${dir} ${conf.toFixed(0)}% | ${signals.join(', ')}`, score };
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
  console.log(`[BOT] BET: ${sig.direction} $${FIXED_BET} | ${fmtWindow(rid)}`);
  await tgSend(`${dirEmoji} <b>${sig.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'}</b> · ${fmtWindow(rid)}\nВход: $${Math.round(currentPrice)} · Ставка: $${FIXED_BET}\nУверенность: ${sig.confidence}%\nБаланс: $${state.wallet.balance.toFixed(2)}`);
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
    state.wallet.wins++; state.stats.curStreak++; state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result = 'win'; bet.pnl = p;
    console.log(`[BOT] WIN +$${p.toFixed(2)} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`✅ <b>ВЫИГРЫШ</b> · ${bet.window}\n${bet.direction} · Вход: $${Math.round(bet.startPrice)} → Выход: $${Math.round(bet.endPrice)}\nПрибыль: +$${p.toFixed(2)} · Баланс: $${state.wallet.balance.toFixed(2)}\nСерия: ${state.stats.curStreak} · W/L: ${state.wallet.wins}/${state.wallet.losses}`);
  } else {
    state.wallet.pnl = parseFloat((state.wallet.pnl - FIXED_BET).toFixed(2));
    state.wallet.losses++; state.stats.curStreak = 0; state.stats.totalLoss += FIXED_BET;
    bet.result = 'loss'; bet.pnl = -FIXED_BET;
    console.log(`[BOT] LOSS -$${FIXED_BET} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`❌ <b>ПРОИГРЫШ</b> · ${bet.window}\n${bet.direction} · Вход: $${Math.round(bet.startPrice)} → Выход: $${Math.round(bet.endPrice)}\nПрибыль: -$${FIXED_BET} · Баланс: $${state.wallet.balance.toFixed(2)}\nW/L: ${state.wallet.wins}/${state.wallet.losses}`);
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
  if (rem < 10000 && rem > 0 && state.pendingBet?.result === 'pending') await resolveBet();
  if (rem > ROUND_MS - 20000 && shouldBotRun()) await placeBet(rid);
  if (!wsConnected && Date.now() % 30000 < 5000) await fetchPriceFallback();
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
    await tgReply(msg.chat.id, '🤖 <b>BTC 15M Bot</b>\nСтавка каждые 15 минут\n\nКоманды:\n/balance — Баланс\n/status — Статус\n/price — Цена BTC\n/nextbet — Время до ставки\n/startbot — Запуск\n/stopbot — Остановка\n/reset — Сброс');
  });

  tg.onText(/\/balance|💰 Баланс/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const w = state.wallet; const s = state.stats;
    const totalBets = w.wins + w.losses;
    const winRate = totalBets > 0 ? ((w.wins / totalBets) * 100).toFixed(0) : 0;
    await tgReply(msg.chat.id, `<b>💰 БАЛАНС</b>\n\nБаланс: $${w.balance.toFixed(2)}\nP&L: ${w.pnl >= 0 ? '+' : ''}$${w.pnl.toFixed(2)}\n\nВсего ставок: ${totalBets}\nВыигрышей: ${w.wins}\nПроигрышей: ${w.losses}\nWin rate: ${winRate}%\n\nТекущая серия: ${s.curStreak}\nРекорд: ${s.bestStreak}`);
  });

  tg.onText(/\/status|📊 Статус/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const now = new Date();
    const timeMSK = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
    const dateMSK = now.toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric', timeZone:'Europe/Moscow' });
    const w = state.wallet;
    const s = state.stats;
    const totalBets = w.wins + w.losses;
    const winRate = totalBets > 0 ? ((w.wins / totalBets) * 100).toFixed(0) : 0;
    const bet = state.pendingBet;
    const isActiveBet = bet && bet.result === 'pending';

    let activeBetInfo = '';
    if (isActiveBet) {
      const dirEmoji = bet.direction === 'UP' ? '🟢' : '🔴';
      const entryPrice = Math.round(bet.startPrice);
      const currentPx = Math.round(currentPrice);
      const priceDiff = currentPx - entryPrice;
      const diffSign = priceDiff >= 0 ? '+' : '';
      const diffUSD = diffSign + priceDiff;
      const pnlEstimate = bet.direction === 'UP' ? priceDiff : -priceDiff;
      const pnlSign = pnlEstimate >= 0 ? '+' : '';
      activeBetInfo = `\n<b>📌 АКТИВНАЯ СТАВКА</b>\n${dirEmoji} ${bet.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'} · ${bet.window}\nВход: $${entryPrice} → Сейчас: $${currentPx} (${diffUSD})\nСумма: $${bet.betAmount} · Уверенность: ${bet.confidence}%\nОценка P&L: ${pnlSign}$${pnlEstimate.toFixed(0)}`;
    } else {
      const lastBet = state.history[0];
      if (lastBet && lastBet.result !== 'skip') {
        const resultEmoji = lastBet.result === 'win' ? '✅' : '❌';
        const resultText = lastBet.result === 'win' ? 'ВЫИГРЫШ' : 'ПРОИГРЫШ';
        const pnlSign = lastBet.pnl >= 0 ? '+' : '';
        activeBetInfo = `\n<b>📌 ПОСЛЕДНЯЯ СТАВКА</b>\n${resultEmoji} ${resultText} · ${lastBet.window}\n${lastBet.direction} · Вход: $${Math.round(lastBet.startPrice)} → Выход: $${Math.round(lastBet.endPrice)}\nПрибыль: ${pnlSign}$${lastBet.pnl.toFixed(2)}`;
      } else if (lastBet && lastBet.result === 'skip') {
        activeBetInfo = `\n<b>📌 ПОСЛЕДНЯЯ СТАВКА</b>\n⏭ Пропуск · ${lastBet.window}`;
      }
    }

    const text = [
      `<b>📊 СТАТУС БОТА</b>`,
      ``,
      `🕐 ${dateMSK} · ${timeMSK} МСК`,
      ``,
      `───────────────`,
      ``,
      `🤖 Статус: ${_userBotOn ? '✅ АКТИВЕН' : '⏸ ОСТАНОВЛЕН'}`,
      `⏰ Расписание: ${isWorkingHours() ? '✅ Рабочее время' : '🌙 Нерабочее время'}`,
      ``,
      `📈 <b>BTC:</b> $${currentPrice.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`,
      ``,
      `───────────────`,
      ``,
      `💰 Баланс: $${w.balance.toFixed(2)} · P&L: ${w.pnl >= 0 ? '+' : ''}$${w.pnl.toFixed(2)}`,
      `📊 Ставок: ${totalBets} · Win rate: ${winRate}%`,
      `✅ Выигрышей: ${w.wins} · ❌ Проигрышей: ${w.losses}`,
      `🔥 Серия: ${s.curStreak} · 🏆 Рекорд: ${s.bestStreak}`,
      ``,
      `⏳ До следующей ставки: <b>${getTimeToNextBet()}</b>`,
      activeBetInfo,
    ].join('\n');

    await tgReply(msg.chat.id, text);
  });

  tg.onText(/\/price|📈 Цена BTC/, async (msg) => {
    const change = priceBuffer.length >= 2
      ? currentPrice - priceBuffer[priceBuffer.length - 2]
      : 0;
    const sign = change >= 0 ? '+' : '';
    await tgReply(msg.chat.id, `<b>📈 BTC</b>\n\nЦена: $${currentPrice.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}\nИзменение: ${sign}$${change.toFixed(2)}`);
  });

  tg.onText(/\/nextbet|⏳ След. ставка/, async (msg) => {
    await tgReply(msg.chat.id, `<b>⏳ ВРЕМЯ ДО СТАВКИ</b>\n\nСледующая ставка через: <b>${getTimeToNextBet()}</b>\n\nСтавка каждые 15 минут\nРасписание: 09:00–00:00 МСК`);
  });

  tg.onText(/\/startbot|▶ Старт/, async (msg) => {
    _userBotOn = true; await saveState();
    await tgReply(msg.chat.id, '▶ Бот запущен\nСтавки каждые 15 минут');
  });

  tg.onText(/\/stopbot|⏹ Стоп/, async (msg) => {
    _userBotOn = false; await saveState();
    await tgReply(msg.chat.id, '■ Бот остановлен');
  });

  tg.onText(/\/reset|🔄 Сброс/, async (msg) => {
    state = defaultState(); roundPlaced = null; await saveState();
    await tgReply(msg.chat.id, '↺ Сброс выполнен\nБаланс: $100.00');
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 15M Bot starting...');
  initFirebase();
  initTelegram();
  state = await loadState();
  console.log(`[INIT] Balance: $${state.wallet.balance.toFixed(2)}`);
  connectPriceWS();
  await fetchPriceFallback();
  console.log(`[INIT] BTC: $${Math.round(currentPrice)}`);
  if (firebaseReady) listenForCommands();
  setupTelegramListeners();
  botStarted = true;
  setInterval(tick, 3000);
  setInterval(async () => {
    if (!firebaseReady) return;
    try { await db.ref('btc15m/heartbeat').set({ ts:Date.now(), working:isWorkingHours(), userBotOn:_userBotOn, shouldRun:shouldBotRun() }); } catch(e) {}
  }, 30000);
  await tgSend(`🚀 <b>BTC 15M Бот запущен</b>\n\n💰 Баланс: $${state.wallet.balance.toFixed(2)}\n💵 Ставка: $${FIXED_BET} фикс\n📅 Расписание: 09:00–00:00 МСК\n⏱ Каждые 15 минут`);
  console.log('[INIT] Bot started');
  await tick();
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });