// Zero-dependency Vercel Serverless Function for /api/prices/refresh-batch
// Fetches live NSE/BSE prices from Yahoo Finance and Mutual Fund NAVs from mfapi.in

const FALLBACK_PRICES = {
  'RELIANCE.NS': { name: 'Reliance Industries Ltd.', price: 1294.65 },
  'HDFCBANK.NS': { name: 'HDFC Bank Ltd.', price: 1742.30 },
  'TCS.NS': { name: 'Tata Consultancy Services Ltd.', price: 4148.75 },
  'INFY.NS': { name: 'Infosys Ltd.', price: 1864.20 },
  'ICICIBANK.NS': { name: 'ICICI Bank Ltd.', price: 1288.40 },
  'BHARTIARTL.NS': { name: 'Bharti Airtel Ltd.', price: 1642.10 },
  'SBIN.NS': { name: 'State Bank of India', price: 842.50 },
  'LT.NS': { name: 'Larsen & Toubro Ltd.', price: 3624.00 },
  'ITC.NS': { name: 'ITC Ltd.', price: 478.90 },
  'SUNPHARMA.NS': { name: 'Sun Pharmaceutical Industries Ltd.', price: 1815.60 },
  '122639': { name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', price: 84.6214 },
  '120716': { name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth', price: 168.3942 },
  '118989': { name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth', price: 196.4820 }
};

async function refreshSingle(item) {
  const cleanSym = String(item.symbol || '').trim();
  const instType = item.instrument_type === 'mutual_fund' ? 'mutual_fund' : 'stock';
  const fallback = FALLBACK_PRICES[cleanSym.toUpperCase()] || { name: item.name || cleanSym, price: 100 };

  const baseInfo = {
    symbol: cleanSym,
    instrument_type: instType,
    name: item.name || fallback.name,
    exchange: instType === 'mutual_fund' ? 'N/A' : cleanSym.endsWith('.BO') ? 'BSE' : 'NSE',
    latest_price: fallback.price,
    previous_close: Number((fallback.price * 0.992).toFixed(2)),
    last_updated: new Date().toISOString(),
    source: 'cached_fallback'
  };

  if (instType === 'mutual_fund') {
    try {
      const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(cleanSym)}`);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.data) && json.data.length > 0) {
          const latestNav = parseFloat(json.data[0].nav);
          const prevNav = json.data[1] ? parseFloat(json.data[1].nav) : latestNav;
          if (!isNaN(latestNav) && latestNav > 0) {
            return {
              ...baseInfo,
              name: json.meta?.scheme_name || baseInfo.name,
              latest_price: latestNav,
              previous_close: !isNaN(prevNav) && prevNav > 0 ? prevNav : baseInfo.previous_close,
              last_updated: new Date().toISOString(),
              source: 'mfapi_live'
            };
          }
        }
      }
    } catch {
      // Fall back to baseInfo
    }
    return baseInfo;
  } else {
    const yahooTicker =
      cleanSym.endsWith('.NS') || cleanSym.endsWith('.BO')
        ? cleanSym.toUpperCase()
        : `${cleanSym.toUpperCase()}.NS`;
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.ok) {
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (meta && typeof meta.regularMarketPrice === 'number') {
          return {
            ...baseInfo,
            symbol: yahooTicker,
            name: meta.longName || meta.shortName || baseInfo.name,
            exchange: yahooTicker.endsWith('.BO') ? 'BSE' : 'NSE',
            latest_price: Number(meta.regularMarketPrice.toFixed(2)),
            previous_close: Number((meta.chartPreviousClose ?? meta.previousClose ?? baseInfo.previous_close).toFixed(2)),
            high_52w: meta.fiftyTwoWeekHigh ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : undefined,
            low_52w: meta.fiftyTwoWeekLow ? Number(meta.fiftyTwoWeekLow.toFixed(2)) : undefined,
            last_updated: new Date().toISOString(),
            source: 'yahoo_live'
          };
        }
      }
    } catch {
      // Fall back to baseInfo
    }
    return baseInfo;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const instruments = await Promise.all(items.map((item) => refreshSingle(item)));
  res.status(200).json({
    timestamp: new Date().toISOString(),
    instruments
  });
}
