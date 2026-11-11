import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  ArrowUpRight,
  Trash2,
  LayoutGrid,
  Briefcase,
  Target,
  BarChart3,
  History
} from 'lucide-react';
import { PERSONAL_PORTFOLIO_ID } from './firebase';
import {
  addTransactionToFirestore,
  buildPortfolioAnalyticsFromFirestore,
  createGoalInFirestore,
  deleteGoalFromFirestore,
  deleteTransactionFromFirestore,
  FirestoreInstrumentDoc,
  getClientFallbackPortfolio,
  runDailySnapshotInFirestore,
  runMonthlyGoalRecalcInFirestore,
  seedUserFirestoreIfEmpty,
  subscribeToUserPortfolio
} from './services/firestorePortfolio';
import {
  ExchangeType,
  InstrumentType,
  PortfolioDataResponse,
  TransactionType,
  WindowKey
} from './types';
import { formatINR, formatNumberIN, formatPct } from './utils/financeMath';
import { TransactionModal } from './components/TransactionModal';
import { GoalsSection } from './components/GoalsSection';

export default function App() {
  const [data, setData] = useState<PortfolioDataResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRunningDailyJob, setIsRunningDailyJob] = useState<boolean>(false);
  const [activeSection, setActiveSection] = useState<
    'all' | 'holdings' | 'periods' | 'goals' | 'history'
  >('all');

  const [selectedWindow, setSelectedWindow] = useState<WindowKey>('1Y');
  const [instrumentFilter, setInstrumentFilter] = useState<'all' | 'stock' | 'mutual_fund'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSymbols, setExpandedSymbols] = useState<Record<string, boolean>>({
    'RELIANCE.NS': true,
    '122639': false
  });

  // Firebase Firestore State (Single-User Personal Workspace)
  const firestoreInstrumentsRef = useRef<Record<string, FirestoreInstrumentDoc>>({});

  // Modal state
  const [isTxModalOpen, setIsTxModalOpen] = useState(false);
  const [modalInitialSymbol, setModalInitialSymbol] = useState<string | undefined>(undefined);
  const [modalInitialTxType, setModalInitialTxType] = useState<TransactionType>('buy');

  const fetchLocalPortfolio = async (): Promise<PortfolioDataResponse> => {
    try {
      const res = await fetch('/api/portfolio');
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const json = (await res.json()) as PortfolioDataResponse;
        setData(json);
        return json;
      }
    } catch {
      // Fallback to built-in client portfolio below
    } finally {
      setIsLoading(false);
    }
    const fallback = getClientFallbackPortfolio();
    setData(fallback);
    return fallback;
  };

  // Automatically connect and sync with Firebase Firestore on startup across all devices
  useEffect(() => {
    let unsubFirestore: (() => void) | undefined;

    fetchLocalPortfolio().then(async (initialFallback) => {
      try {
        await seedUserFirestoreIfEmpty(PERSONAL_PORTFOLIO_ID, initialFallback);
      } catch (err) {
        console.error('Error seeding Firestore:', err);
      }

      unsubFirestore = subscribeToUserPortfolio(PERSONAL_PORTFOLIO_ID, (cloudState) => {
        firestoreInstrumentsRef.current = cloudState.instruments;
        if (cloudState.transactions.length > 0 || cloudState.goals.length > 0) {
          const computed = buildPortfolioAnalyticsFromFirestore(
            cloudState.transactions,
            cloudState.instruments,
            cloudState.snapshots,
            cloudState.goals,
            cloudState.recalcs
          );
          setData(computed);
        }
        setIsLoading(false);
      });
    });

    return () => {
      if (unsubFirestore) unsubFirestore();
    };
  }, []);

  const handleRunDailySnapshotJob = async () => {
    setIsRunningDailyJob(true);
    try {
      if (data) {
        await runDailySnapshotInFirestore(
          PERSONAL_PORTFOLIO_ID,
          data.transactions,
          firestoreInstrumentsRef.current,
          data.price_snapshots
        );
      }
    } finally {
      setIsRunningDailyJob(false);
    }
  };

  const handleAddTransaction = async (payload: {
    instrument_type: InstrumentType;
    transaction_type: TransactionType;
    symbol: string;
    name: string;
    quantity: number;
    price: number;
    date: string;
    exchange: ExchangeType;
    target_lot_id?: string;
  }) => {
    if (data) {
      if (payload.transaction_type === 'sell') {
        const match = data.holdings.find(
          (h) => h.symbol.toUpperCase() === payload.symbol.trim().toUpperCase()
        );
        const openQty = match?.total_open_quantity || 0;
        if (payload.quantity > openQty + 1e-5) {
          throw new Error(
            `Cannot sell ${payload.quantity} units of ${payload.symbol}. Only ${openQty} open units available.`
          );
        }
      }
      await addTransactionToFirestore(
        PERSONAL_PORTFOLIO_ID,
        payload,
        firestoreInstrumentsRef.current
      );
    }
  };

  const handleDeleteTransaction = async (id: string) => {
    await deleteTransactionFromFirestore(PERSONAL_PORTFOLIO_ID, id);
  };

  const handleCreateGoal = async (payload: {
    name: string;
    mode: 'A' | 'B';
    target_amount: number;
    accumulated_amount: number;
    target_date?: string;
    monthly_sip?: number;
    custom_return_pct?: number;
  }) => {
    if (data) {
      await createGoalInFirestore(
        PERSONAL_PORTFOLIO_ID,
        payload,
        data.summary.trailing_1y_return_pct,
        data.summary.reference_date
      );
    }
  };

  const handleDeleteGoal = async (id: string) => {
    if (data) {
      await deleteGoalFromFirestore(id, data.goal_recalc_history);
    }
  };

  const handleRunMonthlyRecalc = async (payload: {
    recalc_date: string;
    override_return_pct: number;
    accumulated_Increment: number;
    note: string;
  }) => {
    if (data) {
      await runMonthlyGoalRecalcInFirestore(PERSONAL_PORTFOLIO_ID, data.goals, payload);
    }
  };

  const toggleExpandSymbol = (sym: string) => {
    setExpandedSymbols((prev) => ({ ...prev, [sym]: !prev[sym] }));
  };

  if (isLoading || !data) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 sm:p-8">
        <div className="mx-auto max-w-7xl space-y-4 sm:space-y-6">
          <div className="h-14 animate-pulse rounded-2xl bg-slate-200" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
            <div className="h-24 animate-pulse rounded-2xl bg-slate-200" />
          </div>
          <div className="h-80 animate-pulse rounded-2xl bg-slate-200" />
        </div>
      </div>
    );
  }

  const {
    summary,
    period_windows,
    holdings,
    realized_sales,
    transactions,
    price_snapshots,
    goals,
    goal_recalc_history
  } = data;

  const filteredHoldings = holdings.filter((h) => {
    if (instrumentFilter !== 'all' && h.instrument_type !== instrumentFilter) return false;
    if (
      searchQuery.trim() &&
      !h.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !h.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  const activeWindowObj =
    period_windows.find((w) => w.window_key === selectedWindow) || period_windows[4];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Strictly Compliant 3-Zone Top Bar Contract (Compact 54px on mobile) */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-4 backdrop-blur-md sm:h-16 sm:gap-8 sm:px-6">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveSection('all');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 sm:text-lg"
        >
          Meridian Ledger
        </a>

        {/* Zone 2: 5 concise single-line navigation links (Desktop) */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => setActiveSection('all')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'all'
                ? 'text-slate-900 underline decoration-slate-900 decoration-2 underline-offset-4'
                : 'hover:text-slate-900'
            }`}
          >
            All-in-One
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('holdings')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'holdings'
                ? 'text-slate-900 underline decoration-slate-900 decoration-2 underline-offset-4'
                : 'hover:text-slate-900'
            }`}
          >
            Holdings & Lots
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('goals')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'goals'
                ? 'text-slate-900 underline decoration-slate-900 decoration-2 underline-offset-4'
                : 'hover:text-slate-900'
            }`}
          >
            Goal & SIP Calculator
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('periods')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'periods'
                ? 'text-slate-900 underline decoration-slate-900 decoration-2 underline-offset-4'
                : 'hover:text-slate-900'
            }`}
          >
            7-Window Matrix
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('history')}
            className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
              activeSection === 'history'
                ? 'text-slate-900 underline decoration-slate-900 decoration-2 underline-offset-4'
                : 'hover:text-slate-900'
            }`}
          >
            Sales & Snapshots
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setModalInitialSymbol(undefined);
              setModalInitialTxType('buy');
              setIsTxModalOpen(true);
            }}
            className="flex min-h-[40px] items-center gap-1.5 rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Log Transaction
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-3.5 pt-4 pb-24 sm:space-y-8 sm:px-6 sm:pt-7 md:pb-12">

        {/* Quick Action & Desktop Switcher Bar */}
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xs no-scrollbar">
            <button
              type="button"
              onClick={() => setActiveSection('all')}
              className={`min-h-[38px] shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeSection === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              Full View
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('goals')}
              className={`min-h-[38px] shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeSection === 'goals'
                  ? 'bg-slate-900 text-white'
                  : 'bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
              }`}
            >
              Goal & SIP ({goals.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('holdings')}
              className={`min-h-[38px] shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeSection === 'holdings'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              Holdings ({holdings.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('periods')}
              className={`min-h-[38px] shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeSection === 'periods'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              7-Window P/L%
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('history')}
              className={`min-h-[38px] shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeSection === 'history'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              Sales & Snapshots
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:gap-2.5">
            <button
              type="button"
              onClick={handleRunDailySnapshotJob}
              disabled={isRunningDailyJob}
              className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 shrink-0 ${isRunningDailyJob ? 'animate-spin' : ''}`}
              />
              <span>{isRunningDailyJob ? 'Updating...' : 'Refresh Prices'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setModalInitialSymbol(undefined);
                setModalInitialTxType('sell');
                setIsTxModalOpen(true);
              }}
              className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
            >
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span>Record Sale (FIFO)</span>
            </button>
          </div>
        </div>

        {/* 2x2 Mobile / 4-Column Desktop KPI Strip */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 sm:gap-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
            <div className="text-[11px] font-medium text-slate-500 sm:text-xs">
              Current Value
            </div>
            <div className="mt-1 font-mono text-lg font-bold text-slate-900 tabular-nums sm:text-2xl">
              {formatINR(summary.total_current_value)}
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 font-mono tabular-nums truncate">
              Inv: {formatINR(summary.total_invested)} · {summary.open_lots_count} lots
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
            <div className="text-[11px] font-medium text-slate-500 sm:text-xs">
              Unrealized P/L
            </div>
            <div
              className={`mt-1 font-mono text-lg font-bold tabular-nums sm:text-2xl ${
                summary.unrealized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {summary.unrealized_pnl >= 0 ? '+' : ''}
              {formatINR(summary.unrealized_pnl)}
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-500 font-mono tabular-nums truncate">
              <span
                className={
                  summary.unrealized_pnl_pct >= 0
                    ? 'text-emerald-700 font-semibold'
                    : 'text-rose-700 font-semibold'
                }
              >
                {formatPct(summary.unrealized_pnl_pct, 2)}
              </span>
              <span>·</span>
              <span>1D: {formatINR(summary.day_change_amount)}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
            <div className="text-[11px] font-medium text-slate-500 sm:text-xs">
              Realized P/L (FIFO)
            </div>
            <div
              className={`mt-1 font-mono text-lg font-bold tabular-nums sm:text-2xl ${
                summary.realized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {summary.realized_pnl >= 0 ? '+' : ''}
              {formatINR(summary.realized_pnl)}
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 font-mono tabular-nums truncate">
              Net: {formatINR(summary.combined_total_pnl)} ({summary.closed_sales_count} sales)
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5">
            <div className="text-[11px] font-medium text-slate-500 sm:text-xs">
              Trailing 1Y Return (r)
            </div>
            <div
              className={`mt-1 font-mono text-lg font-bold tabular-nums sm:text-2xl ${
                summary.trailing_1y_return_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {formatPct(summary.trailing_1y_return_pct, 2)}
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-500 font-mono tabular-nums">
              <button
                type="button"
                onClick={() => setActiveSection('goals')}
                className="font-medium text-slate-700 underline hover:text-slate-900"
              >
                Open SIP Calculator →
              </button>
            </div>
          </div>
        </section>

        {/* 7 Fixed Lookback Windows Strip: Horizontal Touch Carousel on Mobile, 7-Col Grid on Desktop */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Portfolio P/L% by Lookback Window
              </h2>
              <p className="text-[11px] text-slate-500 sm:text-xs">
                Tap any window to update the period column across your holdings.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setActiveSection(activeSection === 'periods' ? 'all' : 'periods')
              }
              className="shrink-0 text-xs font-medium text-slate-700 underline hover:text-slate-900 whitespace-nowrap"
            >
              {activeSection === 'periods' ? 'Show All' : 'Full Matrix'}
            </button>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-7 lg:overflow-visible">
            {period_windows.map((w) => {
              const isSelected = selectedWindow === w.window_key;
              const isPos = w.pnl_pct >= 0;
              return (
                <button
                  key={w.window_key}
                  type="button"
                  onClick={() => setSelectedWindow(w.window_key)}
                  className={`flex min-w-[108px] shrink-0 flex-col justify-between rounded-xl border p-3 text-left transition-colors lg:min-w-0 ${
                    isSelected
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-slate-50/70 hover:border-slate-300 hover:bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">{w.window_key}</span>
                    <span
                      className={`font-mono text-[10px] ${
                        isSelected ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {w.start_date.slice(2)}
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono tabular-nums">
                    <div
                      className={`text-sm font-bold sm:text-base ${
                        isSelected
                          ? isPos
                            ? 'text-emerald-300'
                            : 'text-rose-300'
                          : isPos
                          ? 'text-emerald-700'
                          : 'text-rose-700'
                      }`}
                    >
                      {formatPct(w.pnl_pct, 2)}
                    </div>
                    <div
                      className={`text-[10px] sm:text-[11px] ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {w.pnl_amount >= 0 ? '+' : ''}
                      {formatINR(w.pnl_amount)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* SECTION 1: HOLDINGS & FIFO LOTS (Mobile Cards + Desktop Table) */}
        {(activeSection === 'all' || activeSection === 'holdings') && (
          <section className="rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-col justify-between gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:px-6">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Open Holdings ({filteredHoldings.length})
                </h2>
                <p className="text-xs text-slate-500">
                  Multiple buys roll up per instrument; tap any holding to inspect open FIFO lots.
                </p>
              </div>

              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setInstrumentFilter('all')}
                    className={`min-h-[38px] rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      instrumentFilter === 'all'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All ({holdings.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstrumentFilter('stock')}
                    className={`min-h-[38px] rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      instrumentFilter === 'stock'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Stocks
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstrumentFilter('mutual_fund')}
                    className={`min-h-[38px] rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      instrumentFilter === 'mutual_fund'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Mutual Funds
                  </button>
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter holdings..."
                    className="min-h-[40px] w-full rounded-xl border border-slate-300 py-1.5 pr-3 pl-9 text-xs text-slate-900 focus:border-slate-900 focus:outline-hidden sm:w-44"
                  />
                </div>
              </div>
            </div>

            {/* MOBILE VIEW: Touch-Friendly Holding Cards */}
            <div className="divide-y divide-slate-200 lg:hidden">
              {filteredHoldings.map((h) => {
                const isExpanded = !!expandedSymbols[h.symbol];
                const winMetric = h.period_pnl[selectedWindow];
                return (
                  <div key={h.symbol} className="p-4">
                    <div
                      onClick={() => toggleExpandSymbol(h.symbol)}
                      className="flex cursor-pointer items-start justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm text-slate-900 leading-snug">
                          {h.name}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500">
                          <span>{h.symbol}</span>
                          <span>·</span>
                          <span>
                            {h.instrument_type === 'stock' ? h.exchange : 'AMFI MF'}
                          </span>
                          <span>·</span>
                          <span>{h.lots.length} lot(s)</span>
                        </div>
                      </div>

                      <div className="shrink-0 text-right font-mono tabular-nums">
                        <div className="text-sm font-bold text-slate-900">
                          {formatINR(h.current_value)}
                        </div>
                        <div
                          className={`text-xs font-semibold ${
                            h.unrealized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {h.unrealized_pnl >= 0 ? '+' : ''}
                          {formatINR(h.unrealized_pnl)} ({formatPct(h.unrealized_pnl_pct, 1)})
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-2.5 font-mono text-xs tabular-nums sm:grid-cols-4">
                      <div>
                        <div className="font-sans text-[10px] text-slate-500">
                          Open Qty · Avg Buy
                        </div>
                        <div className="mt-0.5 font-medium text-slate-900">
                          {formatNumberIN(
                            h.total_open_quantity,
                            h.instrument_type === 'mutual_fund' ? 2 : 0
                          )}{' '}
                          @ {formatINR(h.avg_buy_price, 1)}
                        </div>
                      </div>

                      <div>
                        <div className="font-sans text-[10px] text-slate-500">
                          Latest Price / NAV
                        </div>
                        <div className="mt-0.5 font-medium text-slate-900">
                          {formatINR(
                            h.latest_price,
                            h.instrument_type === 'mutual_fund' ? 2 : 1
                          )}{' '}
                          <span
                            className={
                              h.day_change_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }
                          >
                            ({formatPct(h.day_change_pct, 1)})
                          </span>
                        </div>
                      </div>

                      <div>
                        <div className="font-sans text-[10px] text-slate-500">
                          Invested Value
                        </div>
                        <div className="mt-0.5 font-medium text-slate-900">
                          {formatINR(h.invested_value)}
                        </div>
                      </div>

                      <div>
                        <div className="font-sans text-[10px] text-slate-500">
                          {activeWindowObj.window_key} Window P/L%
                        </div>
                        <div
                          className={`mt-0.5 font-semibold ${
                            winMetric.pnl_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {formatPct(winMetric.pnl_pct, 2)}{' '}
                          <span className="font-normal text-slate-500">
                            ({formatINR(winMetric.pnl_amount)})
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => toggleExpandSymbol(h.symbol)}
                        className="flex min-h-[42px] items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        <span>Lots ({h.lots.length})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setModalInitialSymbol(h.symbol);
                          setModalInitialTxType('buy');
                          setIsTxModalOpen(true);
                        }}
                        className="flex min-h-[42px] items-center justify-center rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
                      >
                        + Buy More
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setModalInitialSymbol(h.symbol);
                          setModalInitialTxType('sell');
                          setIsTxModalOpen(true);
                        }}
                        className="flex min-h-[42px] items-center justify-center rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
                      >
                        Sell (FIFO)
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="text-[11px] font-semibold text-slate-700">
                          Open FIFO Buy Lots (Oldest Matched First on Sale)
                        </div>
                        {h.lots.map((lot) => (
                          <div
                            key={lot.lot_id}
                            className="rounded-lg border border-slate-200 bg-white p-2.5 font-mono text-xs tabular-nums"
                          >
                            <div className="flex items-center justify-between text-[11px] text-slate-500">
                              <span>Purchased: {lot.buy_date}</span>
                              <span>ID: {lot.lot_id}</span>
                            </div>
                            <div className="mt-1.5 flex items-center justify-between">
                              <div>
                                <span className="font-semibold text-slate-900">
                                  {formatNumberIN(
                                    lot.open_quantity,
                                    h.instrument_type === 'mutual_fund' ? 3 : 0
                                  )}{' '}
                                  open
                                </span>{' '}
                                <span className="text-slate-500">
                                  @ {formatINR(lot.buy_price, 2)}
                                </span>
                              </div>
                              <div
                                className={`font-semibold ${
                                  lot.unrealized_pnl >= 0
                                    ? 'text-emerald-700'
                                    : 'text-rose-700'
                                }`}
                              >
                                {lot.unrealized_pnl >= 0 ? '+' : ''}
                                {formatINR(lot.unrealized_pnl)} (
                                {formatPct(lot.unrealized_pnl_pct, 1)})
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* DESKTOP VIEW: Full Institutional Table */}
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-slate-500">
                    <th className="py-3 pr-2 pl-6 font-medium">Instrument</th>
                    <th className="px-3 py-3 text-right font-medium">Open Qty / Units</th>
                    <th className="px-3 py-3 text-right font-medium">Avg Buy Price</th>
                    <th className="px-3 py-3 text-right font-medium">Latest Price / NAV</th>
                    <th className="px-3 py-3 text-right font-medium">Invested Value</th>
                    <th className="px-3 py-3 text-right font-medium">Current Value</th>
                    <th className="px-3 py-3 text-right font-medium">Unrealized P/L</th>
                    <th className="px-3 py-3 text-right font-medium">
                      {activeWindowObj.window_key} P/L%
                    </th>
                    <th className="py-3 pr-6 pl-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredHoldings.map((h) => {
                    const isExpanded = !!expandedSymbols[h.symbol];
                    const winMetric = h.period_pnl[selectedWindow];
                    return (
                      <React.Fragment key={h.symbol}>
                        <tr
                          onClick={() => toggleExpandSymbol(h.symbol)}
                          className="cursor-pointer transition-colors hover:bg-slate-50"
                        >
                          <td className="py-3.5 pr-2 pl-6">
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 text-slate-400">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </span>
                              <div>
                                <div className="font-semibold text-slate-900">{h.name}</div>
                                <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                                  <span>{h.symbol}</span>
                                  <span aria-hidden="true">·</span>
                                  <span>
                                    {h.instrument_type === 'stock'
                                      ? `Stock (${h.exchange})`
                                      : 'Mutual Fund (AMFI)'}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>{h.lots.length} open lot(s)</span>
                                  {h.realized_pnl !== 0 && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="text-emerald-700">
                                        Realized: +{formatINR(h.realized_pnl)}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-slate-900 tabular-nums">
                            {formatNumberIN(
                              h.total_open_quantity,
                              h.instrument_type === 'mutual_fund' ? 3 : 0
                            )}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-slate-700 tabular-nums">
                            {formatINR(h.avg_buy_price, 2)}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono tabular-nums">
                            <div className="font-semibold text-slate-900">
                              {formatINR(
                                h.latest_price,
                                h.instrument_type === 'mutual_fund' ? 4 : 2
                              )}
                            </div>
                            <div
                              className={`text-[11px] ${
                                h.day_change_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              {formatPct(h.day_change_pct, 2)} 1D
                            </div>
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono text-slate-700 tabular-nums">
                            {formatINR(h.invested_value)}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono font-semibold text-slate-900 tabular-nums">
                            {formatINR(h.current_value)}
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono tabular-nums">
                            <div
                              className={`font-semibold ${
                                h.unrealized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              {h.unrealized_pnl >= 0 ? '+' : ''}
                              {formatINR(h.unrealized_pnl)}
                            </div>
                            <div
                              className={`text-[11px] ${
                                h.unrealized_pnl_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              {formatPct(h.unrealized_pnl_pct, 2)}
                            </div>
                          </td>
                          <td className="px-3 py-3.5 text-right font-mono tabular-nums">
                            <div
                              className={`font-semibold ${
                                winMetric.pnl_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                              }`}
                            >
                              {formatPct(winMetric.pnl_pct, 2)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {winMetric.pnl_amount >= 0 ? '+' : ''}
                              {formatINR(winMetric.pnl_amount)}
                              {winMetric.used_buy_date_basis && selectedWindow !== 'OVERALL'
                                ? ' *'
                                : ''}
                            </div>
                          </td>
                          <td
                            className="py-3.5 pr-6 pl-3 text-right"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setModalInitialSymbol(h.symbol);
                                  setModalInitialTxType('buy');
                                  setIsTxModalOpen(true);
                                }}
                                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                              >
                                + Buy
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setModalInitialSymbol(h.symbol);
                                  setModalInitialTxType('sell');
                                  setIsTxModalOpen(true);
                                }}
                                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                              >
                                Sell
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-slate-50/90">
                            <td colSpan={9} className="px-10 py-3">
                              <div className="rounded-lg border border-slate-200 bg-white p-3">
                                <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
                                  <span className="font-semibold text-slate-700">
                                    Open Buy Lots for {h.name} (FIFO Order — Oldest First)
                                  </span>
                                  {h.high_52w && h.low_52w && (
                                    <span className="font-mono">
                                      52W Range: {formatINR(h.low_52w, 2)} –{' '}
                                      {formatINR(h.high_52w, 2)}
                                    </span>
                                  )}
                                </div>
                                <table className="w-full text-left font-mono text-[11px] tabular-nums">
                                  <thead>
                                    <tr className="border-b border-slate-100 text-slate-400">
                                      <th className="py-1.5 font-medium">Lot ID</th>
                                      <th className="py-1.5 font-medium">Buy Date</th>
                                      <th className="py-1.5 text-right font-medium">Original Qty</th>
                                      <th className="py-1.5 text-right font-medium">Open Qty</th>
                                      <th className="py-1.5 text-right font-medium">Buy Price</th>
                                      <th className="py-1.5 text-right font-medium">
                                        Invested Basis
                                      </th>
                                      <th className="py-1.5 text-right font-medium">
                                        Current Value
                                      </th>
                                      <th className="py-1.5 text-right font-medium">
                                        Lot Unrealized P/L
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100">
                                    {h.lots.map((lot) => (
                                      <tr key={lot.lot_id}>
                                        <td className="py-1.5 text-slate-500">{lot.lot_id}</td>
                                        <td className="py-1.5 text-slate-900">{lot.buy_date}</td>
                                        <td className="py-1.5 text-right text-slate-500">
                                          {formatNumberIN(
                                            lot.original_quantity,
                                            h.instrument_type === 'mutual_fund' ? 3 : 0
                                          )}
                                        </td>
                                        <td className="py-1.5 text-right font-semibold text-slate-900">
                                          {formatNumberIN(
                                            lot.open_quantity,
                                            h.instrument_type === 'mutual_fund' ? 3 : 0
                                          )}
                                        </td>
                                        <td className="py-1.5 text-right text-slate-700">
                                          {formatINR(lot.buy_price, 2)}
                                        </td>
                                        <td className="py-1.5 text-right text-slate-700">
                                          {formatINR(lot.invested_value)}
                                        </td>
                                        <td className="py-1.5 text-right font-semibold text-slate-900">
                                          {formatINR(lot.current_value)}
                                        </td>
                                        <td
                                          className={`py-1.5 text-right font-semibold ${
                                            lot.unrealized_pnl >= 0
                                              ? 'text-emerald-700'
                                              : 'text-rose-700'
                                          }`}
                                        >
                                          {lot.unrealized_pnl >= 0 ? '+' : ''}
                                          {formatINR(lot.unrealized_pnl)} (
                                          {formatPct(lot.unrealized_pnl_pct, 2)})
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* SECTION 2: COMPLETE PER-INSTRUMENT PERIOD P/L% MATRIX */}
        {(activeSection === 'all' || activeSection === 'periods') && (
          <section className="rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-4 sm:px-6">
              <h2 className="text-base font-semibold text-slate-900">
                Blended vs. Per-Instrument P/L% Breakdown (All 7 Windows)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Entries with <span className="font-mono">*</span> include lots purchased more
                recently than the window start date (valued at their own buy-date cost basis).
              </p>
            </div>

            <div className="divide-y divide-slate-200 lg:hidden">
              {holdings.map((h) => (
                <div key={h.symbol} className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{h.name}</div>
                      <div className="font-mono text-[11px] text-slate-500">
                        {h.symbol} · 1st Buy: {h.first_buy_date}
                      </div>
                    </div>
                    <div className="font-mono text-sm font-bold text-slate-900">
                      {formatINR(h.current_value)}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-7">
                    {(['7D', '30D', '3M', '6M', '1Y', '5Y', 'OVERALL'] as WindowKey[]).map((wk) => {
                      const cell = h.period_pnl[wk];
                      return (
                        <div
                          key={wk}
                          className="rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono tabular-nums"
                        >
                          <div className="text-[10px] font-semibold text-slate-500">{wk}</div>
                          <div
                            className={`mt-0.5 text-xs font-bold ${
                              cell.pnl_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {formatPct(cell.pnl_pct, 1)}
                            {cell.used_buy_date_basis && wk !== 'OVERALL' ? '*' : ''}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                    <th className="py-3 pr-3 pl-6 font-medium">Instrument / Portfolio</th>
                    <th className="px-3 py-3 text-right font-medium">Current Value</th>
                    <th className="px-3 py-3 text-right font-medium">7 Days</th>
                    <th className="px-3 py-3 text-right font-medium">30 Days</th>
                    <th className="px-3 py-3 text-right font-medium">3 Months</th>
                    <th className="px-3 py-3 text-right font-medium">6 Months</th>
                    <th className="px-3 py-3 text-right font-medium">1 Year</th>
                    <th className="px-3 py-3 text-right font-medium">5 Years</th>
                    <th className="py-3 pr-6 pl-3 text-right font-medium">Overall</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono tabular-nums">
                  <tr className="bg-slate-900 text-white font-semibold">
                    <td className="py-3.5 pr-3 pl-6 font-sans">
                      Blended Portfolio Total ({holdings.length} Holdings)
                    </td>
                    <td className="px-3 py-3.5 text-right">
                      {formatINR(summary.total_current_value)}
                    </td>
                    {(['7D', '30D', '3M', '6M', '1Y', '5Y', 'OVERALL'] as WindowKey[]).map(
                      (wk) => {
                        const w = period_windows.find((item) => item.window_key === wk);
                        const pct = w?.pnl_pct || 0;
                        return (
                          <td
                            key={wk}
                            className={`px-3 py-3.5 text-right ${
                              pct >= 0 ? 'text-emerald-300' : 'text-rose-300'
                            }`}
                          >
                            <div>{formatPct(pct, 2)}</div>
                            <div className="text-[10px] font-normal text-slate-300">
                              {formatINR(w?.pnl_amount || 0)}
                            </div>
                          </td>
                        );
                      }
                    )}
                  </tr>

                  {holdings.map((h) => (
                    <tr key={h.symbol} className="hover:bg-slate-50">
                      <td className="py-3.5 pr-3 pl-6 font-sans">
                        <div className="font-semibold text-slate-900">{h.name}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {h.symbol} · 1st Buy: {h.first_buy_date}
                        </div>
                      </td>
                      <td className="px-3 py-3.5 text-right font-semibold text-slate-900">
                        {formatINR(h.current_value)}
                      </td>
                      {(['7D', '30D', '3M', '6M', '1Y', '5Y', 'OVERALL'] as WindowKey[]).map(
                        (wk) => {
                          const cell = h.period_pnl[wk];
                          return (
                            <td key={wk} className="px-3 py-3.5 text-right">
                              <div
                                className={`font-semibold ${
                                  cell.pnl_pct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                                }`}
                              >
                                {formatPct(cell.pnl_pct, 2)}
                                {cell.used_buy_date_basis && wk !== 'OVERALL' ? '*' : ''}
                              </div>
                              <div className="text-[10px] text-slate-500">
                                {cell.pnl_amount >= 0 ? '+' : ''}
                                {formatINR(cell.pnl_amount)}
                              </div>
                            </td>
                          );
                        }
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* SECTION 3: GOAL MODE A / MODE B & MONTHLY RECALCULATION DRIFT */}
        {(activeSection === 'all' || activeSection === 'goals') && (
          <div id="goals-section">
            <GoalsSection
              goals={goals}
              recalcHistory={goal_recalc_history}
              trailing1YReturnPct={summary.trailing_1y_return_pct}
              referenceDate={summary.reference_date}
              portfolioCurrentValue={summary.total_current_value}
              onCreateGoal={handleCreateGoal}
              onDeleteGoal={handleDeleteGoal}
              onRunMonthlyRecalc={handleRunMonthlyRecalc}
            />
          </div>
        )}

        {/* SECTION 4: REALIZED FIFO SALES LEDGER, ALL TRANSACTIONS & DAILY SNAPSHOT HISTORY */}
        {(activeSection === 'all' || activeSection === 'history') && (
          <div className="space-y-6 sm:space-y-8">
            <section className="rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-4 sm:px-6">
                <h2 className="text-base font-semibold text-slate-900">
                  Realized P/L History (Closed & Partial FIFO Sales)
                </h2>
                <p className="text-xs text-slate-500">
                  Formula: <span className="font-mono">(sell_price − buy_price of matched lot) × quantity_sold</span>.
                </p>
              </div>

              <div className="divide-y divide-slate-200 lg:hidden">
                {realized_sales.map((s, idx) => (
                  <div key={`${s.sale_id}-${idx}`} className="p-4 font-mono text-xs tabular-nums">
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-sans">
                        <div className="font-semibold text-slate-900">{s.name}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          Sold {s.sell_date} · Matched {s.matched_lot_id} ({s.buy_date})
                        </div>
                      </div>
                      <div
                        className={`text-right font-semibold ${
                          s.realized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        <div>
                          {s.realized_pnl >= 0 ? '+' : ''}
                          {formatINR(s.realized_pnl)}
                        </div>
                        <div className="text-[11px]">{formatPct(s.realized_pnl_pct, 2)}</div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-600">
                      <span>
                        Qty: {formatNumberIN(s.quantity_sold, 2)} (Buy {formatINR(s.buy_price, 1)} →
                        Sell {formatINR(s.sell_price, 1)})
                      </span>
                      <span>Proceeds: {formatINR(s.proceeds)}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <th className="py-3 pl-6 font-medium">Sell Date</th>
                      <th className="px-3 py-3 font-medium">Instrument</th>
                      <th className="px-3 py-3 font-medium">Matched Buy Lot</th>
                      <th className="px-3 py-3 text-right font-medium">Qty Sold</th>
                      <th className="px-3 py-3 text-right font-medium">Lot Buy Price</th>
                      <th className="px-3 py-3 text-right font-medium">Sell Price</th>
                      <th className="px-3 py-3 text-right font-medium">Sale Proceeds</th>
                      <th className="py-3 pr-6 pl-3 text-right font-medium">Realized P/L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono tabular-nums">
                    {realized_sales.map((s, idx) => (
                      <tr key={`${s.sale_id}-${idx}`} className="hover:bg-slate-50">
                        <td className="py-3 pl-6 text-slate-900">{s.sell_date}</td>
                        <td className="px-3 py-3 font-sans">
                          <span className="font-semibold text-slate-900">{s.name}</span>{' '}
                          <span className="font-mono text-slate-500">({s.symbol})</span>
                        </td>
                        <td className="px-3 py-3 text-slate-600">
                          {s.matched_lot_id} (Bought {s.buy_date})
                        </td>
                        <td className="px-3 py-3 text-right text-slate-900">
                          {formatNumberIN(s.quantity_sold, 3)}
                        </td>
                        <td className="px-3 py-3 text-right text-slate-600">
                          {formatINR(s.buy_price, 2)}
                        </td>
                        <td className="px-3 py-3 text-right text-slate-900">
                          {formatINR(s.sell_price, 2)}
                        </td>
                        <td className="px-3 py-3 text-right text-slate-900">
                          {formatINR(s.proceeds)}
                        </td>
                        <td
                          className={`py-3 pr-6 pl-3 text-right font-semibold ${
                            s.realized_pnl >= 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {s.realized_pnl >= 0 ? '+' : ''}
                          {formatINR(s.realized_pnl)} ({formatPct(s.realized_pnl_pct, 2)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section className="rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 p-4 sm:px-6">
                  <h3 className="text-base font-semibold text-slate-900">
                    Daily Snapshot History (`snapshots`)
                  </h3>
                  <p className="text-xs text-slate-500">
                    Stored daily in Firestore and used for period lookback P/L%.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 font-sans text-slate-500">
                        <th className="py-2.5 pl-4 sm:pl-6 font-medium">Date</th>
                        <th className="px-3 py-2.5 text-right font-medium">Symbols</th>
                        <th className="py-2.5 pr-4 sm:pr-6 text-right font-medium">
                          Total Value
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {[...price_snapshots].reverse().map((snap) => (
                        <tr key={snap.date} className="hover:bg-slate-50">
                          <td className="py-2.5 pl-4 sm:pl-6 text-slate-900">{snap.date}</td>
                          <td className="px-3 py-2.5 text-right text-slate-600">
                            {Object.keys(snap.prices).length}
                          </td>
                          <td className="py-2.5 pr-4 sm:pr-6 text-right font-semibold text-slate-900">
                            {formatINR(snap.portfolio_total_value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 p-4 sm:px-6">
                  <h3 className="text-base font-semibold text-slate-900">
                    All Transactions ({transactions.length})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Raw buy & sell records stored in Firestore driving FIFO calculations.
                  </p>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-left text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 font-sans text-slate-500">
                        <th className="py-2.5 pl-4 sm:pl-6 font-medium">Date</th>
                        <th className="px-2 py-2.5 font-medium">Type</th>
                        <th className="px-2 py-2.5 font-medium">Symbol</th>
                        <th className="px-2 py-2.5 text-right font-medium">Qty</th>
                        <th className="px-2 py-2.5 text-right font-medium">Price</th>
                        <th className="py-2.5 pr-4 sm:pr-6 text-right font-medium">Del</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {transactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-50">
                          <td className="py-2.5 pl-4 sm:pl-6 text-slate-900">{tx.date}</td>
                          <td
                            className={`px-2 py-2.5 font-semibold uppercase ${
                              tx.transaction_type === 'buy'
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                            }`}
                          >
                            {tx.transaction_type}
                          </td>
                          <td className="px-2 py-2.5 text-slate-900">{tx.symbol}</td>
                          <td className="px-2 py-2.5 text-right text-slate-700">
                            {formatNumberIN(tx.quantity, 2)}
                          </td>
                          <td className="px-2 py-2.5 text-right text-slate-900">
                            {formatINR(tx.price, 1)}
                          </td>
                          <td className="py-2.5 pr-4 sm:pr-6 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteTransaction(tx.id)}
                              className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center text-slate-400 hover:text-rose-600"
                              title="Delete transaction"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Thumb-Zone Navigation Bar on Mobile (< md) */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="fixed right-0 bottom-0 left-0 z-40 grid h-16 grid-cols-5 items-center border-t border-slate-200 bg-white/95 px-1 backdrop-blur-md md:hidden"
      >
        <button
          type="button"
          onClick={() => {
            setActiveSection('all');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className={`flex min-h-[48px] flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'all' ? 'text-slate-900 font-semibold' : 'text-slate-500'
          }`}
        >
          <LayoutGrid className="h-5 w-5" />
          <span className="mt-0.5 text-[10px] tracking-tight">Overview</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('holdings');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className={`flex min-h-[48px] flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'holdings' ? 'text-slate-900 font-semibold' : 'text-slate-500'
          }`}
        >
          <Briefcase className="h-5 w-5" />
          <span className="mt-0.5 text-[10px] tracking-tight">Holdings</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('goals');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className={`flex min-h-[48px] flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'goals' ? 'text-emerald-700 font-semibold' : 'text-slate-500'
          }`}
        >
          <Target className="h-5 w-5" />
          <span className="mt-0.5 text-[10px] tracking-tight">Goals & SIP</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('periods');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className={`flex min-h-[48px] flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'periods' ? 'text-slate-900 font-semibold' : 'text-slate-500'
          }`}
        >
          <BarChart3 className="h-5 w-5" />
          <span className="mt-0.5 text-[10px] tracking-tight">7-Window</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveSection('history');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className={`flex min-h-[48px] flex-col items-center justify-center rounded-xl transition-colors ${
            activeSection === 'history' ? 'text-slate-900 font-semibold' : 'text-slate-500'
          }`}
        >
          <History className="h-5 w-5" />
          <span className="mt-0.5 text-[10px] tracking-tight">History</span>
        </button>
      </nav>

      {/* Buy / Sell Transaction Modal */}
      <TransactionModal
        isOpen={isTxModalOpen}
        onClose={() => setIsTxModalOpen(false)}
        onSubmit={handleAddTransaction}
        holdings={holdings}
        initialSymbol={modalInitialSymbol}
        initialTxType={modalInitialTxType}
      />
    </div>
  );
}
