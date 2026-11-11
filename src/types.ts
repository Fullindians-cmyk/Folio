export type InstrumentType = 'stock' | 'mutual_fund';
export type TransactionType = 'buy' | 'sell';
export type ExchangeType = 'NSE' | 'BSE' | 'N/A';
export type WindowKey = '7D' | '30D' | '3M' | '6M' | '1Y' | '5Y' | 'OVERALL';

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

export interface PeriodWindowMetric {
  window_key: WindowKey;
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
  period_pnl: Record<
    WindowKey,
    {
      value_at_start: number;
      value_now: number;
      pnl_amount: number;
      pnl_pct: number;
      used_buy_date_basis: boolean;
    }
  >;
}

export interface TransactionRecord {
  id: string;
  instrument_type: InstrumentType;
  transaction_type: TransactionType;
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  date: string;
  exchange: ExchangeType;
  target_lot_id?: string;
}

export interface DailyInstrumentSnapshot {
  date: string;
  prices: Record<string, number>;
  portfolio_total_value: number;
  timestamp: string;
}

export interface GoalRecalcEntry {
  id: string;
  goal_id: string;
  recalc_date: string;
  trailing_1y_return_pct: number;
  accumulated_amount: number;
  adjusted_monthly_sip?: number;
  adjusted_target_date?: string;
  adjusted_months_remaining?: number;
  note?: string;
}

export interface GoalRecord {
  id: string;
  name: string;
  mode: 'A' | 'B';
  target_amount: number;
  accumulated_amount: number;
  created_date: string;
  target_date?: string;
  initial_required_sip?: number;
  current_required_sip?: number;
  monthly_sip?: number;
  initial_target_date?: string;
  current_target_date?: string;
  current_months_to_target?: number | null;
  last_trailing_1y_return_pct: number;
}

export interface PortfolioDataResponse {
  summary: {
    reference_date: string;
    total_invested: number;
    total_current_value: number;
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    realized_pnl: number;
    combined_total_pnl: number;
    day_change_amount: number;
    trailing_1y_return_pct: number;
    open_holdings_count: number;
    open_lots_count: number;
    closed_sales_count: number;
    last_daily_job_run: string;
    last_monthly_recalc_run: string;
  };
  period_windows: PeriodWindowMetric[];
  holdings: InstrumentRollup[];
  realized_sales: RealizedSaleRecord[];
  transactions: TransactionRecord[];
  price_snapshots: DailyInstrumentSnapshot[];
  goals: GoalRecord[];
  goal_recalc_history: GoalRecalcEntry[];
}

export interface LookupResult {
  symbol: string;
  name: string;
  instrument_type: InstrumentType;
  exchange: ExchangeType;
  fallback_price?: number;
}
