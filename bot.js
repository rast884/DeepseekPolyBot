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

// ── КАЛЕНДАРЬ ─────────────────────────────────────────────────────────
function getTimeCategory() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Вс, 1=Пн, ..., 6=Сб
  const hourUTC = now.getUTCHours();
  const hourMSK = (hourUTC + 3) % 24;

  // Выходные: Сб(6) Вс(0) — бот не работает
  if (day === 0 || day === 6) {
    return { allowed: false, reason: 'Выходной', quality: 0 };
  }

  // Пятница после 21:00 МСК (18:00 UTC) — фиксация прибыли
  if (day === 5 && hourMSK >= 21) {
    return { allowed: false, reason: 'Вечер пятницы', quality: 0 };
  }

  // Прайм-тайм 17:00–23:00 МСК (14:00–20:00 UTC) — максимальная ликвидность
  if (hourMSK >= 17 && hourMSK < 23) {
    return { allowed: true, reason: 'Прайм-тайм', quality: 5 };
  }

  // Европейская сессия 12:00–17:00 МСК (9:00–14:00 UTC)
  if (hourMSK >= 12 && hourMSK < 17) {
    return { allowed: true, reason: 'Европа', quality: 4 };
  }

  // Утро 09:00–12:00 МСК (6:00–9:00 UTC) — низкая ликвидность
  if (hourMSK >= 9 && hourMSK < 12) {
    return { allowed: true, reason: 'Утро', quality: 2 };
  }

  // Ночь 00:00–09:00 МСК
  return { allowed: false, reason: 'Ночь', quality: 0 };
}

// ── HELPERS ───────────────────────────────────────────────────────────
function shouldBotRun() {
  const tc = getTimeCategory();
  return _userBotOn && tc.allowed;
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

// ── ИНДИКАТОРЫ ───────────────────────────────────────────────────────
function calcATR(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    sum += Math.abs(prices[i] - prices[i - 1]);
  }
  return sum / period;
}

