// Zero-dependency Vercel Serverless Function for /api/lookup
// Searches all NSE (.NS) & BSE (.BO) stocks live via Yahoo Finance and Mutual Funds via mfapi.in

const POPULAR_INDIAN_INSTRUMENTS = [
  { symbol: 'RELIANCE.NS', name: 'Reliance Industries Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1294.65 },
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1742.30 },
  { symbol: 'TCS.NS', name: 'Tata Consultancy Services Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 4148.75 },
  { symbol: 'INFY.NS', name: 'Infosys Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1864.20 },
  { symbol: 'ICICIBANK.NS', name: 'ICICI Bank Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1288.40 },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1642.10 },
  { symbol: 'SBIN.NS', name: 'State Bank of India', instrument_type: 'stock', exchange: 'NSE', fallback_price: 842.50 },
  { symbol: 'LT.NS', name: 'Larsen & Toubro Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 3624.00 },
  { symbol: 'ITC.NS', name: 'ITC Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 478.90 },
  { symbol: 'SUNPHARMA.NS', name: 'Sun Pharmaceutical Industries Ltd.', instrument_type: 'stock', exchange: 'NSE', fallback_price: 1815.60 },
  { symbol: '122639', name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 84.6214 },
  { symbol: '120716', name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 168.3942 },
  { symbol: '118989', name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 196.4820 },
  { symbol: '120503', name: 'Axis ELSS Tax Saver Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 98.4120 },
  { symbol: '125497', name: 'SBI Small Cap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 189.7340 },
  { symbol: '119598', name: 'Mirae Asset Large & Midcap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 158.9210 }
];

async function fetchYahooQuotes(searchTerm) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      searchTerm
    )}&quotesCount=20&newsCount=0&listsCount=0`;
    const yRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!yRes.ok) return [];
    const data = await yRes.json();
    return Array.isArray(data?.quotes) ? data.quotes : [];
  } catch {
    return [];
  }
}

function filterIndianStocks(rawQuotes) {
  const list = [];
  for (const item of rawQuotes) {
    const sym = String(item.symbol || '').trim().toUpperCase();
    const exch = String(item.exchange || '').toUpperCase();
    const quoteType = String(item.quoteType || '').toUpperCase();
    const isIndian =
      sym.endsWith('.NS') ||
      sym.endsWith('.BO') ||
      exch === 'NSI' ||
      exch === 'NSE' ||
      exch === 'BOM' ||
      exch === 'BSE';
    if (isIndian && (quoteType === 'EQUITY' || quoteType === 'ETF' || !quoteType)) {
      const isBse = sym.endsWith('.BO') || exch === 'BOM' || exch === 'BSE';
      const normalizedSymbol =
        sym.endsWith('.NS') || sym.endsWith('.BO') ? sym : `${sym}.${isBse ? 'BO' : 'NS'}`;
      const displayName = String(item.longname || item.shortname || normalizedSymbol).trim();
      list.push({
        symbol: normalizedSymbol,
        name: displayName,
        instrument_type: 'stock',
        exchange: isBse ? 'BSE' : 'NSE',
        fallback_price: 0
      });
    }
  }
  return list;
}

export default async function handler(req, res) {
  const q = String(req.query?.q || '').trim();
  const type = String(req.query?.type || 'all');

  if (!q) {
    const initialList = POPULAR_INDIAN_INSTRUMENTS.filter(
      (item) => type === 'all' || item.instrument_type === type
    );
    res.status(200).json({ results: initialList.slice(0, 12) });
    return;
  }

  const localMatches = POPULAR_INDIAN_INSTRUMENTS.filter(
    (item) =>
      (type === 'all' || item.instrument_type === type) &&
      (item.symbol.toLowerCase().includes(q.toLowerCase()) ||
        item.name.toLowerCase().includes(q.toLowerCase()))
  );

  const remoteStockResults = [];
  if (type === 'all' || type === 'stock') {
    const quotes = await fetchYahooQuotes(q);
    let indianMatches = filterIndianStocks(quotes);
    if (
      indianMatches.length < 3 &&
      !q.toLowerCase().includes('.ns') &&
      !q.toLowerCase().includes('.bo')
    ) {
      const nseQuotes = await fetchYahooQuotes(`${q} NSE`);
      indianMatches = [...indianMatches, ...filterIndianStocks(nseQuotes)];
    }
    remoteStockResults.push(...indianMatches);
  }

  const remoteMfResults = [];
  if (type === 'all' || type === 'mutual_fund') {
    try {
      const mfRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
      if (mfRes.ok) {
        const data = await mfRes.json();
        if (Array.isArray(data)) {
          for (const item of data.slice(0, 12)) {
            remoteMfResults.push({
              symbol: String(item.schemeCode),
              name: String(item.schemeName),
              instrument_type: 'mutual_fund',
              exchange: 'N/A',
              fallback_price: 0
            });
          }
        }
      }
    } catch {
      // Ignore network error
    }
  }

  const seen = new Set();
  const combined = [...localMatches, ...remoteStockResults, ...remoteMfResults].filter((item) => {
    if (seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });

  res.status(200).json({ results: combined.slice(0, 15) });
}
