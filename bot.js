const admin = require('firebase-admin');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ── TELEGRAM SETUP ────────────────────────────────────────────────────
const tg = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function tgSend(msg) {
  try {
    await tg.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch(e) {
    console.error('[TG]', e.message);
  }
}

// ── FIREBASE ──────────────────────────────────────────────────────────
const app = admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db        = admin.database();
const STATE_REF = db.ref('btc15m/main');

// ── CONSTANTS ─────────────────────────────────────────────────────────
const WIN_MULT     = 0.92;
const ROUND_MS     = 15 * 60 * 1000;
const FIXED_BET    = 5;
const WORK_START_UTC = 6;  // 09:00 МСК
const WORK_END_UTC   = 21; // 00:00 МСК

// ── STATE ─────────────────────────────────────────────────────────────
let state          = null;
let currentPrice   = 72000;
let priceBuffer    = [];
let wsConnected    = false;
let roundPlaced    = null;
let _userBotOn     = true;

function defaultState() {
  return {
    wallet:  { balance: 100, pnl: 0, wins: 0, losses: 0, totalBet: 0 },
    stats:   { bestStreak: 0, curStreak: 0, totalWin: 0, totalLoss: 0 },
    history: [],
    botOn:   false,
    lastRoundId: null,
    pendingBet:  null,
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
  try {
    const snap = await STATE_REF.once('value');
    if (snap.exists()) {
      const data = snap.val();
      data.history = (data.history || []).slice(0, 200);
      _userBotOn = data.botOn === true;
      return data;
    }
  } catch(e) {}
  return defaultState();
}

async function saveState() {
  try {
    state.savedAt = Date.now();
    state.botOn   = _userBotOn;
    await STATE_REF.set(state);
  } catch(e) {}
}

const roundId     = (t) => Math.floor((t || Date.now()) / ROUND_MS) * ROUND_MS;
const roundRemain = ()  => roundId() + ROUND_MS - Date.now();
const fmtWindow   = (rid) => {
  const f = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Moscow' });
  return `${f(rid)}–${f(rid + ROUND_MS)}`;
};

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

// ── KLINE BUILDER ─────────────────────────────────────────────────────
function buildKlines() {
  if (priceBuffer.length < 10) return [];
  const buf = priceBuffer.slice(-90);
  const chunkSize = Math.max(1, Math.floor(buf.length / 15));
  const candles = [];
  for (let i=0; i<15; i++) {
    const chunk = buf.slice(i*chunkSize, (i+1)*chunkSize);
    if (!chunk.length) continue;
    candles.push({ o:chunk[0], h:Math.max(...chunk), l:Math.min(...chunk), c:chunk[chunk.length-1], v:chunk.length });
  }
  return candles;
}

// ── POLYMARKET SENTIMENT ──────────────────────────────────────────────
let pmUpProb = 0.5, pmDownProb = 0.5, pmLastFetch = 0;
async function fetchPolymarketSentiment() {
  if (Date.now() - pmLastFetch < 60000) return;
  try {
    const nowSec = Math.floor(Date.now()/1000);
    const slug   = `btc-updown-15m-${nowSec - (nowSec % 900)}`;
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { timeout:4000 });
    if (!r.ok) return;
    const data   = await r.json();
    const market = data?.[0]?.markets?.[0];
    if (!market) return;
    const prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    pmUpProb   = parseFloat(prices[0]) || 0.5;
    pmDownProb = parseFloat(prices[1]) || 0.5;
    pmLastFetch = Date.now();
  } catch(e) {}
}

// ── AI SIGNAL ─────────────────────────────────────────────────────────
function aiSignal(klines) {
  if (klines.length < 5) return { direction:'UP', confidence:52, skip:true, reason:'Нет данных', score:0 };

  const n=klines.length, c=klines.map(k=>k.c), o=klines.map(k=>k.o),
        h=klines.map(k=>k.h), l=klines.map(k=>k.l), v=klines.map(k=>k.v);
  let score=0; const signals=[];

  const rA=(c[n-1]+c[n-2]+c[n-3])/3, eA=(c[0]+c[1]+c[2])/3;
  if(rA>eA*1.001){score+=2.5;signals.push('Тренд▲');}
  else if(rA<eA*0.999){score-=2.5;signals.push('Тренд▼');}
  else signals.push('Флет');

  let bullC=0,bearC=0;
  for(let i=n-4;i<n;i++){if(c[i]>o[i])bullC++;else bearC++;}
  if(bullC>=3){score+=2.5;signals.push(`${bullC}×Bull`);}
  if(bearC>=3){score-=2.5;signals.push(`${bearC}×Bear`);}

  const avgV=v.slice(0,-1).reduce((a,b)=>a+b,0)/(n-1);
  if(v[n-1]>avgV*1.5){score+=(c[n-1]>o[n-1]?1.5:-1.5);signals.push('VolSpike');}

  const gains=[],losses=[];
  for(let i=1;i<n;i++){const d=c[i]-c[i-1];if(d>0)gains.push(d);else losses.push(Math.abs(d));}
  const aG=gains.length?gains.reduce((a,b)=>a+b,0)/gains.length:0;
  const aL=losses.length?losses.reduce((a,b)=>a+b,0)/losses.length:.001;
  const rsi=100-100/(1+aG/aL);
  if(rsi>75){score-=2;signals.push(`RSI${rsi.toFixed(0)}OB`);}
  else if(rsi<25){score+=2;signals.push(`RSI${rsi.toFixed(0)}OS`);}

  if(pmUpProb>=0.65){score+=4;signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`);}
  else if(pmUpProb<=0.35){score-=4;signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`);}
  else if(pmUpProb>=0.57){score+=2;signals.push(`PM▲${(pmUpProb*100).toFixed(0)}%`);}
  else if(pmUpProb<=0.43){score-=2;signals.push(`PM▼${(pmDownProb*100).toFixed(0)}%`);}

  if(priceBuffer.length>=60){
    const recent=priceBuffer.slice(-60);
    const range=Math.max(...recent)-Math.min(...recent);
    if(range<30){score*=0.3;signals.push(`Флет⚠$${range.toFixed(0)}`);}
  }

  const absScore=Math.abs(score);
  const skip=absScore<3.5;
  const dir=score>=0?'UP':'DOWN';
  const conf=Math.min(87,Math.max(52,52+absScore*4));
  return { direction:dir, confidence:conf, skip, reason:`${dir} ${conf.toFixed(0)}% | Скор:${score.toFixed(1)} | ${signals.join(',')}`, score };
}

