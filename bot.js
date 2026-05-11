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

// ── S&P 500 SHADOW ────────────────────────────────────────────────────
let spxPrice = 0;
let spxBuffer = [];
let spxLastFetch = 0;

async function fetchSPX() {
  if (Date.now() - spxLastFetch < 15000) return;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=1d&interval=1m', { timeout:5000 });
    const d = await r.json();
    const timestamps = d.chart?.result?.[0]?.timestamp || [];
    const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    if (quotes.length > 0) {
      spxPrice = quotes[quotes.length - 1];
      spxBuffer = quotes.filter(q => q !== null);
      spxLastFetch = Date.now();
      console.log(`[SPX] $${spxPrice?.toFixed(2)} | Points: ${spxBuffer.length}`);
    }
  } catch(e) {
    console.error('[SPX] Fetch error:', e.message);
  }
}

function getSPXSignal() {
  if (spxBuffer.length < 5) return { direction: null, score: 0, reason: 'Нет данных SPX' };
  const recent3 = spxBuffer.slice(-3);
  const prev3 = spxBuffer.slice(-6, -3);
  if (prev3.length < 3) return { direction: null, score: 0, reason: 'SPX мало данных' };
  const recentAvg = recent3.reduce((a,b) => a+b, 0) / 3;
  const prevAvg = prev3.reduce((a,b) => a+b, 0) / 3;
  const change = ((recentAvg - prevAvg) / prevAvg) * 100;
  let score = 0;
  let reason = '';
  if (change > 0.05) { score = 2; reason = `SPX:${change>0?'+':''}${change.toFixed(3)}%▲`; }
  else if (change < -0.05) { score = -2; reason = `SPX:${change.toFixed(3)}%▼`; }
  else if (change > 0.02) { score = 1; reason = `SPX:${change>0?'+':''}${change.toFixed(3)}%▲`; }
  else if (change < -0.02) { score = -1; reason = `SPX:${change.toFixed(3)}%▼`; }
  else { reason = `SPX:${change>0?'+':''}${change.toFixed(3)}%→нейтр`; }
  return { direction: score > 0 ? 'UP' : score < 0 ? 'DOWN' : null, score, reason };
}

// ── DXY INVERSE ───────────────────────────────────────────────────────
let dxyPrice = 0;
let dxyBuffer = [];
let dxyLastFetch = 0;

async function fetchDXY() {
  if (Date.now() - dxyLastFetch < 15000) return;
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1d&interval=1m', { timeout:5000 });
    const d = await r.json();
    const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    if (quotes.length > 0) {
      dxyPrice = quotes[quotes.length - 1];
      dxyBuffer = quotes.filter(q => q !== null);
      dxyLastFetch = Date.now();
      console.log(`[DXY] ${dxyPrice?.toFixed(2)} | Points: ${dxyBuffer.length}`);
    }
  } catch(e) {
    console.error('[DXY] Fetch error:', e.message);
  }
}

function getDXYSignal() {
  if (dxyBuffer.length < 5) return { direction: null, score: 0, reason: 'Нет данных DXY' };
  const recent3 = dxyBuffer.slice(-3);
  const prev3 = dxyBuffer.slice(-6, -3);
  if (prev3.length < 3) return { direction: null, score: 0, reason: 'DXY мало данных' };
  const recentAvg = recent3.reduce((a,b) => a+b, 0) / 3;
  const prevAvg = prev3.reduce((a,b) => a+b, 0) / 3;
  const change = ((recentAvg - prevAvg) / prevAvg) * 100;
  // DXY inverse: DXY up → BTC down, DXY down → BTC up
  let score = 0;
  let reason = '';
  if (change > 0.05) { score = -2; reason = `DXY:${change>0?'+':''}${change.toFixed(3)}%▼→BTC▲`; }
  else if (change < -0.05) { score = 2; reason = `DXY:${change.toFixed(3)}%▲→BTC▲`; }
  else if (change > 0.02) { score = -1; reason = `DXY:${change>0?'+':''}${change.toFixed(3)}%▼→BTC▲`; }
  else if (change < -0.02) { score = 1; reason = `DXY:${change.toFixed(3)}%▲→BTC▲`; }
  else { reason = `DXY:${change>0?'+':''}${change.toFixed(3)}%→нейтр`; }
  return { direction: score > 0 ? 'UP' : score < 0 ? 'DOWN' : null, score, reason };
}

// ── TWITTER VELOCITY (X API v2) ───────────────────────────────────────
let tweetSentiment = 0;
let tweetCount = 0;
let tweetLastFetch = 0;