// ── СИГНАЛ С ТРОЙНЫМ ФИЛЬТРОМ ────────────────────────────────────────
function aiSignal() {
  if (priceBuffer.length < 60) {
    return { direction: 'UP', skip: true, reason: 'Недостаточно данных', score: 0, filters: {} };
  }

  const prices = priceBuffer.slice(-120);
  const tc = getTimeCategory();
  const filters = { trend: false, pm: false, atr: false };
  const details = [];

  // 1. ФИЛЬТР ТРЕНДА — цена прошла > $80 за 30 минут
  const recent30 = prices.slice(-60); // ~30 мин при тике каждые 30 сек
  const older30 = prices.slice(-120, -60);
  if (recent30.length >= 10 && older30.length >= 10) {
    const recentAvg = recent30.reduce((a,b) => a+b, 0) / recent30.length;
    const olderAvg = older30.reduce((a,b) => a+b, 0) / older30.length;
    const trendStrength = recentAvg - olderAvg;
    const absTrend = Math.abs(trendStrength);

    if (absTrend > 80) {
      filters.trend = true;
      details.push(`Тренд $${absTrend.toFixed(0)}`);
    } else {
      details.push(`Тренд слабый $${absTrend.toFixed(0)}`);
    }
  }

  // 2. ФИЛЬТР POLYMARKET — дисбаланс > 20%
  const pmSpread = pmUpProb - pmDownProb;
  if (Math.abs(pmSpread) > 0.20) {
    filters.pm = true;
    details.push(`PM: ${pmUpProb > pmDownProb ? '▲' : '▼'}${(Math.abs(pmSpread)*100).toFixed(0)}%`);
  } else {
    details.push(`PM: ${(pmSpread*100).toFixed(0)}%`);
  }

  // 3. ФИЛЬТР ВОЛАТИЛЬНОСТИ — ATR > 0.05%
  const atr = calcATR(prices, 14);
  const atrPercent = atr ? (atr / currentPrice) * 100 : 0;
  if (atrPercent > 0.05) {
    filters.atr = true;
    details.push(`ATR: ${atrPercent.toFixed(3)}%`);
  } else {
    details.push(`ATR низкий: ${atrPercent.toFixed(3)}%`);
  }

  // ТРЕБУЕМ ВЫПОЛНЕНИЕ ВСЕХ ТРЁХ ФИЛЬТРОВ
  // + бонус: в утренние часы (quality <= 2) требуем больший тренд ($120+)
  let trendPass = filters.trend;
  if (tc.quality <= 2) {
    const recent30_2 = prices.slice(-60);
    const older30_2 = prices.slice(-120, -60);
    if (recent30_2.length >= 10 && older30_2.length >= 10) {
      const recentAvg2 = recent30_2.reduce((a,b) => a+b, 0) / recent30_2.length;
      const olderAvg2 = older30_2.reduce((a,b) => a+b, 0) / older30_2.length;
      trendPass = Math.abs(recentAvg2 - olderAvg2) > 120;
      if (!trendPass) details.push('Утро: нужен тренд $120+');
    }
  }

  const allPass = trendPass && filters.pm && filters.atr;

  if (!allPass) {
    return {
      direction: 'UP',
      skip: true,
      reason: `Фильтры: тренд=${trendPass?'✅':'❌'} PM=${filters.pm?'✅':'❌'} ATR=${filters.atr?'✅':'❌'} | ${details.join(' | ')} | ${tc.reason}`,
      score: 0,
      filters: { trend: trendPass, pm: filters.pm, atr: filters.atr }
    };
  }

  // Определяем направление
  const recentAvg = recent30.reduce((a,b) => a+b, 0) / recent30.length;
  const olderAvg = older30.reduce((a,b) => a+b, 0) / older30.length;
  const trendDir = recentAvg > olderAvg ? 'UP' : 'DOWN';

  // Если Polymarket противоречит тренду — пропускаем
  if (trendDir === 'UP' && pmDownProb > 0.55) {
    return { direction: 'UP', skip: true, reason: 'PM против тренда', score: 0, filters };
  }
  if (trendDir === 'DOWN' && pmUpProb > 0.55) {
    return { direction: 'DOWN', skip: true, reason: 'PM против тренда', score: 0, filters };
  }

  return {
    direction: trendDir,
    skip: false,
    reason: `${trendDir} | Тренд+PM+ATR ✅ | ${tc.reason} (Q${tc.quality})`,
    score: tc.quality * 2,
    filters,
    details: details.join(' | '),
    quality: tc.quality,
    timeCategory: tc.reason
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
  roundPlaced = rid;

  if (!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();

  const sig = aiSignal();

  if (sig.skip) {
    console.log(`[BOT] ⏭ SKIP: ${sig.reason}`);
    state.lastRoundId = rid;
    state.history.unshift({
      id: rid, direction: sig.direction || 'NONE', confidence: 0,
      reason: sig.reason, betAmount: 0, startPrice: currentPrice,
      endPrice: null, window: fmtWindow(rid), result: 'skip', pnl: 0,
      balanceAfter: state.wallet.balance, ts: new Date().toISOString()
    });
    if (state.history.length > 200) state.history = state.history.slice(0, 200);
    await saveState();
    return;
  }

  state.wallet.balance = parseFloat((state.wallet.balance - FIXED_BET).toFixed(2));
  state.wallet.totalBet += FIXED_BET;
  state.lastRoundId = rid;
  state.pendingBet = {
    id: rid, direction: sig.direction, confidence: Math.min(85, 60 + sig.quality * 5),
    reason: sig.reason, betAmount: FIXED_BET, startPrice: currentPrice,
    endPrice: null, window: fmtWindow(rid), result: 'pending', pnl: 0,
    ts: new Date().toISOString()
  };
  await saveState();

  const dirEmoji = sig.direction === 'UP' ? '🟢' : '🔴';
  const filterStatus = sig.filters
    ? `Тренд:✅ | PM:✅ | ATR:✅`
    : 'Все фильтры пройдены';

  console.log(`[BOT] ✅ BET: ${sig.direction} $${FIXED_BET} | ${fmtWindow(rid)} | ${sig.reason}`);
  await tgSend([
    `${dirEmoji} <b>${sig.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'}</b> · ${fmtWindow(rid)}`,
    `Вход: $${Math.round(currentPrice)} · Ставка: $${FIXED_BET}`,
    `${filterStatus}`,
    `⚡ ${sig.timeCategory} (Q${sig.quality})`,
    `${sig.details || ''}`,
    `Баланс: $${state.wallet.balance.toFixed(2)}`,
  ].join('\n'));
}

async function resolveBet() {
  const bet = state.pendingBet;
  if (!bet || bet.result !== 'pending') return;
  if (!wsConnected) await fetchPriceFallback();
  bet.endPrice = currentPrice;
  const up = bet.endPrice >= bet.startPrice;
  const won = (bet.direction === 'UP' && up) || (bet.direction === 'DOWN' && !up);
  const priceChange = bet.endPrice - bet.startPrice;
  const priceChangePct = ((priceChange / bet.startPrice) * 100).toFixed(3);

  if (won) {
    const p = parseFloat((FIXED_BET * WIN_MULT).toFixed(2));
    state.wallet.balance = parseFloat((state.wallet.balance + FIXED_BET + p).toFixed(2));
    state.wallet.pnl = parseFloat((state.wallet.pnl + p).toFixed(2));
    state.wallet.wins++; state.stats.curStreak++; state.stats.totalWin += p;
    if (state.stats.curStreak > state.stats.bestStreak) state.stats.bestStreak = state.stats.curStreak;
    bet.result = 'win'; bet.pnl = p;
    console.log(`[BOT] WIN +$${p.toFixed(2)} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`✅ <b>ВЫИГРЫШ</b> · ${bet.window}\n${bet.direction} · $${Math.round(bet.startPrice)} → $${Math.round(bet.endPrice)}\nΔ: ${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(2)} (${priceChangePct}%)\nПрибыль: +$${p.toFixed(2)} · Баланс: $${state.wallet.balance.toFixed(2)}\nСерия: ${state.stats.curStreak} · W/L: ${state.wallet.wins}/${state.wallet.losses}`);
  } else {
    state.wallet.pnl = parseFloat((state.wallet.pnl - FIXED_BET).toFixed(2));
    state.wallet.losses++; state.stats.curStreak = 0; state.stats.totalLoss += FIXED_BET;
    bet.result = 'loss'; bet.pnl = -FIXED_BET;
    console.log(`[BOT] LOSS -$${FIXED_BET} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`❌ <b>ПРОИГРЫШ</b> · ${bet.window}\n${bet.direction} · $${Math.round(bet.startPrice)} → $${Math.round(bet.endPrice)}\nΔ: ${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(2)} (${priceChangePct}%)\nУбыток: -$${FIXED_BET} · Баланс: $${state.wallet.balance.toFixed(2)}\nW/L: ${state.wallet.wins}/${state.wallet.losses}`);
  }
  bet.balanceAfter = state.wallet.balance;
  state.history.unshift({ ...bet });
  if (state.history.length > 200) state.history = state.history.slice(0, 200);
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
    await tgReply(msg.chat.id, '🤖 <b>BTC 15M v3</b>\nТройной фильтр + Календарь\n\n/balance /status /price /nextbet\n/startbot /stopbot /reset');
  });

  tg.onText(/\/balance|💰 Баланс/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const w = state.wallet; const s = state.stats;
    const totalBets = w.wins + w.losses;
    const winRate = totalBets > 0 ? ((w.wins / totalBets) * 100).toFixed(0) : 0;
    await tgReply(msg.chat.id, `<b>💰 БАЛАНС</b>\n\nБаланс: $${w.balance.toFixed(2)}\nP&L: ${w.pnl >= 0 ? '+' : ''}$${w.pnl.toFixed(2)}\n\nСтавок: ${totalBets}\nПобед: ${w.wins}\nПоражений: ${w.losses}\nWin rate: ${winRate}%\n\nСерия: ${s.curStreak}\nРекорд: ${s.bestStreak}`);
  });

  tg.onText(/\/status|📊 Статус/, async (msg) => {
    if (!state) { await tgReply(msg.chat.id, '⏳ Загрузка...'); return; }
    const now = new Date();
    const timeMSK = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Europe/Moscow' });
    const tc = getTimeCategory();
    const w = state.wallet; const s = state.stats;
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
      activeBetInfo = `\n<b>📌 АКТИВНАЯ СТАВКА</b>\n${dirEmoji} ${bet.direction} · ${bet.window}\nВход: $${entryPrice} → $${currentPx} (${diffSign}${priceDiff})\nСумма: $${bet.betAmount}`;
    }

    await tgReply(msg.chat.id, [
      `<b>📊 СТАТУС</b>`,
      `🕐 ${timeMSK} МСК`,
      ``,
      `🤖 ${_userBotOn ? '✅ АКТИВЕН' : '⏸ ОСТАНОВЛЕН'}`,
      `📅 ${tc.allowed ? '✅ ' + tc.reason : '🚫 ' + tc.reason} (Q${tc.quality})`,
      `📈 BTC: $${currentPrice.toLocaleString('en-US', {minimumFractionDigits:2})}`,
      ``,
      `💰 $${w.balance.toFixed(2)} · P&L ${w.pnl >= 0 ? '+' : ''}$${w.pnl.toFixed(2)}`,
      `📊 Ставок: ${totalBets} · WR: ${winRate}%`,
      `🔥 Серия: ${s.curStreak} · 🏆 ${s.bestStreak}`,
      ``,
      `⏳ Ставка через: ${getTimeToNextBet()}`,
      `🎯 Фильтры: Тренд $80+ | PM 20%+ | ATR 0.05%+`,
      activeBetInfo
    ].join('\n'));
  });

  tg.onText(/\/price|📈 Цена BTC/, async (msg) => {
    await tgReply(msg.chat.id, `📈 BTC: $${currentPrice.toLocaleString('en-US', {minimumFractionDigits:2})}`);
  });

  tg.onText(/\/nextbet|⏳ След. ставка/, async (msg) => {
    const tc = getTimeCategory();
    await tgReply(msg.chat.id, `⏳ Ставка через: ${getTimeToNextBet()}\n📅 ${tc.reason} | ${tc.allowed ? '✅ Торгуем' : '🚫 Пропуск'}`);
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
    await tgReply(msg.chat.id, '↺ Сброс. Баланс: $100');
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 15M v3 — Тройной фильтр + Календарь');

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
    const tc = getTimeCategory();
    try { await db.ref('btc15m/heartbeat').set({ ts:Date.now(), working:tc.allowed, userBotOn:_userBotOn, shouldRun:shouldBotRun(), timeCategory:tc.reason, quality:tc.quality }); } catch(e) {}
  }, 30000);

  const tc = getTimeCategory();
  await tgSend([
    `🚀 <b>BTC 15M v3</b>`,
    `💰 $${state.wallet.balance.toFixed(2)}`,
    `💵 Ставка: $${FIXED_BET}`,
    ``,
    `🎯 <b>Тройной фильтр:</b>`,
    `1. Тренд $80+ за 30 мин`,
    `2. Polymarket дисбаланс > 20%`,
    `3. ATR > 0.05%`,
    ``,
    `📅 <b>Календарь:</b>`,
    `✅ Вт–Чт 17:00–23:00 МСК — прайм-тайм`,
    `✅ Пн, Пт до 21:00 — Европа`,
    `⚠️ Утро 09:00–12:00 — усиленный фильтр`,
    `🚫 Сб–Вс, Пт вечер — выходной`,
    ``,
    `Сейчас: ${tc.reason} | ${tc.allowed ? '✅ Торгуем' : '🚫 Пропуск'}`,
  ].join('\n'));

  await tick();
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });