import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type InstrumentType = 'stock' | 'mutual_fund';
export type TransactionType = 'buy' | 'sell';
export type ExchangeType = 'NSE' | 'BSE' | 'N/A';

export interface TransactionRecord {
  id: string;
  instrument_type: InstrumentType;
  transaction_type: TransactionType;
  symbol: string; // e.g. RELIANCE.NS, 500325.BO, or AMFI scheme code 122639
  name: string;
  quantity: number;
  price: number; // buy_price or sell_price in INR
  date: string; // YYYY-MM-DD
  exchange: ExchangeType;
  target_lot_id?: string; // Optional specific buy lot ID if user chose non-default lot on sell
}

export interface InstrumentPriceInfo {
  symbol: string;
  instrument_type: InstrumentType;
  name: string;
  exchange: ExchangeType;
  latest_price: number;
  previous_close: number;
  high_52w?: number;
  low_52w?: number;
  last_updated: string;
  source: 'yahoo_live' | 'mfapi_live' | 'cached_fallback';
}

export interface DailyInstrumentSnapshot {
  date: string; // YYYY-MM-DD
  prices: Record<string, number>; // symbol -> close price / NAV on that date
  portfolio_total_value: number;
  timestamp: string;
}

export interface GoalRecalcEntry {
  id: string;
  goal_id: string;
  recalc_date: string; // YYYY-MM-DD
  trailing_1y_return_pct: number; // e.g. 18.4
  accumulated_amount: number; // A
  adjusted_monthly_sip?: number; // For Mode A
  adjusted_target_date?: string; // For Mode B (YYYY-MM-DD)
  adjusted_months_remaining?: number; // For Mode B
  note?: string;
}

export interface GoalRecord {
  id: string;
  name: string;
  mode: 'A' | 'B';
  target_amount: number; // FV in INR
  accumulated_amount: number; // A in INR (already saved toward this goal)
  created_date: string;
  // Mode A inputs/outputs
  target_date?: string; // YYYY-MM-DD
  initial_required_sip?: number;
  current_required_sip?: number;
  // Mode B inputs/outputs
  monthly_sip?: number; // Fixed P in INR
  initial_target_date?: string;
  current_target_date?: string;
  current_months_to_target?: number | null;
  // Return assumption used on last compute
  last_trailing_1y_return_pct: number;
}

interface DatabaseSchema {
  transactions: TransactionRecord[];
  instruments: Record<string, InstrumentPriceInfo>;
  price_snapshots: DailyInstrumentSnapshot[]; // sorted ascending by date
  goals: GoalRecord[];
  goal_recalc_history: GoalRecalcEntry[];
  last_daily_job_run: string;
  last_monthly_recalc_run: string;
}

const DATA_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), 'meridian_portfolio_data')
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'portfolio_db.json');
let memoryFallbackDb: DatabaseSchema | null = null;

// Popular Indian Stocks & AMFI Mutual Funds catalog for instant search + fallback
const POPULAR_INDIAN_INSTRUMENTS: Array<{
  symbol: string;
  name: string;
  instrument_type: InstrumentType;
  exchange: ExchangeType;
  fallback_price: number;
}> = [
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
  { symbol: '500325.BO', name: 'Reliance Industries Ltd. (BSE)', instrument_type: 'stock', exchange: 'BSE', fallback_price: 1294.10 },
  { symbol: '500180.BO', name: 'HDFC Bank Ltd. (BSE)', instrument_type: 'stock', exchange: 'BSE', fallback_price: 1741.85 },
  { symbol: '122639', name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 84.6214 },
  { symbol: '120716', name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 168.3942 },
  { symbol: '118989', name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 196.4820 },
  { symbol: '120503', name: 'Axis ELSS Tax Saver Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 98.4120 },
  { symbol: '125497', name: 'SBI Small Cap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 189.7340 },
  { symbol: '119598', name: 'Mirae Asset Large & Midcap Fund - Direct Plan - Growth', instrument_type: 'mutual_fund', exchange: 'N/A', fallback_price: 158.9210 }
];

// Core Formula Helpers from Specification
export function annualToMonthlyRate(rDecimal: number): number {
  if (rDecimal <= -0.99) return -0.5;
  return Math.pow(1 + rDecimal, 1 / 12) - 1;
}

export function computeSipFutureValue(P: number, i: number, N: number): number {
  if (N <= 0) return 0;
  if (Math.abs(i) < 1e-9) return P * N;
  return P * ((Math.pow(1 + i, N) - 1) / i) * (1 + i);
}

/**
 * Mode A: Solve for P given target FV, N months, monthly rate i, and already accumulated amount A.
 * Spec: replace FV with (FV - A * (1+i)^N) so past contributions compound forward rather than being double-counted.
 */
export function solveModeARequiredSip(
  targetFV: number,
  monthsN: number,
  annualReturnDecimal: number,
  accumulatedA: number = 0
): number {
  if (monthsN <= 0) return Math.max(0, targetFV - accumulatedA);
  const i = annualToMonthlyRate(annualReturnDecimal);
  const compoundedA = accumulatedA * Math.pow(1 + i, monthsN);
  const effectiveFV = Math.max(0, targetFV - compoundedA);
  if (effectiveFV <= 0) return 0;

  if (Math.abs(i) < 1e-9) {
    return effectiveFV / monthsN;
  }
  const denominator = (Math.pow(1 + i, monthsN) - 1) * (1 + i);
  if (Math.abs(denominator) < 1e-9) return effectiveFV / monthsN;
  return (effectiveFV * i) / denominator;
}

/**
 * Mode B: Solve numerically (binary search + Newton refinement) for N (months to target)
 * given target FV, fixed monthly SIP P, annual return r, and already accumulated A.
 * Equation: (FV - A*(1+i)^N) - P * (((1+i)^N - 1)/i) * (1+i) = 0
 */
export function solveModeBMonthsToTarget(
  targetFV: number,
  monthlySipP: number,
  annualReturnDecimal: number,
  accumulatedA: number = 0
): { months: number | null; status: 'ok' | 'already_reached' | 'non_positive_return' | 'unreachable'; zeroReturnMonths?: number } {
  if (accumulatedA >= targetFV) {
    return { months: 0, status: 'already_reached' };
  }
  if (monthlySipP <= 0 && annualReturnDecimal <= 0) {
    return { months: null, status: 'unreachable' };
  }

  const zeroReturnMonths = monthlySipP > 0 ? Math.ceil((targetFV - accumulatedA) / monthlySipP) : undefined;

  if (annualReturnDecimal <= 0) {
    return {
      months: null,
      status: 'non_positive_return',
      zeroReturnMonths
    };
  }

  const i = annualToMonthlyRate(annualReturnDecimal);

  // Closed-form exact check or binary search over [0, 1200] months (100 years)
  const f = (N: number): number => {
    const compoundedA = accumulatedA * Math.pow(1 + i, N);
    const sipFV = P_fv(monthlySipP, i, N);
    return compoundedA + sipFV - targetFV;
  };

  function P_fv(P: number, rate: number, n: number) {
    if (n <= 0) return 0;
    return P * ((Math.pow(1 + rate, n) - 1) / rate) * (1 + rate);
  }

  let low = 0;
  let high = 1200; // 100 years max cap
  if (f(high) < 0) {
    return { months: null, status: 'unreachable', zeroReturnMonths };
  }

  for (let iter = 0; iter < 60; iter++) {
    const mid = (low + high) / 2;
    if (f(mid) >= 0) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const solvedMonths = Number(high.toFixed(1));
  return { months: solvedMonths, status: 'ok', zeroReturnMonths };
}

export function addMonthsToDate(dateStr: string, monthsToAdd: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const wholeMonths = Math.floor(monthsToAdd);
  const extraDays = Math.round((monthsToAdd - wholeMonths) * 30);
  d.setUTCMonth(d.getUTCMonth() + wholeMonths);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}

export function monthsBetweenDates(startDateStr: string, endDateStr: string): number {
  const d1 = new Date(startDateStr + 'T00:00:00Z');
  const d2 = new Date(endDateStr + 'T00:00:00Z');
  const diffDays = (d2.getTime() - d1.getTime()) / (1000 * 3600 * 24);
  return Math.max(0, Number((diffDays / 30.4375).toFixed(1)));
}

// FIFO Engine: Processes all transactions in chronological order
export interface OpenLot {
  lot_id: string;
  symbol: string;
  name: string;
  instrument_type: InstrumentType;
  exchange: ExchangeType;
  buy_date: string;
  original_quantity: number;
  open_quantity: number;
  buy_price: number;
  invested_value: number;
  current_price: number;
  current_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface RealizedSaleRecord {
  sale_id: string;
  matched_lot_id: string;
  symbol: string;
  name: string;
  instrument_type: InstrumentType;
  quantity_sold: number;
  buy_price: number;
  buy_date: string;
  sell_price: number;
  sell_date: string;
  proceeds: number;
  cost_basis: number;
  realized_pnl: number;
  realized_pnl_pct: number;
}

export function computePortfolioLotsAndPnl(
  transactions: TransactionRecord[],
  instruments: Record<string, InstrumentPriceInfo>,
  asOfDate?: string,
  priceOverrides?: Record<string, number>
) {
  const sortedTx = [...transactions]
    .filter((tx) => !asOfDate || tx.date <= asOfDate)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      // If same date, process buys before sells
      if (a.transaction_type !== b.transaction_type) {
        return a.transaction_type === 'buy' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });

  const openLotsMap = new Map<string, OpenLot[]>(); // symbol -> array of lots
  const realizedSales: RealizedSaleRecord[] = [];

  for (const tx of sortedTx) {
    const sym = tx.symbol;
    if (!openLotsMap.has(sym)) {
      openLotsMap.set(sym, []);
    }
    const symbolLots = openLotsMap.get(sym)!;

    if (tx.transaction_type === 'buy') {
      const latestPrice =
        priceOverrides?.[sym] ??
        instruments[sym]?.latest_price ??
        tx.price;
      const invested = tx.quantity * tx.price;
      const currVal = tx.quantity * latestPrice;
      symbolLots.push({
        lot_id: tx.id,
        symbol: sym,
        name: tx.name,
        instrument_type: tx.instrument_type,
        exchange: tx.exchange,
        buy_date: tx.date,
        original_quantity: tx.quantity,
        open_quantity: tx.quantity,
        buy_price: tx.price,
        invested_value: invested,
        current_price: latestPrice,
        current_value: currVal,
        unrealized_pnl: currVal - invested,
        unrealized_pnl_pct: invested > 0 ? ((currVal - invested) / invested) * 100 : 0
      });
    } else if (tx.transaction_type === 'sell') {
      let remainingToSell = tx.quantity;

      // If user specified a target_lot_id, match against that lot first, then FIFO for any remainder
      const orderedLots = tx.target_lot_id
        ? [
            ...symbolLots.filter((l) => l.lot_id === tx.target_lot_id && l.open_quantity > 1e-6),
            ...symbolLots.filter((l) => l.lot_id !== tx.target_lot_id && l.open_quantity > 1e-6)
          ]
        : symbolLots.filter((l) => l.open_quantity > 1e-6);

      for (const lot of orderedLots) {
        if (remainingToSell <= 1e-6) break;
        const matchedQty = Math.min(lot.open_quantity, remainingToSell);
        lot.open_quantity = Number((lot.open_quantity - matchedQty).toFixed(6));
        remainingToSell = Number((remainingToSell - matchedQty).toFixed(6));

        const costBasis = matchedQty * lot.buy_price;
        const proceeds = matchedQty * tx.price;
        const realizedPnl = proceeds - costBasis;

        realizedSales.push({
          sale_id: tx.id,
          matched_lot_id: lot.lot_id,
          symbol: sym,
          name: lot.name,
          instrument_type: lot.instrument_type,
          quantity_sold: matchedQty,
          buy_price: lot.buy_price,
          buy_date: lot.buy_date,
          sell_price: tx.price,
          sell_date: tx.date,
          proceeds,
          cost_basis: costBasis,
          realized_pnl: realizedPnl,
          realized_pnl_pct: costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0
        });
      }
    }
  }

  // Finalize open lots metrics with latest prices
  const allOpenLots: OpenLot[] = [];
  for (const [sym, lots] of openLotsMap.entries()) {
    const latestPrice = priceOverrides?.[sym] ?? instruments[sym]?.latest_price ?? 0;
    for (const lot of lots) {
      if (lot.open_quantity > 1e-5) {
        const currPrice = latestPrice > 0 ? latestPrice : lot.buy_price;
        lot.current_price = currPrice;
        lot.invested_value = lot.open_quantity * lot.buy_price;
        lot.current_value = lot.open_quantity * currPrice;
        lot.unrealized_pnl = lot.current_value - lot.invested_value;
        lot.unrealized_pnl_pct =
          lot.invested_value > 0 ? (lot.unrealized_pnl / lot.invested_value) * 100 : 0;
        allOpenLots.push(lot);
      }
    }
  }

  return {
    openLots: allOpenLots,
    realizedSales
  };
}

// Generate realistic 5-year historical snapshots so 7D, 30D, 3M, 6M, 1Y, 5Y, and Overall work immediately
function createInitialSeedDatabase(): DatabaseSchema {
  const todayStr = '2026-11-10';

  const instruments: Record<string, InstrumentPriceInfo> = {
    'RELIANCE.NS': {
      symbol: 'RELIANCE.NS',
      instrument_type: 'stock',
      name: 'Reliance Industries Ltd.',
      exchange: 'NSE',
      latest_price: 1294.65,
      previous_close: 1281.40,
      high_52w: 1608.80,
      low_52w: 1156.00,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    'HDFCBANK.NS': {
      symbol: 'HDFCBANK.NS',
      instrument_type: 'stock',
      name: 'HDFC Bank Ltd.',
      exchange: 'NSE',
      latest_price: 1742.30,
      previous_close: 1728.90,
      high_52w: 1794.00,
      low_52w: 1363.55,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    'TCS.NS': {
      symbol: 'TCS.NS',
      instrument_type: 'stock',
      name: 'Tata Consultancy Services Ltd.',
      exchange: 'NSE',
      latest_price: 4148.75,
      previous_close: 4162.10,
      high_52w: 4592.25,
      low_52w: 3591.50,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    '122639': {
      symbol: '122639',
      instrument_type: 'mutual_fund',
      name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      exchange: 'N/A',
      latest_price: 84.6214,
      previous_close: 84.1108,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    '120716': {
      symbol: '120716',
      instrument_type: 'mutual_fund',
      name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      exchange: 'N/A',
      latest_price: 168.3942,
      previous_close: 167.2180,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    '118989': {
      symbol: '118989',
      instrument_type: 'mutual_fund',
      name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth',
      exchange: 'N/A',
      latest_price: 196.4820,
      previous_close: 194.8500,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    }
  };

  const transactions: TransactionRecord[] = [
    // 5+ year old core positions
    {
      id: 'tx-101',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 120,
      price: 785.00,
      date: '2021-08-16',
      exchange: 'NSE'
    },
    // Second buy lot of RELIANCE.NS (demonstrates multi-lot averaging + FIFO)
    {
      id: 'tx-102',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 60,
      price: 1120.00,
      date: '2025-02-10',
      exchange: 'NSE'
    },
    // Partial FIFO sale of RELIANCE.NS (sells 40 shares against oldest lot tx-101 bought at ₹785)
    {
      id: 'tx-103',
      instrument_type: 'stock',
      transaction_type: 'sell',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 40,
      price: 1310.00,
      date: '2026-06-18',
      exchange: 'NSE'
    },
    // Parag Parikh Flexi Cap MF - two SIP/lump-sum lots
    {
      id: 'tx-104',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '122639',
      name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      quantity: 2450.525,
      price: 46.80,
      date: '2021-10-05',
      exchange: 'N/A'
    },
    {
      id: 'tx-105',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '122639',
      name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      quantity: 1150.000,
      price: 68.40,
      date: '2025-04-14',
      exchange: 'N/A'
    },
    // HDFC Bank stock
    {
      id: 'tx-106',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'HDFCBANK.NS',
      name: 'HDFC Bank Ltd.',
      quantity: 95,
      price: 1465.00,
      date: '2024-05-20',
      exchange: 'NSE'
    },
    // UTI Nifty 50 Index Fund
    {
      id: 'tx-107',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '120716',
      name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      quantity: 1420.85,
      price: 138.20,
      date: '2024-11-01',
      exchange: 'N/A'
    },
    // HDFC Mid-Cap Opportunities (Bought recently ~20 days ago to demonstrate new-holding window rule!)
    {
      id: 'tx-108',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '118989',
      name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth',
      quantity: 520.00,
      price: 191.20,
      date: '2026-10-20',
      exchange: 'N/A'
    },
    // TCS.NS bought & partially sold
    {
      id: 'tx-109',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'TCS.NS',
      name: 'Tata Consultancy Services Ltd.',
      quantity: 35,
      price: 3680.00,
      date: '2025-07-12',
      exchange: 'NSE'
    },
    {
      id: 'tx-110',
      instrument_type: 'stock',
      transaction_type: 'sell',
      symbol: 'TCS.NS',
      name: 'Tata Consultancy Services Ltd.',
      quantity: 10,
      price: 4290.00,
      date: '2026-09-04',
      exchange: 'NSE'
    }
  ];

  // Key anchor dates for lookback windows relative to 2026-11-10:
  // 5Y ago: 2021-11-10
  // 1Y ago: 2025-11-10
  // 6M ago: 2026-05-10
  // 3M ago: 2026-08-10
  // 30D ago: 2026-10-11
  // 7D ago: 2026-11-03
  // Today: 2026-11-10
  const anchorPrices: Array<{ date: string; prices: Record<string, number> }> = [
    {
      date: '2021-11-10',
      prices: {
        'RELIANCE.NS': 812.40,
        'HDFCBANK.NS': 1290.00,
        'TCS.NS': 3180.00,
        '122639': 48.1200,
        '120716': 104.5000,
        '118989': 94.2000
      }
    },
    {
      date: '2025-11-10',
      prices: {
        'RELIANCE.NS': 1118.50,
        'HDFCBANK.NS': 1512.00,
        'TCS.NS': 3740.00,
        '122639': 69.8500,
        '120716': 144.6000,
        '118989': 156.4000
      }
    },
    {
      date: '2026-05-10',
      prices: {
        'RELIANCE.NS': 1198.20,
        'HDFCBANK.NS': 1618.40,
        'TCS.NS': 3925.00,
        '122639': 76.4200,
        '120716': 155.8000,
        '118989': 174.9000
      }
    },
    {
      date: '2026-06-10',
      prices: {
        'RELIANCE.NS': 1215.00,
        'HDFCBANK.NS': 1640.00,
        'TCS.NS': 3980.00,
        '122639': 77.9000,
        '120716': 158.1000,
        '118989': 178.5000
      }
    },
    {
      date: '2026-07-10',
      prices: {
        'RELIANCE.NS': 1232.00,
        'HDFCBANK.NS': 1665.00,
        'TCS.NS': 4010.00,
        '122639': 79.1000,
        '120716': 160.4000,
        '118989': 182.2000
      }
    },
    {
      date: '2026-08-10',
      prices: {
        'RELIANCE.NS': 1244.80,
        'HDFCBANK.NS': 1682.50,
        'TCS.NS': 4055.00,
        '122639': 80.4500,
        '120716': 162.1000,
        '118989': 185.9000
      }
    },
    {
      date: '2026-09-10',
      prices: {
        'RELIANCE.NS': 1258.00,
        'HDFCBANK.NS': 1698.00,
        'TCS.NS': 4090.00,
        '122639': 81.8000,
        '120716': 164.0000,
        '118989': 189.4000
      }
    },
    {
      date: '2026-10-11',
      prices: {
        'RELIANCE.NS': 1269.40,
        'HDFCBANK.NS': 1711.20,
        'TCS.NS': 4118.00,
        '122639': 82.9500,
        '120716': 165.4500,
        '118989': 191.0000
      }
    },
    {
      date: '2026-11-03',
      prices: {
        'RELIANCE.NS': 1281.90,
        'HDFCBANK.NS': 1726.80,
        'TCS.NS': 4158.00,
        '122639': 83.8200,
        '120716': 166.9500,
        '118989': 194.1000
      }
    },
    {
      date: todayStr,
      prices: {
        'RELIANCE.NS': 1294.65,
        'HDFCBANK.NS': 1742.30,
        'TCS.NS': 4148.75,
        '122639': 84.6214,
        '120716': 168.3942,
        '118989': 196.4820
      }
    }
  ];

  const price_snapshots: DailyInstrumentSnapshot[] = anchorPrices.map((snap) => {
    const { openLots } = computePortfolioLotsAndPnl(transactions, instruments, snap.date, snap.prices);
    const totalVal = openLots.reduce((sum, l) => sum + l.current_value, 0);
    return {
      date: snap.date,
      prices: snap.prices,
      portfolio_total_value: Number(totalVal.toFixed(2)),
      timestamp: `${snap.date}T16:30:00Z`
    };
  });

  // Trailing 1Y return on seed portfolio (~16.82%)
  const trailing1Y = 16.82;

  const goals: GoalRecord[] = [
    {
      id: 'goal-mode-a-1',
      name: 'Retirement Freedom Corpus',
      mode: 'A',
      target_amount: 25000000, // ₹2.50 Crore
      accumulated_amount: 952400, // Linked current portfolio / initial corpus
      created_date: '2026-06-01',
      target_date: '2036-11-10', // 120 months
      initial_required_sip: 58420,
      current_required_sip: Math.round(solveModeARequiredSip(25000000, 120, trailing1Y / 100, 952400)),
      last_trailing_1y_return_pct: trailing1Y
    },
    {
      id: 'goal-mode-b-1',
      name: 'Home Downpayment Fund',
      mode: 'B',
      target_amount: 4500000, // ₹45 Lakhs
      accumulated_amount: 620000,
      created_date: '2026-06-01',
      monthly_sip: 45000,
      initial_target_date: '2030-09-15',
      current_target_date: '2030-07-24',
      current_months_to_target: 44.5,
      last_trailing_1y_return_pct: trailing1Y
    }
  ];

  const goal_recalc_history: GoalRecalcEntry[] = [
    {
      id: 'recalc-1',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-06-10',
      trailing_1y_return_pct: 15.10,
      accumulated_amount: 810000,
      adjusted_monthly_sip: 61850,
      note: 'Initial baseline schedule'
    },
    {
      id: 'recalc-2',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-07-10',
      trailing_1y_return_pct: 15.65,
      accumulated_amount: 842000,
      adjusted_monthly_sip: 59410,
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-3',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-08-10',
      trailing_1y_return_pct: 16.05,
      accumulated_amount: 876500,
      adjusted_monthly_sip: 57290,
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-4',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-09-10',
      trailing_1y_return_pct: 16.40,
      accumulated_amount: 904000,
      adjusted_monthly_sip: 55480,
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-5',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-10-10',
      trailing_1y_return_pct: 16.58,
      accumulated_amount: 928000,
      adjusted_monthly_sip: 54620,
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-6',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-11-10',
      trailing_1y_return_pct: trailing1Y,
      accumulated_amount: 952400,
      adjusted_monthly_sip: Math.round(solveModeARequiredSip(25000000, 120, trailing1Y / 100, 952400)),
      note: 'Latest monthly recalculation'
    },
    // Mode B history
    {
      id: 'recalc-b1',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-06-10',
      trailing_1y_return_pct: 15.10,
      accumulated_amount: 510000,
      adjusted_months_remaining: 48.2,
      adjusted_target_date: '2030-06-16',
      note: 'Initial baseline schedule'
    },
    {
      id: 'recalc-b2',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-07-10',
      trailing_1y_return_pct: 15.65,
      accumulated_amount: 534000,
      adjusted_months_remaining: 47.1,
      adjusted_target_date: '2030-06-13',
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-b3',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-08-10',
      trailing_1y_return_pct: 16.05,
      accumulated_amount: 558000,
      adjusted_months_remaining: 46.3,
      adjusted_target_date: '2030-06-19',
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-b4',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-09-10',
      trailing_1y_return_pct: 16.40,
      accumulated_amount: 580000,
      adjusted_months_remaining: 45.6,
      adjusted_target_date: '2030-06-28',
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-b5',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-10-10',
      trailing_1y_return_pct: 16.58,
      accumulated_amount: 601000,
      adjusted_months_remaining: 45.0,
      adjusted_target_date: '2030-07-10',
      note: 'Monthly cron recalculation'
    },
    {
      id: 'recalc-b6',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-11-10',
      trailing_1y_return_pct: trailing1Y,
      accumulated_amount: 620000,
      adjusted_months_remaining: 44.5,
      adjusted_target_date: '2030-07-24',
      note: 'Latest monthly recalculation'
    }
  ];

  return {
    transactions,
    instruments,
    price_snapshots,
    goals,
    goal_recalc_history,
    last_daily_job_run: '2026-11-10T10:00:00Z',
    last_monthly_recalc_run: '2026-11-10T10:00:00Z'
  };
}

function loadDb(): DatabaseSchema {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
      const seed = memoryFallbackDb || createInitialSeedDatabase();
      memoryFallbackDb = seed;
      fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2), 'utf-8');
      return seed;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as DatabaseSchema;
    memoryFallbackDb = parsed;
    return parsed;
  } catch {
    if (!memoryFallbackDb) {
      memoryFallbackDb = createInitialSeedDatabase();
    }
    return memoryFallbackDb;
  }
}

function saveDb(db: DatabaseSchema) {
  memoryFallbackDb = db;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch {
    // Ignore read-only filesystem errors on serverless environments; memoryFallbackDb holds state
  }
}

// Fetch live price from Yahoo Finance (.NS / .BO) or MFAPI.in (AMFI scheme code)
async function refreshInstrumentPrice(
  symbol: string,
  instrument_type: InstrumentType,
  existing?: InstrumentPriceInfo
): Promise<InstrumentPriceInfo> {
  const cleanSym = symbol.trim();
  const fallbackCatalog = POPULAR_INDIAN_INSTRUMENTS.find(
    (item) => item.symbol.toUpperCase() === cleanSym.toUpperCase()
  );

  const baseInfo: InstrumentPriceInfo = existing || {
    symbol: cleanSym,
    instrument_type,
    name: fallbackCatalog?.name || cleanSym,
    exchange: instrument_type === 'mutual_fund' ? 'N/A' : cleanSym.endsWith('.BO') ? 'BSE' : 'NSE',
    latest_price: fallbackCatalog?.fallback_price || 100,
    previous_close: fallbackCatalog?.fallback_price ? Number((fallbackCatalog.fallback_price * 0.992).toFixed(2)) : 99,
    last_updated: new Date().toISOString(),
    source: 'cached_fallback'
  };

  if (instrument_type === 'mutual_fund') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(cleanSym)}`, {
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const json = await res.json();
        if (json?.data && Array.isArray(json.data) && json.data.length > 0) {
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
      // Fall back to last known good price
    }
    return baseInfo;
  } else {
    // Stock via Yahoo Finance JSON endpoint (.NS / .BO)
    const yahooTicker =
      cleanSym.endsWith('.NS') || cleanSym.endsWith('.BO') ? cleanSym.toUpperCase() : `${cleanSym.toUpperCase()}.NS`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      clearTimeout(timer);

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
            high_52w: meta.fiftyTwoWeekHigh ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : baseInfo.high_52w,
            low_52w: meta.fiftyTwoWeekLow ? Number(meta.fiftyTwoWeekLow.toFixed(2)) : baseInfo.low_52w,
            last_updated: new Date().toISOString(),
            source: 'yahoo_live'
          };
        }
      }
    } catch {
      // Fall back to cached price
    }
    return baseInfo;
  }
}

/**
 * Period P/L% computation adhering strictly to the specification:
 * Windows: 7D, 30D, 3M, 6M, 1Y, 5Y, and Overall.
 * Spec:
 * "For each window, P/L% = (value_now - value_at_window_start) / value_at_window_start * 100,
 * where value_at_window_start is the portfolio's total value on that past date, taken from the daily snapshot history
 * — not a theoretical back-calculation. If a holding didn't exist yet at the window's start date (bought more recently
 * than the window), the window's starting value for that instrument is its invested_value on its own buy date, so new
 * additions don't distort period returns for holdings that predate them. 'Overall' P/L% uses total invested_value vs
 * total current_value across all lots, regardless of date.
 * Display both the blended portfolio % and a per-instrument breakdown."
 */
export interface PeriodWindowMetric {
  window_key: '7D' | '30D' | '3M' | '6M' | '1Y' | '5Y' | 'OVERALL';
  label: string;
  start_date: string;
  value_at_start: number;
  value_now: number;
  pnl_amount: number;
  pnl_pct: number;
}

export interface InstrumentRollup {
  symbol: string;
  name: string;
  instrument_type: InstrumentType;
  exchange: ExchangeType;
  total_open_quantity: number;
  avg_buy_price: number;
  latest_price: number;
  previous_close: number;
  high_52w?: number;
  low_52w?: number;
  price_source: string;
  invested_value: number;
  current_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  realized_pnl: number;
  day_change_amount: number;
  day_change_pct: number;
  first_buy_date: string;
  lots: OpenLot[];
  period_pnl: Record<'7D' | '30D' | '3M' | '6M' | '1Y' | '5Y' | 'OVERALL', {
    value_at_start: number;
    value_now: number;
    pnl_amount: number;
    pnl_pct: number;
    used_buy_date_basis: boolean;
  }>;
}

function getTargetWindowDate(referenceDateStr: string, daysBack: number): string {
  const d = new Date(referenceDateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function findClosestSnapshotOnOrBefore(
  snapshots: DailyInstrumentSnapshot[],
  targetDateStr: string
): DailyInstrumentSnapshot | undefined {
  if (snapshots.length === 0) return undefined;
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  let candidate = sorted[0];
  for (const snap of sorted) {
    if (snap.date <= targetDateStr) {
      candidate = snap;
    } else {
      break;
    }
  }
  return candidate;
}

function buildPortfolioAnalytics(db: DatabaseSchema) {
  const todayStr = db.price_snapshots.length > 0
    ? db.price_snapshots[db.price_snapshots.length - 1].date
    : new Date().toISOString().slice(0, 10);

  const { openLots, realizedSales } = computePortfolioLotsAndPnl(db.transactions, db.instruments);

  const windowsConfig: Array<{ key: '7D' | '30D' | '3M' | '6M' | '1Y' | '5Y'; label: string; days: number }> = [
    { key: '7D', label: '7 Days', days: 7 },
    { key: '30D', label: '30 Days', days: 30 },
    { key: '3M', label: '3 Months', days: 91 },
    { key: '6M', label: '6 Months', days: 182 },
    { key: '1Y', label: '1 Year', days: 365 },
    { key: '5Y', label: '5 Years', days: 1825 }
  ];

  // Group open lots by symbol
  const symbolToLots = new Map<string, OpenLot[]>();
  for (const lot of openLots) {
    if (!symbolToLots.has(lot.symbol)) {
      symbolToLots.set(lot.symbol, []);
    }
    symbolToLots.get(lot.symbol)!.push(lot);
  }

  // Also sum realized P&L per symbol
  const symbolRealizedMap = new Map<string, number>();
  for (const sale of realizedSales) {
    symbolRealizedMap.set(sale.symbol, (symbolRealizedMap.get(sale.symbol) || 0) + sale.realized_pnl);
  }

  const instrumentRollups: InstrumentRollup[] = [];

  for (const [symbol, lots] of symbolToLots.entries()) {
    const info = db.instruments[symbol];
    const totalQty = lots.reduce((s, l) => s + l.open_quantity, 0);
    const investedVal = lots.reduce((s, l) => s + l.invested_value, 0);
    const currentVal = lots.reduce((s, l) => s + l.current_value, 0);
    const unrealizedPnl = currentVal - investedVal;
    const unrealizedPct = investedVal > 0 ? (unrealizedPnl / investedVal) * 100 : 0;
    const avgBuy = totalQty > 0 ? investedVal / totalQty : 0;
    const latestPrice = info?.latest_price ?? (lots[0]?.current_price || avgBuy);
    const prevClose = info?.previous_close ?? latestPrice;
    const dayChangeAmt = (latestPrice - prevClose) * totalQty;
    const dayChangePct = prevClose > 0 ? ((latestPrice - prevClose) / prevClose) * 100 : 0;
    const firstBuyDate = lots.reduce((min, l) => (l.buy_date < min ? l.buy_date : min), lots[0].buy_date);

    const periodPnlMap = {} as InstrumentRollup['period_pnl'];

    for (const w of windowsConfig) {
      const windowStartDate = getTargetWindowDate(todayStr, w.days);
      const snap = findClosestSnapshotOnOrBefore(db.price_snapshots, windowStartDate);

      // Compute starting value lot-by-lot:
      // If a lot existed on or before windowStartDate, use snapshot price on windowStartDate × lot.open_quantity.
      // If a lot was bought AFTER windowStartDate, use its invested_value on its own buy_date!
      let instStartValue = 0;
      let anyUsedBuyDate = false;
      for (const lot of lots) {
        if (lot.buy_date > windowStartDate) {
          instStartValue += lot.open_quantity * lot.buy_price;
          anyUsedBuyDate = true;
        } else {
          const snapPrice = snap?.prices?.[symbol] ?? lot.buy_price;
          instStartValue += lot.open_quantity * snapPrice;
        }
      }

      const pnlAmt = currentVal - instStartValue;
      const pnlPct = instStartValue > 0 ? (pnlAmt / instStartValue) * 100 : 0;

      periodPnlMap[w.key] = {
        value_at_start: Number(instStartValue.toFixed(2)),
        value_now: Number(currentVal.toFixed(2)),
        pnl_amount: Number(pnlAmt.toFixed(2)),
        pnl_pct: Number(pnlPct.toFixed(2)),
        used_buy_date_basis: anyUsedBuyDate
      };
    }

    // OVERALL window uses total invested_value vs total current_value across all open lots
    periodPnlMap['OVERALL'] = {
      value_at_start: Number(investedVal.toFixed(2)),
      value_now: Number(currentVal.toFixed(2)),
      pnl_amount: Number(unrealizedPnl.toFixed(2)),
      pnl_pct: Number(unrealizedPct.toFixed(2)),
      used_buy_date_basis: true
    };

    instrumentRollups.push({
      symbol,
      name: info?.name || lots[0].name,
      instrument_type: info?.instrument_type || lots[0].instrument_type,
      exchange: info?.exchange || lots[0].exchange,
      total_open_quantity: Number(totalQty.toFixed(4)),
      avg_buy_price: Number(avgBuy.toFixed(2)),
      latest_price: Number(latestPrice.toFixed(4)),
      previous_close: Number(prevClose.toFixed(4)),
      high_52w: info?.high_52w,
      low_52w: info?.low_52w,
      price_source: info?.source || 'cached_fallback',
      invested_value: Number(investedVal.toFixed(2)),
      current_value: Number(currentVal.toFixed(2)),
      unrealized_pnl: Number(unrealizedPnl.toFixed(2)),
      unrealized_pnl_pct: Number(unrealizedPct.toFixed(2)),
      realized_pnl: Number((symbolRealizedMap.get(symbol) || 0).toFixed(2)),
      day_change_amount: Number(dayChangeAmt.toFixed(2)),
      day_change_pct: Number(dayChangePct.toFixed(2)),
      first_buy_date: firstBuyDate,
      lots,
      period_pnl: periodPnlMap
    });
  }

  // Blended Portfolio Period Windows
  const portfolioPeriodWindows: PeriodWindowMetric[] = windowsConfig.map((w) => {
    const targetDate = getTargetWindowDate(todayStr, w.days);
    const snap = findClosestSnapshotOnOrBefore(db.price_snapshots, targetDate);
    const startVal = instrumentRollups.reduce((s, inst) => s + inst.period_pnl[w.key].value_at_start, 0);
    const nowVal = instrumentRollups.reduce((s, inst) => s + inst.current_value, 0);
    const pnlAmt = nowVal - startVal;
    const pnlPct = startVal > 0 ? (pnlAmt / startVal) * 100 : 0;

    return {
      window_key: w.key,
      label: w.label,
      start_date: snap?.date || targetDate,
      value_at_start: Number(startVal.toFixed(2)),
      value_now: Number(nowVal.toFixed(2)),
      pnl_amount: Number(pnlAmt.toFixed(2)),
      pnl_pct: Number(pnlPct.toFixed(2))
    };
  });

  const totalInvested = instrumentRollups.reduce((s, i) => s + i.invested_value, 0);
  const totalCurrentValue = instrumentRollups.reduce((s, i) => s + i.current_value, 0);
  const totalUnrealizedPnl = totalCurrentValue - totalInvested;
  const totalUnrealizedPnlPct = totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0;
  const totalRealizedPnl = realizedSales.reduce((s, r) => s + r.realized_pnl, 0);
  const totalDayChange = instrumentRollups.reduce((s, i) => s + i.day_change_amount, 0);

  portfolioPeriodWindows.push({
    window_key: 'OVERALL',
    label: 'Overall (Since 1st Buy)',
    start_date: db.transactions.reduce((min, t) => (t.date < min ? t.date : min), todayStr),
    value_at_start: Number(totalInvested.toFixed(2)),
    value_now: Number(totalCurrentValue.toFixed(2)),
    pnl_amount: Number(totalUnrealizedPnl.toFixed(2)),
    pnl_pct: Number(totalUnrealizedPnlPct.toFixed(2))
  });

  const trailing1YWindow = portfolioPeriodWindows.find((w) => w.window_key === '1Y');
  const trailing1YReturnPct = trailing1YWindow ? trailing1YWindow.pnl_pct : totalUnrealizedPnlPct;

  return {
    summary: {
      reference_date: todayStr,
      total_invested: Number(totalInvested.toFixed(2)),
      total_current_value: Number(totalCurrentValue.toFixed(2)),
      unrealized_pnl: Number(totalUnrealizedPnl.toFixed(2)),
      unrealized_pnl_pct: Number(totalUnrealizedPnlPct.toFixed(2)),
      realized_pnl: Number(totalRealizedPnl.toFixed(2)),
      combined_total_pnl: Number((totalUnrealizedPnl + totalRealizedPnl).toFixed(2)),
      day_change_amount: Number(totalDayChange.toFixed(2)),
      trailing_1y_return_pct: Number(trailing1YReturnPct.toFixed(2)),
      open_holdings_count: instrumentRollups.length,
      open_lots_count: openLots.length,
      closed_sales_count: realizedSales.length,
      last_daily_job_run: db.last_daily_job_run,
      last_monthly_recalc_run: db.last_monthly_recalc_run
    },
    period_windows: portfolioPeriodWindows,
    holdings: instrumentRollups,
    realized_sales: realizedSales,
    transactions: [...db.transactions].sort((a, b) => b.date.localeCompare(a.date)),
    price_snapshots: db.price_snapshots,
    goals: db.goals,
    goal_recalc_history: db.goal_recalc_history
  };
}

export const app = express();
app.use(express.json());

function registerApiRoutes() {

  // 1. Get complete Portfolio, Period P/L%, Snapshots, and Goal Tracker state
  app.get('/api/portfolio', (_req, res) => {
    const db = loadDb();
    res.json(buildPortfolioAnalytics(db));
  });

  // 2. Instrument Lookup & Search (Queries both MFAPI.in /mf/search and Indian Stock catalog / Yahoo Finance)
  app.get('/api/lookup', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'all');

    if (!q) {
      res.json({ results: POPULAR_INDIAN_INSTRUMENTS.slice(0, 10) });
      return;
    }

    const localMatches = POPULAR_INDIAN_INSTRUMENTS.filter(
      (item) =>
        (type === 'all' || item.instrument_type === type) &&
        (item.symbol.toLowerCase().includes(q.toLowerCase()) ||
          item.name.toLowerCase().includes(q.toLowerCase()))
    );

    const remoteMfResults: typeof POPULAR_INDIAN_INSTRUMENTS = [];
    if (type === 'all' || type === 'mutual_fund') {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const mfRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal
        });
        clearTimeout(timer);
        if (mfRes.ok) {
          const data = await mfRes.json();
          if (Array.isArray(data)) {
            for (const item of data.slice(0, 8)) {
              remoteMfResults.push({
                symbol: String(item.schemeCode),
                name: String(item.schemeName),
                instrument_type: 'mutual_fund',
                exchange: 'N/A',
                fallback_price: 100
              });
            }
          }
        }
      } catch {
        // Ignore network error and use local matches
      }
    }

    // Deduplicate by symbol
    const seen = new Set<string>();
    const combined = [...localMatches, ...remoteMfResults].filter((item) => {
      if (seen.has(item.symbol)) return false;
      seen.add(item.symbol);
      return true;
    });

    res.json({ results: combined.slice(0, 12) });
  });

  // 3. Add Buy or Sell Transaction
  app.post('/api/transactions', async (req, res) => {
    const db = loadDb();
    const {
      instrument_type,
      transaction_type,
      symbol,
      name,
      quantity,
      price,
      date,
      exchange,
      target_lot_id
    } = req.body;

    if (!symbol || !quantity || Number(quantity) <= 0 || !price || Number(price) <= 0 || !date) {
      res.status(400).json({ error: 'Symbol, positive quantity, positive price, and date are required.' });
      return;
    }

    const cleanSymbol = String(symbol).trim().toUpperCase();
    const numQty = Number(quantity);
    const numPrice = Number(price);

    // If selling, verify sufficient open quantity exists
    if (transaction_type === 'sell') {
      const { openLots } = computePortfolioLotsAndPnl(db.transactions, db.instruments);
      const openForSymbol = openLots
        .filter((l) => l.symbol.toUpperCase() === cleanSymbol)
        .reduce((sum, l) => sum + l.open_quantity, 0);

      if (numQty > openForSymbol + 1e-5) {
        res.status(400).json({
          error: `Cannot sell ${numQty} units of ${cleanSymbol}. You only have ${Number(openForSymbol.toFixed(4))} open units available.`
        });
        return;
      }
    }

    const newTx: TransactionRecord = {
      id: `tx-${Date.now()}`,
      instrument_type: instrument_type === 'mutual_fund' ? 'mutual_fund' : 'stock',
      transaction_type: transaction_type === 'sell' ? 'sell' : 'buy',
      symbol: cleanSymbol,
      name: String(name || cleanSymbol).trim(),
      quantity: numQty,
      price: numPrice,
      date: String(date),
      exchange: instrument_type === 'mutual_fund' ? 'N/A' : exchange === 'BSE' ? 'BSE' : 'NSE',
      target_lot_id: target_lot_id || undefined
    };

    db.transactions.push(newTx);

    // Ensure instrument exists and pull latest price
    const refreshed = await refreshInstrumentPrice(
      cleanSymbol,
      newTx.instrument_type,
      db.instruments[cleanSymbol] || {
        symbol: cleanSymbol,
        instrument_type: newTx.instrument_type,
        name: newTx.name,
        exchange: newTx.exchange,
        latest_price: numPrice,
        previous_close: numPrice,
        last_updated: new Date().toISOString(),
        source: 'cached_fallback'
      }
    );
    db.instruments[cleanSymbol] = refreshed;

    // Update latest snapshot's portfolio total value
    if (db.price_snapshots.length > 0) {
      const latestSnap = db.price_snapshots[db.price_snapshots.length - 1];
      latestSnap.prices[cleanSymbol] = refreshed.latest_price;
      const { openLots } = computePortfolioLotsAndPnl(db.transactions, db.instruments);
      latestSnap.portfolio_total_value = Number(
        openLots.reduce((s, l) => s + l.current_value, 0).toFixed(2)
      );
    }

    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 4. Delete Transaction (if logged by mistake)
  app.delete('/api/transactions/:id', (req, res) => {
    const db = loadDb();
    db.transactions = db.transactions.filter((t) => t.id !== req.params.id);
    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 5. Daily Price/NAV Pull & Snapshot Job (Cron + Manual Trigger)
  app.post('/api/jobs/daily-snapshot', async (_req, res) => {
    const db = loadDb();
    const uniqueSymbols = Array.from(new Set(db.transactions.map((t) => t.symbol)));

    const updatedPrices: Record<string, number> = {};
    await Promise.all(
      uniqueSymbols.map(async (sym) => {
        const sampleTx = db.transactions.find((t) => t.symbol === sym);
        const instType = db.instruments[sym]?.instrument_type || sampleTx?.instrument_type || 'stock';
        const refreshed = await refreshInstrumentPrice(sym, instType, db.instruments[sym]);
        db.instruments[sym] = refreshed;
        updatedPrices[sym] = refreshed.latest_price;
      })
    );

    const todayStr = new Date().toISOString().slice(0, 10);
    const { openLots } = computePortfolioLotsAndPnl(db.transactions, db.instruments);
    const totalVal = Number(openLots.reduce((s, l) => s + l.current_value, 0).toFixed(2));

    const existingIdx = db.price_snapshots.findIndex((s) => s.date === todayStr);
    const snapshotRecord: DailyInstrumentSnapshot = {
      date: todayStr,
      prices: {
        ...(db.price_snapshots[db.price_snapshots.length - 1]?.prices || {}),
        ...updatedPrices
      },
      portfolio_total_value: totalVal,
      timestamp: new Date().toISOString()
    };

    if (existingIdx >= 0) {
      db.price_snapshots[existingIdx] = snapshotRecord;
    } else {
      db.price_snapshots.push(snapshotRecord);
      db.price_snapshots.sort((a, b) => a.date.localeCompare(b.date));
    }

    db.last_daily_job_run = new Date().toISOString();
    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 6. Create Goal (Mode A or Mode B)
  app.post('/api/goals', (req, res) => {
    const db = loadDb();
    const analytics = buildPortfolioAnalytics(db);
    const trailing1Y =
      typeof req.body.custom_return_pct === 'number'
        ? Number(req.body.custom_return_pct)
        : analytics.summary.trailing_1y_return_pct;

    const { name, mode, target_amount, accumulated_amount, target_date, monthly_sip } = req.body;
    const numTarget = Number(target_amount);
    const numAccum = Number(accumulated_amount || 0);
    const todayStr = analytics.summary.reference_date;

    if (!name || isNaN(numTarget) || numTarget <= 0) {
      res.status(400).json({ error: 'Goal name and positive target amount are required.' });
      return;
    }

    const goalId = `goal-${Date.now()}`;

    if (mode === 'A') {
      const monthsN = monthsBetweenDates(todayStr, String(target_date));
      const reqSip = Math.round(solveModeARequiredSip(numTarget, monthsN, trailing1Y / 100, numAccum));
      const newGoal: GoalRecord = {
        id: goalId,
        name: String(name).trim(),
        mode: 'A',
        target_amount: numTarget,
        accumulated_amount: numAccum,
        created_date: todayStr,
        target_date: String(target_date),
        initial_required_sip: reqSip,
        current_required_sip: reqSip,
        last_trailing_1y_return_pct: trailing1Y
      };
      db.goals.push(newGoal);
      db.goal_recalc_history.push({
        id: `recalc-${Date.now()}`,
        goal_id: goalId,
        recalc_date: todayStr,
        trailing_1y_return_pct: trailing1Y,
        accumulated_amount: numAccum,
        adjusted_monthly_sip: reqSip,
        note: 'Goal created (Mode A)'
      });
    } else {
      const numSip = Number(monthly_sip || 0);
      const solved = solveModeBMonthsToTarget(numTarget, numSip, trailing1Y / 100, numAccum);
      const projDate =
        solved.months !== null ? addMonthsToDate(todayStr, solved.months) : undefined;

      const newGoal: GoalRecord = {
        id: goalId,
        name: String(name).trim(),
        mode: 'B',
        target_amount: numTarget,
        accumulated_amount: numAccum,
        created_date: todayStr,
        monthly_sip: numSip,
        initial_target_date: projDate,
        current_target_date: projDate,
        current_months_to_target: solved.months,
        last_trailing_1y_return_pct: trailing1Y
      };
      db.goals.push(newGoal);
      db.goal_recalc_history.push({
        id: `recalc-${Date.now()}`,
        goal_id: goalId,
        recalc_date: todayStr,
        trailing_1y_return_pct: trailing1Y,
        accumulated_amount: numAccum,
        adjusted_months_remaining: solved.months ?? undefined,
        adjusted_target_date: projDate,
        note: 'Goal created (Mode B)'
      });
    }

    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 7. Delete Goal
  app.delete('/api/goals/:id', (req, res) => {
    const db = loadDb();
    db.goals = db.goals.filter((g) => g.id !== req.params.id);
    db.goal_recalc_history = db.goal_recalc_history.filter((h) => h.goal_id !== req.params.id);
    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 8. Monthly Goal Recalculation Job (Cron + Manual Simulation with Optional Return/Accumulated Override)
  app.post('/api/jobs/monthly-goal-recalc', (req, res) => {
    const db = loadDb();
    const analytics = buildPortfolioAnalytics(db);
    const rPct =
      typeof req.body?.override_return_pct === 'number'
        ? Number(req.body.override_return_pct)
        : analytics.summary.trailing_1y_return_pct;

    const recalcDate = req.body?.recalc_date || new Date().toISOString().slice(0, 10);

    for (const goal of db.goals) {
      // Allow optional increment to accumulated_amount or sync with current portfolio value
      if (req.body?.sync_portfolio_value && goal.id === 'goal-mode-a-1') {
        goal.accumulated_amount = Math.round(analytics.summary.total_current_value);
      } else if (typeof req.body?.accumulated_Increment === 'number') {
        goal.accumulated_amount += Number(req.body.accumulated_Increment);
      }

      goal.last_trailing_1y_return_pct = rPct;

      if (goal.mode === 'A' && goal.target_date) {
        const monthsRemaining = monthsBetweenDates(recalcDate, goal.target_date);
        const adjustedSip = Math.round(
          solveModeARequiredSip(goal.target_amount, monthsRemaining, rPct / 100, goal.accumulated_amount)
        );
        goal.current_required_sip = adjustedSip;
        db.goal_recalc_history.push({
          id: `recalc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          goal_id: goal.id,
          recalc_date: recalcDate,
          trailing_1y_return_pct: rPct,
          accumulated_amount: goal.accumulated_amount,
          adjusted_monthly_sip: adjustedSip,
          note: req.body?.note || 'Scheduled monthly recalculation'
        });
      } else if (goal.mode === 'B' && goal.monthly_sip) {
        const solved = solveModeBMonthsToTarget(
          goal.target_amount,
          goal.monthly_sip,
          rPct / 100,
          goal.accumulated_amount
        );
        const newEta = solved.months !== null ? addMonthsToDate(recalcDate, solved.months) : undefined;
        goal.current_months_to_target = solved.months;
        goal.current_target_date = newEta;
        db.goal_recalc_history.push({
          id: `recalc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          goal_id: goal.id,
          recalc_date: recalcDate,
          trailing_1y_return_pct: rPct,
          accumulated_amount: goal.accumulated_amount,
          adjusted_months_remaining: solved.months ?? undefined,
          adjusted_target_date: newEta,
          note: req.body?.note || 'Scheduled monthly recalculation'
        });
      }
    }

    db.last_monthly_recalc_run = new Date().toISOString();
    saveDb(db);
    res.json(buildPortfolioAnalytics(db));
  });

  // 9. Batch Live Price & NAV Refresh Endpoint for Firebase Firestore Sync
  app.post('/api/prices/refresh-batch', async (req, res) => {
    const items: Array<{ symbol: string; instrument_type: InstrumentType; name?: string }> =
      Array.isArray(req.body?.items) ? req.body.items : [];

    const refreshedList = await Promise.all(
      items.map((item) =>
        refreshInstrumentPrice(item.symbol, item.instrument_type, {
          symbol: item.symbol,
          instrument_type: item.instrument_type,
          name: item.name || item.symbol,
          exchange: item.instrument_type === 'mutual_fund' ? 'N/A' : item.symbol.endsWith('.BO') ? 'BSE' : 'NSE',
          latest_price: 100,
          previous_close: 99,
          last_updated: new Date().toISOString(),
          source: 'cached_fallback'
        })
      )
    );

    res.json({
      timestamp: new Date().toISOString(),
      instruments: refreshedList
    });
  });
}

registerApiRoutes();

async function startServer() {
  const PORT = 3000;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Portfolio & Goal Tracker server running on http://0.0.0.0:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}
export default app;
