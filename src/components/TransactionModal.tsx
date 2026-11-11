import React, { useEffect, useState } from 'react';
import { X, Search, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import {
  ExchangeType,
  InstrumentRollup,
  InstrumentType,
  LookupResult,
  TransactionType
} from '../types';
import { formatINR, formatNumberIN } from '../utils/financeMath';

interface TransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    instrument_type: InstrumentType;
    transaction_type: TransactionType;
    symbol: string;
    name: string;
    quantity: number;
    price: number;
    date: string;
    exchange: ExchangeType;
    target_lot_id?: string;
  }) => Promise<void>;
  holdings: InstrumentRollup[];
  initialSymbol?: string;
  initialTxType?: TransactionType;
}

const CLIENT_POPULAR_INSTRUMENTS: LookupResult[] = [
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

export const TransactionModal: React.FC<TransactionModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  holdings,
  initialSymbol,
  initialTxType = 'buy'
}) => {
  const [txType, setTxType] = useState<TransactionType>(initialTxType);
  const [instrumentType, setInstrumentType] = useState<InstrumentType>('stock');
  const [searchQuery, setSearchQuery] = useState('');
  const [lookupResults, setLookupResults] = useState<LookupResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [exchange, setExchange] = useState<ExchangeType>('NSE');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('2026-11-10');
  const [targetLotId, setTargetLotId] = useState<string>('FIFO');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg(null);
    setTxType(initialTxType);

    if (initialSymbol) {
      const match = holdings.find((h) => h.symbol === initialSymbol);
      if (match) {
        setSymbol(match.symbol);
        setName(match.name);
        setInstrumentType(match.instrument_type);
        setExchange(match.exchange);
        setPrice(String(match.latest_price));
      }
    } else if (initialTxType === 'sell' && holdings.length > 0) {
      const first = holdings[0];
      setSymbol(first.symbol);
      setName(first.name);
      setInstrumentType(first.instrument_type);
      setExchange(first.exchange);
      setPrice(String(first.latest_price));
    }
  }, [isOpen, initialSymbol, initialTxType, holdings]);

  useEffect(() => {
    if (!isOpen || txType === 'sell') return;
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        try {
          const res = await fetch(
            `/api/lookup?q=${encodeURIComponent(searchQuery)}&type=${instrumentType}`
          );
          if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
            const data = await res.json();
            setLookupResults(data.results || []);
            return;
          }
        } catch {
          // Fallback to direct client lookup below
        }

        const q = searchQuery.trim().toLowerCase();
        const localMatches = CLIENT_POPULAR_INSTRUMENTS.filter(
          (item) =>
            item.instrument_type === instrumentType &&
            (!q || item.symbol.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
        );
        if (instrumentType === 'mutual_fund' && q) {
          const mfRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
          if (mfRes.ok) {
            const mfData = await mfRes.json();
            if (Array.isArray(mfData)) {
              const remoteMf: LookupResult[] = mfData
                .slice(0, 10)
                .map((m: { schemeCode: string | number; schemeName: string }) => ({
                  symbol: String(m.schemeCode),
                  name: String(m.schemeName),
                  instrument_type: 'mutual_fund',
                  exchange: 'N/A',
                  fallback_price: 0
                }));
              setLookupResults([...localMatches, ...remoteMf].slice(0, 12));
              return;
            }
          }
        }
        setLookupResults(localMatches);
      } catch {
        setLookupResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 220);

    return () => clearTimeout(timer);
  }, [searchQuery, instrumentType, isOpen, txType]);

  if (!isOpen) return null;

  const selectedHoldingForSell = holdings.find(
    (h) => h.symbol.toUpperCase() === symbol.trim().toUpperCase()
  );

  // Preview FIFO realized P/L when selling
  const computeSellPreview = () => {
    if (txType !== 'sell' || !selectedHoldingForSell) return null;
    const sellQty = parseFloat(quantity);
    const sellPrice = parseFloat(price);
    if (isNaN(sellQty) || sellQty <= 0 || isNaN(sellPrice) || sellPrice <= 0) return null;

    const lots = [...selectedHoldingForSell.lots].sort((a, b) =>
      a.buy_date.localeCompare(b.buy_date)
    );
    const orderedLots =
      targetLotId !== 'FIFO'
        ? [
            ...lots.filter((l) => l.lot_id === targetLotId),
            ...lots.filter((l) => l.lot_id !== targetLotId)
          ]
        : lots;

    let rem = sellQty;
    let totalCostBasis = 0;
    const matchedBreakdown: Array<{
      lot_id: string;
      buy_date: string;
      matched_qty: number;
      buy_price: number;
      pnl: number;
    }> = [];

    for (const lot of orderedLots) {
      if (rem <= 1e-6) break;
      const take = Math.min(lot.open_quantity, rem);
      rem -= take;
      const lotCost = take * lot.buy_price;
      const lotProceeds = take * sellPrice;
      totalCostBasis += lotCost;
      matchedBreakdown.push({
        lot_id: lot.lot_id,
        buy_date: lot.buy_date,
        matched_qty: take,
        buy_price: lot.buy_price,
        pnl: lotProceeds - lotCost
      });
    }

    const totalProceeds = (sellQty - rem) * sellPrice;
    const realizedPnl = totalProceeds - totalCostBasis;
    return {
      matchedBreakdown,
      realizedPnl,
      exceedsOpen: rem > 1e-5
    };
  };

  const sellPreview = computeSellPreview();

  const handleSelectLookup = async (item: LookupResult) => {
    setSymbol(item.symbol);
    setName(item.name);
    setInstrumentType(item.instrument_type);
    setExchange(item.exchange);
    if (item.fallback_price && item.fallback_price > 0) {
      setPrice(String(item.fallback_price));
    }

    // Fetch live price / NAV from Yahoo Finance or mfapi.in to auto-populate price box
    try {
      const res = await fetch('/api/prices/refresh-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              symbol: item.symbol,
              instrument_type: item.instrument_type,
              name: item.name
            }
          ]
        })
      });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const json = await res.json();
        const fetched = json?.instruments?.[0];
        if (fetched && typeof fetched.latest_price === 'number' && fetched.latest_price > 0) {
          setPrice(String(fetched.latest_price));
          return;
        }
      }
    } catch {
      // Fallback to direct mfapi.in for mutual funds
    }

    if (item.instrument_type === 'mutual_fund') {
      try {
        const mfRes = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(item.symbol)}`);
        if (mfRes.ok) {
          const mfJson = await mfRes.json();
          const latestNav = parseFloat(mfJson?.data?.[0]?.nav);
          if (!isNaN(latestNav) && latestNav > 0) {
            setPrice(String(latestNav));
          }
        }
      } catch {
        // Ignore
      }
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    const numQty = parseFloat(quantity);
    const numPrice = parseFloat(price);

    if (!symbol.trim() || !name.trim()) {
      setErrorMsg('Please select or enter an instrument symbol/scheme code and name.');
      return;
    }
    if (isNaN(numQty) || numQty <= 0) {
      setErrorMsg('Quantity/units must be a positive number.');
      return;
    }
    if (isNaN(numPrice) || numPrice <= 0) {
      setErrorMsg('Price/NAV must be a positive number in INR.');
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        instrument_type: instrumentType,
        transaction_type: txType,
        symbol: symbol.trim().toUpperCase(),
        name: name.trim(),
        quantity: numQty,
        price: numPrice,
        date,
        exchange: instrumentType === 'mutual_fund' ? 'N/A' : exchange,
        target_lot_id: txType === 'sell' && targetLotId !== 'FIFO' ? targetLotId : undefined
      });
      onClose();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to log transaction');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-t-3xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        {/* Mobile Bottom-Sheet Drag Handle */}
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-slate-300 sm:hidden" />

        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3.5 sm:px-6 sm:py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
              {txType === 'buy' ? 'Log Buy Lot (Stock / MF)' : 'Record Sale (FIFO)'}
            </h2>
            <p className="text-xs text-slate-500">
              {txType === 'buy'
                ? 'Each purchase is stored as an independent lot.'
                : 'Sales reduce open units from oldest buy lots first.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          onSubmit={handleFormSubmit}
          className="flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:p-6"
        >
          {/* Segmented Buy / Sell Selector */}
          <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTxType('buy');
                setErrorMsg(null);
              }}
              className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                txType === 'buy'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowDownLeft className="h-4 w-4 text-emerald-600" />
              Buy Lot
            </button>
            <button
              type="button"
              onClick={() => {
                setTxType('sell');
                setErrorMsg(null);
                if (holdings.length > 0 && !selectedHoldingForSell) {
                  const first = holdings[0];
                  setSymbol(first.symbol);
                  setName(first.name);
                  setInstrumentType(first.instrument_type);
                  setExchange(first.exchange);
                  setPrice(String(first.latest_price));
                }
              }}
              className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                txType === 'sell'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowUpRight className="h-4 w-4 text-amber-600" />
              Sell Holding (FIFO)
            </button>
          </div>

          {txType === 'buy' ? (
            <>
              {/* Instrument Type & Exchange */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Instrument Type
                  </label>
                  <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setInstrumentType('stock');
                        setExchange('NSE');
                      }}
                      className={`min-h-[42px] flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                        instrumentType === 'stock'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Stock (NSE/BSE)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInstrumentType('mutual_fund');
                        setExchange('N/A');
                      }}
                      className={`min-h-[42px] flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                        instrumentType === 'mutual_fund'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Mutual Fund (AMFI)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Exchange
                  </label>
                  {instrumentType === 'stock' ? (
                    <select
                      value={exchange}
                      onChange={(e) => {
                        const nextEx = e.target.value as ExchangeType;
                        setExchange(nextEx);
                        if (symbol) {
                          const base = symbol.replace(/\.(NS|BO)$/i, '');
                          setSymbol(`${base}.${nextEx === 'BSE' ? 'BO' : 'NS'}`);
                        }
                      }}
                      className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                    >
                      <option value="NSE">NSE (.NS suffix)</option>
                      <option value="BSE">BSE (.BO suffix)</option>
                    </select>
                  ) : (
                    <input
                      type="text"
                      disabled
                      value="N/A (AMFI Scheme Code)"
                      className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500 sm:text-xs"
                    />
                  )}
                </div>
              </div>

              {/* Search Lookup */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Lookup {instrumentType === 'stock' ? 'NSE/BSE Stock' : 'AMFI Mutual Fund (mfapi.in)'}
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-3.5 left-3.5 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      instrumentType === 'stock'
                        ? 'Search Reliance, HDFC Bank, TCS...'
                        : 'Search Parag Parikh, UTI Nifty 50...'
                    }
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 py-2.5 pr-3 pl-10 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                  />
                </div>
                {lookupResults.length > 0 && (
                  <div className="mt-1.5 max-h-36 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-1">
                    {lookupResults.map((item) => (
                      <button
                        key={item.symbol}
                        type="button"
                        onClick={() => handleSelectLookup(item)}
                        className="flex min-h-[42px] w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs hover:bg-white hover:shadow-2xs"
                      >
                        <span className="truncate font-medium text-slate-900">{item.name}</span>
                        <span className="ml-2 shrink-0 font-mono text-slate-500">
                          {item.symbol}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {isSearching && (
                  <p className="mt-1 text-xs text-slate-400">Searching instrument directory...</p>
                )}
              </div>

              {/* Symbol & Display Name */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    {instrumentType === 'stock' ? 'Ticker Symbol' : 'Scheme Code'}
                  </label>
                  <input
                    type="text"
                    required
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    placeholder={instrumentType === 'stock' ? 'RELIANCE.NS' : '122639'}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Instrument full name"
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                  />
                </div>
              </div>
            </>
          ) : (
            /* SELL MODE SELECTOR */
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Select Open Holding to Sell
                </label>
                <select
                  value={symbol}
                  onChange={(e) => {
                    const chosen = holdings.find((h) => h.symbol === e.target.value);
                    if (chosen) {
                      setSymbol(chosen.symbol);
                      setName(chosen.name);
                      setInstrumentType(chosen.instrument_type);
                      setExchange(chosen.exchange);
                      setPrice(String(chosen.latest_price));
                      setTargetLotId('FIFO');
                    }
                  }}
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                >
                  {holdings.map((h) => (
                    <option key={h.symbol} value={h.symbol}>
                      {h.name} ({h.symbol}) — Open: {formatNumberIN(h.total_open_quantity, 3)}
                    </option>
                  ))}
                </select>
              </div>

              {selectedHoldingForSell && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Lot Matching Rule
                  </label>
                  <select
                    value={targetLotId}
                    onChange={(e) => setTargetLotId(e.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:border-slate-900 focus:outline-hidden"
                  >
                    <option value="FIFO">
                      FIFO Default — Oldest buy lot(s) first
                    </option>
                    {selectedHoldingForSell.lots.map((l) => (
                      <option key={l.lot_id} value={l.lot_id}>
                        Lot {l.buy_date}: {formatNumberIN(l.open_quantity, 3)} open @{' '}
                        {formatINR(l.buy_price, 2)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Quantity, Price, Date */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                {txType === 'buy' ? 'Quantity / MF Units' : 'Quantity Sold'}
              </label>
              <input
                type="number"
                step="any"
                min="0.0001"
                required
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={instrumentType === 'mutual_fund' ? 'e.g. 145.524' : 'e.g. 25'}
                className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                {txType === 'buy' ? 'Buy Price / NAV (INR)' : 'Sell Price / NAV (INR)'}
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="e.g. 1294.50"
                className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                {txType === 'buy' ? 'Buy Date' : 'Sell Date'}
              </label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
              />
            </div>
          </div>

          {/* Live FIFO Realized P/L Preview on Sell */}
          {txType === 'sell' && sellPreview && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
              <div className="flex items-center justify-between font-medium text-slate-900">
                <span>Projected Realized P/L:</span>
                <span
                  className={`font-mono font-semibold ${
                    sellPreview.realizedPnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {sellPreview.realizedPnl >= 0 ? '+' : ''}
                  {formatINR(sellPreview.realizedPnl, 2)}
                </span>
              </div>
              <div className="mt-2 space-y-1 text-slate-600">
                {sellPreview.matchedBreakdown.map((m, idx) => (
                  <div key={idx} className="flex justify-between font-mono text-[11px]">
                    <span>
                      Lot {m.buy_date}: {formatNumberIN(m.matched_qty, 3)} (Buy{' '}
                      {formatINR(m.buy_price, 2)})
                    </span>
                    <span className={m.pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                      {m.pnl >= 0 ? '+' : ''}
                      {formatINR(m.pnl, 2)}
                    </span>
                  </div>
                ))}
              </div>
              {sellPreview.exceedsOpen && (
                <p className="mt-2 font-medium text-rose-600">
                  Warning: Requested quantity exceeds total open units.
                </p>
              )}
            </div>
          )}

          {errorMsg && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {errorMsg}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4 pb-2">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] flex-1 rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 sm:flex-none whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-[44px] flex-1 rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 sm:flex-none whitespace-nowrap"
            >
              {isSubmitting
                ? 'Saving...'
                : txType === 'buy'
                ? 'Save Buy Lot'
                : 'Record Sale & Realize P/L'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