// ── BOT LOGIC ─────────────────────────────────────────────────────────
async function placeBet(rid) {
  if (roundPlaced===rid) return;
  if (!shouldBotRun()) return;
  if (state.wallet.balance < FIXED_BET) {
    await tgSend('❌ Баланс < $5. Остановка.');
    _userBotOn=false; await saveState(); return;
  }
  roundPlaced=rid;
  if(!wsConnected) await fetchPriceFallback();
  await fetchPolymarketSentiment();
  const klines=buildKlines();
  const sig=aiSignal(klines);
  if(sig.skip){
    state.history.unshift({ id:rid,direction:sig.direction,confidence:sig.confidence,reason:sig.reason,betAmount:0,startPrice:currentPrice,endPrice:null,window:fmtWindow(rid),result:'skip',pnl:0,balanceAfter:state.wallet.balance,ts:new Date().toISOString() });
    if(state.history.length>200)state.history=state.history.slice(0,200);
    state.lastRoundId=rid; await saveState(); return;
  }
  state.wallet.balance=parseFloat((state.wallet.balance-FIXED_BET).toFixed(2));
  state.wallet.totalBet+=FIXED_BET;
  state.lastRoundId=rid;
  state.pendingBet={ id:rid,direction:sig.direction,confidence:sig.confidence,reason:sig.reason,betAmount:FIXED_BET,startPrice:currentPrice,endPrice:null,window:fmtWindow(rid),result:'pending',pnl:0,ts:new Date().toISOString() };
  await saveState();
  const dirEmoji=sig.direction==='UP'?'🟢':'🔴';
  await tgSend(`${dirEmoji} <b>${sig.direction}</b> $${FIXED_BET} @ $${Math.round(currentPrice)}\n🕐 ${fmtWindow(rid)}\n🎯 Уверенность: ${sig.confidence.toFixed(0)}%\n💰 Баланс: $${state.wallet.balance.toFixed(2)}\n📈 ${sig.reason}`);
}

async function resolveBet() {
  const bet=state.pendingBet;
  if(!bet||bet.result!=='pending') return;
  if(!wsConnected) await fetchPriceFallback();
  bet.endPrice=currentPrice;
  const up=bet.endPrice>=bet.startPrice;
  const won=(bet.direction==='UP'&&up)||(bet.direction==='DOWN'&&!up);
  if(won){
    const p=parseFloat((FIXED_BET*WIN_MULT).toFixed(2));
    state.wallet.balance=parseFloat((state.wallet.balance+FIXED_BET+p).toFixed(2));
    state.wallet.pnl=parseFloat((state.wallet.pnl+p).toFixed(2));
    state.wallet.wins++; state.stats.curStreak++; state.stats.totalWin+=p;
    if(state.stats.curStreak>state.stats.bestStreak)state.stats.bestStreak=state.stats.curStreak;
    bet.result='win'; bet.pnl=p;
    await tgSend(`✅ <b>WIN</b> +$${p.toFixed(2)}\n💰 Баланс: $${state.wallet.balance.toFixed(2)}\n🔥 Серия: ${state.stats.curStreak}\n📊 W${state.wallet.wins}/L${state.wallet.losses}`);
  }else{
    state.wallet.pnl=parseFloat((state.wallet.pnl-FIXED_BET).toFixed(2));
    state.wallet.losses++; state.stats.curStreak=0; state.stats.totalLoss+=FIXED_BET;
    bet.result='loss'; bet.pnl=-FIXED_BET;
    await tgSend(`❌ <b>LOSS</b> -$${FIXED_BET}\n💰 Баланс: $${state.wallet.balance.toFixed(2)}\n📊 W${state.wallet.wins}/L${state.wallet.losses}`);
  }
  bet.balanceAfter=state.wallet.balance;
  state.history.unshift({...bet});
  if(state.history.length>200)state.history=state.history.slice(0,200);
  state.pendingBet=null; await saveState();
  if(state.wallet.balance<FIXED_BET){_userBotOn=false;await saveState();await tgSend('⚠️ Баланс < $5. Бот остановлен.');}
}

// ── MAIN TICK ─────────────────────────────────────────────────────────
async function tick() {
  if(!state)return;
  const rid=roundId();
  const rem=roundRemain();
  if(rem<10000 && state.pendingBet?.result==='pending' && state.pendingBet?.id===rid) await resolveBet();
  if(rem>ROUND_MS-25000 && shouldBotRun()) await placeBet(rid);
  if(!wsConnected && Date.now()%30000<5000) await fetchPriceFallback();
  if(!isWorkingHours() && state.pendingBet?.result==='pending') await resolveBet();
}

// ── LISTENERS ─────────────────────────────────────────────────────────
function listenForCommands() {
  STATE_REF.child('botOn').on('value', async snap=>{
    const val=snap.val();
    if(typeof val==='boolean'&&val!==_userBotOn){
      _userBotOn=val;
      await tgSend(_userBotOn?'▶ Бот запущен':'■ Бот остановлен');
      if(!_userBotOn&&state.pendingBet?.result==='pending') await resolveBet();
    }
  });
  db.ref('btc15m/command').on('value', async snap=>{
    if(snap.val()==='reset'){
      state=defaultState(); roundPlaced=null; await saveState();
      await db.ref('btc15m/command').remove();
      await tgSend('↺ Сброс. Баланс: $100');
    }
  });
}

// ── START ─────────────────────────────────────────────────────────────
async function start() {
  console.log('🤖 BTC 15M Bot starting...');
  state=await loadState();
  if(!state){console.error('Firebase load failed');process.exit(1);}
  connectPriceWS();
  listenForCommands();
  setInterval(tick,5000);
  setInterval(async()=>{
    try{await db.ref('btc15m/heartbeat').set({ts:Date.now(),working:isWorkingHours(),userBotOn:_userBotOn,shouldRun:shouldBotRun()});}catch(e){}
  },30000);
  const hourMSK=(new Date().getUTCHours()+3)%24;
  await tgSend(`🚀 <b>BTC 15M Бот запущен</b>\n💰 Баланс: $${state.wallet.balance.toFixed(2)}\n⏰ МСК: ${hourMSK}:XX\n📅 Расписание: 09:00–00:00\n💵 Ставка: $${FIXED_BET} фикс`);
  await tick();
}
start().catch(e=>{console.error('Fatal:',e);process.exit(1);});
