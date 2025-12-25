/* US Quick Quote - Service Worker (MV3)
   Data source (no token): Stooq CSV endpoints.

   Symbols (US): use .US suffix (e.g., AAPL.US) on Stooq.
   - Intraday OHLCV: https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv
   - Daily history:  https://stooq.com/q/d/l/?s=AAPL.US&i=d
   We compute % change using previous daily close (D-1).
*/

const STOOQ_QUOTE = "https://stooq.com/q/l/";
const STOOQ_DAILY = "https://stooq.com/q/d/l/";

// Liquidity-focused lists (editable). Top 3 is computed within these universes.
const STOCKS = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","BRK.B","JPM",
  "V","MA","UNH","XOM","LLY","AVGO","COST","HD","WMT","PG",
  "KO","PEP","ORCL","ADBE","CRM","CSCO","INTC","AMD","QCOM","NFLX",
  "DIS","BA","NKE","MCD","CAT","GE","T","VZ","PFE","MRK"
];

const REITS = [
  "O","AMT","PLD","SPG","WELL","VICI","PSA","EQIX","DLR","CCI",
  "AVB","EQR","ESS","INVH","SUI","ARE","BXP","KIM","REG","FRT",
  "NNN","STAG","ADC","SRC","CUBE","EXR","MAA","UDR","HST"
];

function cleanTicker(input){
  return String(input || "").trim().toUpperCase();
}

function toStooqSymbolIntraday(ticker){
  // stooq q/l commonly accepts lowercase; keep dot for BRK.B -> brk.b.us
  return `${ticker.toLowerCase()}.us`;
}
function toStooqSymbolDaily(ticker){
  return `${ticker.toUpperCase()}.US`;
}

function num(x){
  const v = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(v) ? v : null;
}
function vol(x){
  const v = parseInt(String(x).replace(/[^\d]/g,""), 10);
  return Number.isFinite(v) ? v : null;
}

async function fetchCsv(url){
  const res = await fetch(url, { method:"GET", cache:"no-store" });
  if (!res.ok) throw new Error(`Stooq request failed (${res.status})`);
  return await res.text();
}

async function fetchIntraday(ticker){
  const s = toStooqSymbolIntraday(ticker);
  const url = `${STOOQ_QUOTE}?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
  const text = await fetchCsv(url);

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Ticker not found.");
  const headers = lines[0].split(",");
  const values = lines[1].split(",");
  const row = Object.fromEntries(headers.map((h,i)=>[h.trim(), (values[i] ?? "").trim()]));

  if (!row.Close || row.Close === "N/A") throw new Error("No data available for this ticker at the moment.");

  return {
    displaySymbol: ticker,
    symbol: row.Symbol || s,
    shortName: ticker,
    longName: ticker,
    regularMarketPrice: num(row.Close),
    regularMarketOpen: num(row.Open),
    regularMarketDayHigh: num(row.High),
    regularMarketDayLow: num(row.Low),
    regularMarketVolume: vol(row.Volume),
    marketTimeISO: (row.Date && row.Time) ? `${row.Date} ${row.Time}` : null
  };
}

async function fetchPrevClose(ticker){
  const s = toStooqSymbolDaily(ticker);
  const url = `${STOOQ_DAILY}?s=${encodeURIComponent(s)}&i=d`;
  const text = await fetchCsv(url);

  // CSV: Date,Open,High,Low,Close,Volume
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3) throw new Error("Insufficient history.");
  const rows = lines.slice(1).filter(Boolean);
  const prev = rows[rows.length - 2].split(",");
  const prevClose = num(prev[4]);
  if (typeof prevClose !== "number") throw new Error("Previous close unavailable.");
  return prevClose;
}

async function getPrevCloseCached(ticker){
  const key = `prevClose:${ticker}`;
  const dayKey = `prevCloseDay`;
  const store = chrome.storage.session || chrome.storage.local;
  const cached = await store.get([key, dayKey]).catch(()=> ({}));
  const today = new Date().toISOString().slice(0,10);
  if (cached?.[dayKey] === today && typeof cached?.[key] === "number") return cached[key];

  const pc = await fetchPrevClose(ticker);
  await store.set({ [key]: pc, [dayKey]: today }).catch(()=>{});
  return pc;
}

async function getQuote(inputTicker){
  const t = cleanTicker(inputTicker).replace(/[^A-Z0-9\.]/g, "");
  if (!t) throw new Error("Invalid ticker.");
  const q = await fetchIntraday(t);
  let prevClose = null;
  try{
    prevClose = await getPrevCloseCached(t);
  }catch(_e){
    prevClose = q.regularMarketOpen;
  }

  const price = q.regularMarketPrice;
  if (typeof price === "number" && typeof prevClose === "number" && prevClose !== 0) {
    const chg = price - prevClose;
    const pct = (chg / prevClose) * 100;
    q.regularMarketChange = chg;
    q.regularMarketChangePercent = pct;
  } else {
    q.regularMarketChange = 0;
    q.regularMarketChangePercent = 0;
  }

  q.marketTime = Math.floor(Date.now()/1000);
  return q;
}

async function getQuotesMany(tickers, concurrency=6){
  const out = [];
  let idx = 0;
  async function worker(){
    while (idx < tickers.length){
      const i = idx++;
      const t = tickers[i];
      try{
        const q = await getQuote(t);
        out.push(q);
      }catch(_e){}
    }
  }
  await Promise.all(Array.from({length: concurrency}, worker));
  return out;
}

function top3FromQuotes(quotes, direction){
  const clean = quotes
    .filter(q => typeof q.regularMarketChangePercent === "number" && isFinite(q.regularMarketChangePercent))
    .map(q => ({ displaySymbol: q.displaySymbol, pct: q.regularMarketChangePercent }));

  clean.sort((a,b)=>a.pct-b.pct);
  const sorted = direction === "gainers" ? clean.slice().reverse() : clean.slice();
  return sorted.slice(0,3);
}

async function getTops(){
  const now = Date.now();
  const store = chrome.storage.session || chrome.storage.local;
  const cache = await store.get(["topsCache"]).catch(()=> ({}));
  const cached = cache?.topsCache;
  if (cached && (now - cached.updatedAt) < 30000) return cached;

  const [stocksQuotes, reitsQuotes] = await Promise.all([
    getQuotesMany(STOCKS, 6),
    getQuotesMany(REITS, 6)
  ]);

  const data = {
    stocks: {
      gainers: top3FromQuotes(stocksQuotes, "gainers"),
      losers: top3FromQuotes(stocksQuotes, "losers")
    },
    fiis: { // keep UI ids; shown as REITs in UI text
      gainers: top3FromQuotes(reitsQuotes, "gainers"),
      losers: top3FromQuotes(reitsQuotes, "losers")
    },
    updatedAt: now
  };

  await store.set({ topsCache: data }).catch(()=>{});
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_QUOTE") {
        const data = await getQuote(msg.symbol);
        sendResponse({ ok:true, data });
        return;
      }
      if (msg?.type === "GET_TOPS") {
        const data = await getTops();
        sendResponse({ ok:true, data });
        return;
      }
      sendResponse({ ok:false, error:"Unknown message." });
    } catch (e) {
      sendResponse({ ok:false, error: e?.message || String(e) });
    }
  })();
  return true;
});