async function fetchTweetSentiment() {
  if (!process.env.TWITTER_BEARER_TOKEN) return;
  if (Date.now() - tweetLastFetch < 60000) return;
  try {
    const keywords = ['bitcoin', 'btc', 'crypto'];
    const query = keywords.map(k => `(${k} (pump OR dump OR moon OR crash OR long OR short))`).join(' OR ');
    const r = await fetch(`https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=20&tweet.fields=created_at`, {
      headers: { 'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}` }
    });
    if (!r.ok) return;
    const data = await r.json();
    const tweets = data.data || [];
    let bullish = 0, bearish = 0;
    const bullWords = ['pump', 'moon', 'long', 'buy', 'bullish', 'green'];
    const bearWords = ['dump', 'crash', 'short', 'sell', 'bearish', 'red'];
    for (const t of tweets) {
      const text = t.text.toLowerCase();
      const bullCount = bullWords.filter(w => text.includes(w)).length;
      const bearCount = bearWords.filter(w => text.includes(w)).length;
      if (bullCount > bearCount) bullish++;
      else if (bearCount > bullCount) bearish++;
    }
    tweetCount = bullish + bearish;
    tweetSentiment = tweetCount > 0 ? (bullish - bearish) / tweetCount : 0;
    tweetLastFetch = Date.now();
    console.log(`[TWEET] Bulls:${bullish} Bears:${bearish} Sentiment:${tweetSentiment.toFixed(2)}`);
  } catch(e) {
    console.error('[TWEET] Fetch error:', e.message);
  }
}

function getTweetSignal() {
  if (tweetCount < 3) return { direction: null, score: 0, reason: `Твитов:${tweetCount}` };
  let score = 0;
  let reason = '';
  // Contrarian: crowd bullish → we short, crowd bearish → we long
  if (tweetSentiment > 0.5) { score = -2; reason = `Твиты:${tweetCount}▲→Против`; }
  else if (tweetSentiment < -0.5) { score = 2; reason = `Твиты:${tweetCount}▼→Против`; }
  else if (tweetSentiment > 0.2) { score = -1; reason = `Твиты:${tweetCount}▲→СлабоПротив`; }
  else if (tweetSentiment < -0.2) { score = 1; reason = `Твиты:${tweetCount}▼→СлабоПротив`; }
  else { reason = `Твиты:${tweetCount}→Нейтр`; }
  return { direction: score > 0 ? 'UP' : score < 0 ? 'DOWN' : null, score, reason };
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

// ── COMBINED SIGNAL (SPX + DXY + TWEETS) ─────────────────────────────
function aiSignal() {
  const spx = getSPXSignal();
  const dxy = getDXYSignal();
  const tweet = process.env.TWITTER_BEARER_TOKEN ? getTweetSignal() : { direction: null, score: 0, reason: 'Твиттер выкл' };
  const pm = { direction: null, score: 0, reason: '' };

  // Polymarket как четвёртый сигнал
  if (pmUpProb > 0.60) { pm.direction = 'UP'; pm.score = 1; pm.reason = `PM:${(pmUpProb*100).toFixed(0)}%▲`; }
  else if (pmDownProb > 0.60) { pm.direction = 'DOWN'; pm.score = -1; pm.reason = `PM:${(pmDownProb*100).toFixed(0)}%▼`; }

  const signals = [spx, dxy, tweet, pm].filter(s => s.direction !== null);
  const allSignals = [spx, dxy, tweet, pm];

  // Считаем голоса
  let upVotes = 0, downVotes = 0, totalScore = 0;
  const reasons = [];
  for (const s of allSignals) {
    reasons.push(s.reason);
    if (s.direction === 'UP') { upVotes++; totalScore += Math.abs(s.score); }
    else if (s.direction === 'DOWN') { downVotes++; totalScore -= Math.abs(s.score); }
  }

  const consensus = Math.max(upVotes, downVotes) / Math.max(1, upVotes + downVotes);
  const dir = upVotes > downVotes ? 'UP' : 'DOWN';

  // Нужно минимум 2 из 4 для ставки
  const skip = signals.length < 2;

  let conf = 45 + (signals.length * 5) + (consensus * 10);
  conf = Math.min(75, Math.max(40, conf));

  const reasonText = `${dir} ${conf.toFixed(0)}% | ${reasons.join(' | ')} | Согласие:${signals.length}/4${skip ? ' ⚠СКИП' : ''}`;

  console.log(`[SIGNAL] ${reasonText}`);
  return { direction: dir, confidence: conf, reason: reasonText, score: Math.abs(totalScore), skip };
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

  console.log(`[BOT] ██ НОВАЯ СТАВКА ${fmtWindow(rid)} ██`);
  roundPlaced = rid;

  if (!wsConnected) await fetchPriceFallback();
  await Promise.all([fetchSPX(), fetchDXY(), fetchTweetSentiment(), fetchPolymarketSentiment()]);

  const sig = aiSignal();

  if (sig.skip) {
    console.log(`[BOT] ⏭ SKIP ${fmtWindow(rid)} | ${sig.reason}`);
    state.history.unshift({
      id:rid, direction:sig.direction, confidence:sig.confidence,
      reason:sig.reason, betAmount:0, startPrice:currentPrice,
      endPrice:null, window:fmtWindow(rid), result:'skip', pnl:0,
      balanceAfter:state.wallet.balance, ts:new Date().toISOString()
    });
    if (state.history.length > 200) state.history = state.history.slice(0,200);
    state.lastRoundId = rid;
    await saveState();
    return;
  }

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
  console.log(`[BOT] BET: ${sig.direction} | ${sig.reason}`);
  await tgSend(`${dirEmoji} <b>${sig.direction === 'UP' ? 'ВВЕРХ' : 'ВНИЗ'}</b> · ${fmtWindow(rid)}\nВход: $${Math.round(currentPrice).toLocaleString()} · $${FIXED_BET}\n${sig.reason}\nБаланс: $${state.wallet.balance.toFixed(2)}`);
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
    console.log(`[BOT] WIN +$${p.toFixed(2)} | Balance: $${state.wallet.balance.toFixed(2)}`);
    await tgSend(`✅ <b>ВЫИГРЫШ #${state.wallet.wins}</b>\n${bet.direction} · ${bet.window}\nВход: $${Math.round(bet.startPrice).toLocaleString()} → Выход: $${Math.round(bet.endPrice).toLocaleString()}\nПрибыль: +$${p.toFixed(2)} · Баланс: $${state.wallet.balance.toFixed(2)}\nСерия: ${state.stats.curStreak} · W/L: ${state.wallet.wins}/${state.wallet.losses}`);
  } else {
    state.wallet.pnl = parseFloat((state.wallet.pnl - FIXED_BET).toFixed(2));
    state.wallet.losses++; state.stats.curStreak = 0; state.stats.totalLoss += FIXED_BET;
    bet.result = 'loss'; bet.pnl = -FIXED_BET;
    console.log(`[BOT] LOSS -$${FIXED_BET} | Balance: $${state.wallet.balance.toFixed(2)}`);
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

  if (Date.now() - lastTickLog > 30000) {
    console.log(`[TICK] ${fmtWindow(rid)} | Rem: ${Math.floor(rem/1000)}s | BTC: $${Math.round(currentPrice)} | SPX: $${spxPrice?.toFixed(0) || '?'} | DXY: ${dxyPrice?.toFixed(2) || '?'} | Tweets: ${tweetCount}`);
    lastTickLog = Date.now();
  }

  if (rem < 10000 && rem > -2000 && state.pendingBet?.result === 'pending') {
    await resolveBet();
  }

  if (rem > ROUND_MS - 12000 && shouldBotRun()) {
    await placeBet(rid);
  }

  if (rem > ROUND_MS - 30000 && roundPlaced !== rid && shouldBotRun()) {
    await placeBet(rid);
  }

  if (!wsConnected && Date.now() % 30000 < 3000) {
    await fetchPriceFallback();
  }

  // Периодически обновляем SPX и DXY
  await Promise.all([fetchSPX(), fetchDXY()]);
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
    await tgReply(msg.chat.id, '🤖 <b>BTC 15M v3.0</b>\nSPX Shadow + DXY Inverse + Tweet Velocity\nСтавка $5 · 2/4 сигналов');
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
    await tgReply(msg.chat.id, `📊 <b>СТАТУС ${timeMSK}</b>\n\n🤖 ${_userBotOn?'✅':'⏸'} | SPX:$${spxPrice?.toFixed(0)||'?'} | DXY:${dxyPrice?.toFixed(2)||'?'}\n💰 $${w.balance.toFixed(2)} · P&L: ${w.pnl>=0?'+':''}$${w.pnl.toFixed(2)}\nСтавок: ${total} · WR: ${wr}%\n⏳ До ставки: ${getTimeToNextBet()}${betInfo}`);
  });

  tg.onText(/\/price|📈 Цена BTC/, async (msg) => {
    await tgReply(msg.chat.id, `<b>Рынки:</b>\nBTC: $${Math.round(currentPrice).toLocaleString()}\nS&P 500: $${spxPrice?.toFixed(0) || '—'}\nDXY: ${dxyPrice?.toFixed(2) || '—'}`);
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
  console.log('🤖 BTC 15M v3.0 — SPX + DXY + Tweets');

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
  await Promise.all([fetchSPX(), fetchDXY(), fetchTweetSentiment()]);
  console.log(`[INIT] BTC:$${Math.round(currentPrice)} SPX:$${spxPrice?.toFixed(0)} DXY:${dxyPrice?.toFixed(2)}`);

  if (firebaseReady) listenForCommands();
  setupTelegramListeners();

  botStarted = true;
  setInterval(tick, 2000);

  setInterval(async () => {
    if (!firebaseReady) return;
    try { await db.ref('btc15m/heartbeat').set({ ts:Date.now(), working:isWorkingHours(), userBotOn:_userBotOn, shouldRun:shouldBotRun() }); } catch(e) {}
  }, 30000);

  const sources = ['SPX Shadow', 'DXY Inverse'];
  if (process.env.TWITTER_BEARER_TOKEN) sources.push('Tweet Velocity');
  await tgSend(`🚀 <b>BTC 15M v3.0</b>\n💰 $${state.wallet.balance.toFixed(2)}\n💵 $5 · 2/4 сигнала\n📊 ${sources.join(' + ')}`);
  console.log('[INIT] ✅ Live');
  await tick();
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });
