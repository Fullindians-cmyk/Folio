import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  DailyInstrumentSnapshot,
  ExchangeType,
  GoalRecalcEntry,
  GoalRecord,
  InstrumentRollup,
  InstrumentType,
  OpenLot,
  PeriodWindowMetric,
  PortfolioDataResponse,
  RealizedSaleRecord,
  TransactionRecord,
  TransactionType,
  WindowKey
} from '../types';
import {
  calculateModeASip,
  calculateModeBMonths,
  monthsBetween
} from '../utils/financeMath';

export interface FirestoreInstrumentDoc {
  symbol: string;
  ownerId: string;
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

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 120);
}

// FIFO Engine & Analytics Builder for Firestore documents
export function computePortfolioLotsAndPnlClient(
  transactions: TransactionRecord[],
  instruments: Record<string, FirestoreInstrumentDoc>,
  asOfDate?: string,
  priceOverrides?: Record<string, number>
) {
  const sortedTx = [...transactions]
    .filter((tx) => !asOfDate || tx.date <= asOfDate)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.transaction_type !== b.transaction_type) {
        return a.transaction_type === 'buy' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });

  const openLotsMap = new Map<string, OpenLot[]>();
  const realizedSales: RealizedSaleRecord[] = [];

  for (const tx of sortedTx) {
    const sym = tx.symbol;
    if (!openLotsMap.has(sym)) {
      openLotsMap.set(sym, []);
    }
    const symbolLots = openLotsMap.get(sym)!;

    if (tx.transaction_type === 'buy') {
      const latestPrice =
        priceOverrides?.[sym] ?? instruments[sym]?.latest_price ?? tx.price;
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

  return { openLots: allOpenLots, realizedSales };
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

export function buildPortfolioAnalyticsFromFirestore(
  transactions: TransactionRecord[],
  instruments: Record<string, FirestoreInstrumentDoc>,
  price_snapshots: DailyInstrumentSnapshot[],
  goals: GoalRecord[],
  goal_recalc_history: GoalRecalcEntry[]
): PortfolioDataResponse {
  const sortedSnapshots = [...price_snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const todayStr =
    sortedSnapshots.length > 0
      ? sortedSnapshots[sortedSnapshots.length - 1].date
      : new Date().toISOString().slice(0, 10);

  const { openLots, realizedSales } = computePortfolioLotsAndPnlClient(
    transactions,
    instruments
  );

  const windowsConfig: Array<{
    key: '7D' | '30D' | '3M' | '6M' | '1Y' | '5Y';
    label: string;
    days: number;
  }> = [
    { key: '7D', label: '7 Days', days: 7 },
    { key: '30D', label: '30 Days', days: 30 },
    { key: '3M', label: '3 Months', days: 91 },
    { key: '6M', label: '6 Months', days: 182 },
    { key: '1Y', label: '1 Year', days: 365 },
    { key: '5Y', label: '5 Years', days: 1825 }
  ];

  const symbolToLots = new Map<string, OpenLot[]>();
  for (const lot of openLots) {
    if (!symbolToLots.has(lot.symbol)) {
      symbolToLots.set(lot.symbol, []);
    }
    symbolToLots.get(lot.symbol)!.push(lot);
  }

  const symbolRealizedMap = new Map<string, number>();
  for (const sale of realizedSales) {
    symbolRealizedMap.set(
      sale.symbol,
      (symbolRealizedMap.get(sale.symbol) || 0) + sale.realized_pnl
    );
  }

  const instrumentRollups: InstrumentRollup[] = [];

  for (const [symbol, lots] of symbolToLots.entries()) {
    const info = instruments[symbol];
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
    const firstBuyDate = lots.reduce(
      (min, l) => (l.buy_date < min ? l.buy_date : min),
      lots[0].buy_date
    );

    const periodPnlMap = {} as InstrumentRollup['period_pnl'];

    for (const w of windowsConfig) {
      const windowStartDate = getTargetWindowDate(todayStr, w.days);
      const snap = findClosestSnapshotOnOrBefore(sortedSnapshots, windowStartDate);

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

  const portfolioPeriodWindows: PeriodWindowMetric[] = windowsConfig.map((w) => {
    const targetDate = getTargetWindowDate(todayStr, w.days);
    const snap = findClosestSnapshotOnOrBefore(sortedSnapshots, targetDate);
    const startVal = instrumentRollups.reduce(
      (s, inst) => s + inst.period_pnl[w.key].value_at_start,
      0
    );
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
  const totalUnrealizedPnlPct =
    totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0;
  const totalRealizedPnl = realizedSales.reduce((s, r) => s + r.realized_pnl, 0);
  const totalDayChange = instrumentRollups.reduce((s, i) => s + i.day_change_amount, 0);

  portfolioPeriodWindows.push({
    window_key: 'OVERALL',
    label: 'Overall (Since 1st Buy)',
    start_date:
      transactions.length > 0
        ? transactions.reduce((min, t) => (t.date < min ? t.date : min), todayStr)
        : todayStr,
    value_at_start: Number(totalInvested.toFixed(2)),
    value_now: Number(totalCurrentValue.toFixed(2)),
    pnl_amount: Number(totalUnrealizedPnl.toFixed(2)),
    pnl_pct: Number(totalUnrealizedPnlPct.toFixed(2))
  });

  const trailing1YWindow = portfolioPeriodWindows.find((w) => w.window_key === '1Y');
  const trailing1YReturnPct = trailing1YWindow
    ? trailing1YWindow.pnl_pct
    : totalUnrealizedPnlPct;

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
      last_daily_job_run: new Date().toISOString(),
      last_monthly_recalc_run: new Date().toISOString()
    },
    period_windows: portfolioPeriodWindows,
    holdings: instrumentRollups,
    realized_sales: realizedSales,
    transactions: [...transactions].sort((a, b) => b.date.localeCompare(a.date)),
    price_snapshots: sortedSnapshots,
    goals,
    goal_recalc_history
  };
}

/**
 * Seeds the user's Firestore collections from the initial portfolio state if the user
 * has no transactions in Firestore yet.
 */
export async function seedUserFirestoreIfEmpty(
  uid: string,
  initialData: PortfolioDataResponse
): Promise<void> {
  const txQuery = query(collection(db, 'transactions'), where('ownerId', '==', uid));
  let existingTxSnap;
  try {
    existingTxSnap = await getDocs(txQuery);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'transactions');
    return;
  }

  if (!existingTxSnap || !existingTxSnap.empty) {
    return; // Already seeded
  }

  try {
    const batch = writeBatch(db);
    const ts = serverTimestamp();

    // 1. Seed transactions
    for (const tx of initialData.transactions) {
      const docId = sanitizeId(`${uid}_${tx.id}`);
      const txPayload: Record<string, unknown> = {
        id: tx.id.slice(0, 64),
        ownerId: uid,
        instrument_type: tx.instrument_type,
        transaction_type: tx.transaction_type,
        symbol: tx.symbol.slice(0, 32),
        name: tx.name.slice(0, 160),
        quantity: Number(tx.quantity),
        price: Number(tx.price),
        date: tx.date.slice(0, 16),
        exchange: tx.exchange,
        createdAt: ts,
        updatedAt: ts
      };
      if (tx.target_lot_id) {
        txPayload.target_lot_id = tx.target_lot_id.slice(0, 64);
      }
      batch.set(doc(db, 'transactions', docId), txPayload);
    }

    // 2. Seed instruments from holdings
    for (const h of initialData.holdings) {
      const docId = sanitizeId(`${uid}_${h.symbol}`);
      const instPayload: Record<string, unknown> = {
        symbol: h.symbol.slice(0, 32),
        ownerId: uid,
        instrument_type: h.instrument_type,
        name: h.name.slice(0, 160),
        exchange: h.exchange,
        latest_price: Number(h.latest_price),
        previous_close: Number(h.previous_close),
        last_updated: new Date().toISOString().slice(0, 40),
        source:
          h.price_source === 'yahoo_live' || h.price_source === 'mfapi_live'
            ? h.price_source
            : 'cached_fallback',
        createdAt: ts,
        updatedAt: ts
      };
      if (typeof h.high_52w === 'number') instPayload.high_52w = h.high_52w;
      if (typeof h.low_52w === 'number') instPayload.low_52w = h.low_52w;
      batch.set(doc(db, 'instruments', docId), instPayload);
    }

    // 3. Seed daily snapshots
    for (const snap of initialData.price_snapshots) {
      const docId = sanitizeId(`${uid}_${snap.date}`);
      batch.set(doc(db, 'snapshots', docId), {
        date: snap.date.slice(0, 16),
        ownerId: uid,
        prices: snap.prices,
        portfolio_total_value: Number(snap.portfolio_total_value),
        timestamp: snap.timestamp.slice(0, 40),
        createdAt: ts,
        updatedAt: ts
      });
    }

    // 4. Seed goals (Use user-scoped goal IDs so goal_recalcs existsAfter check succeeds)
    for (const g of initialData.goals) {
      const scopedGoalId = sanitizeId(`${uid.slice(0, 12)}-${g.id}`).replace(/\./g, '-');
      const goalPayload: Record<string, unknown> = {
        id: scopedGoalId,
        ownerId: uid,
        name: g.name.slice(0, 120),
        mode: g.mode,
        target_amount: Number(g.target_amount),
        accumulated_amount: Number(g.accumulated_amount),
        created_date: g.created_date.slice(0, 16),
        last_trailing_1y_return_pct: Number(g.last_trailing_1y_return_pct),
        createdAt: ts,
        updatedAt: ts
      };
      if (g.target_date) goalPayload.target_date = g.target_date.slice(0, 16);
      if (typeof g.initial_required_sip === 'number')
        goalPayload.initial_required_sip = g.initial_required_sip;
      if (typeof g.current_required_sip === 'number')
        goalPayload.current_required_sip = g.current_required_sip;
      if (typeof g.monthly_sip === 'number') goalPayload.monthly_sip = g.monthly_sip;
      if (g.initial_target_date)
        goalPayload.initial_target_date = g.initial_target_date.slice(0, 16);
      if (g.current_target_date)
        goalPayload.current_target_date = g.current_target_date.slice(0, 16);
      if (typeof g.current_months_to_target === 'number')
        goalPayload.current_months_to_target = g.current_months_to_target;

      batch.set(doc(db, 'goals', scopedGoalId), goalPayload);

      // 5. Seed goal_recalcs for this goal
      const matchingRecalcs = initialData.goal_recalc_history.filter(
        (r) => r.goal_id === g.id
      );
      for (const r of matchingRecalcs) {
        const scopedRecalcId = sanitizeId(`${uid.slice(0, 12)}-${r.id}`).replace(/\./g, '-');
        const recalcPayload: Record<string, unknown> = {
          id: scopedRecalcId,
          ownerId: uid,
          goal_id: scopedGoalId,
          recalc_date: r.recalc_date.slice(0, 16),
          trailing_1y_return_pct: Number(r.trailing_1y_return_pct),
          accumulated_amount: Number(r.accumulated_amount),
          createdAt: ts,
          updatedAt: ts
        };
        if (typeof r.adjusted_monthly_sip === 'number')
          recalcPayload.adjusted_monthly_sip = r.adjusted_monthly_sip;
        if (r.adjusted_target_date)
          recalcPayload.adjusted_target_date = r.adjusted_target_date.slice(0, 16);
        if (typeof r.adjusted_months_remaining === 'number')
          recalcPayload.adjusted_months_remaining = r.adjusted_months_remaining;
        if (r.note) recalcPayload.note = r.note.slice(0, 200);

        batch.set(doc(db, 'goal_recalcs', scopedRecalcId), recalcPayload);
      }
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'batch_seed');
  }
}

/**
 * Subscribes to all 5 user collections in Firestore and invokes `onUpdate` whenever
 * any collection changes.
 */
export function subscribeToUserPortfolio(
  uid: string,
  onUpdate: (data: {
    transactions: TransactionRecord[];
    instruments: Record<string, FirestoreInstrumentDoc>;
    snapshots: DailyInstrumentSnapshot[];
    goals: GoalRecord[];
    recalcs: GoalRecalcEntry[];
  }) => void
): () => void {
  let transactions: TransactionRecord[] = [];
  let instruments: Record<string, FirestoreInstrumentDoc> = {};
  let snapshots: DailyInstrumentSnapshot[] = [];
  let goals: GoalRecord[] = [];
  let recalcs: GoalRecalcEntry[] = [];

  const emit = () => {
    onUpdate({ transactions, instruments, snapshots, goals, recalcs });
  };

  const unsubTx = onSnapshot(
    query(collection(db, 'transactions'), where('ownerId', '==', uid)),
    (snap) => {
      transactions = snap.docs.map((d) => d.data() as TransactionRecord);
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'transactions')
  );

  const unsubInst = onSnapshot(
    query(collection(db, 'instruments'), where('ownerId', '==', uid)),
    (snap) => {
      const map: Record<string, FirestoreInstrumentDoc> = {};
      snap.docs.forEach((d) => {
        const data = d.data() as FirestoreInstrumentDoc;
        map[data.symbol] = data;
      });
      instruments = map;
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'instruments')
  );

  const unsubSnaps = onSnapshot(
    query(collection(db, 'snapshots'), where('ownerId', '==', uid)),
    (snap) => {
      snapshots = snap.docs.map((d) => d.data() as DailyInstrumentSnapshot);
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'snapshots')
  );

  const unsubGoals = onSnapshot(
    query(collection(db, 'goals'), where('ownerId', '==', uid)),
    (snap) => {
      goals = snap.docs.map((d) => d.data() as GoalRecord);
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'goals')
  );

  const unsubRecalcs = onSnapshot(
    query(collection(db, 'goal_recalcs'), where('ownerId', '==', uid)),
    (snap) => {
      recalcs = snap.docs.map((d) => d.data() as GoalRecalcEntry);
      emit();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, 'goal_recalcs')
  );

  return () => {
    unsubTx();
    unsubInst();
    unsubSnaps();
    unsubGoals();
    unsubRecalcs();
  };
}

export async function addTransactionToFirestore(
  uid: string,
  payload: {
    instrument_type: InstrumentType;
    transaction_type: TransactionType;
    symbol: string;
    name: string;
    quantity: number;
    price: number;
    date: string;
    exchange: ExchangeType;
    target_lot_id?: string;
  },
  existingInstruments: Record<string, FirestoreInstrumentDoc>
): Promise<void> {
  const txId = `tx-${Date.now()}`;
  const docId = sanitizeId(`${uid}_${txId}`);
  const cleanSymbol = payload.symbol.trim().toUpperCase().slice(0, 32);
  const ts = serverTimestamp();

  const txDoc: Record<string, unknown> = {
    id: txId,
    ownerId: uid,
    instrument_type: payload.instrument_type,
    transaction_type: payload.transaction_type,
    symbol: cleanSymbol,
    name: payload.name.trim().slice(0, 160),
    quantity: Number(payload.quantity),
    price: Number(payload.price),
    date: payload.date.slice(0, 16),
    exchange: payload.exchange,
    createdAt: ts,
    updatedAt: ts
  };
  if (payload.target_lot_id) {
    txDoc.target_lot_id = payload.target_lot_id.slice(0, 64);
  }

  try {
    await setDoc(doc(db, 'transactions', docId), txDoc);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `transactions/${docId}`);
  }

  // Ensure instrument price doc exists in Firestore with live market price if available
  if (!existingInstruments[cleanSymbol]) {
    const instDocId = sanitizeId(`${uid}_${cleanSymbol}`);
    let latestPrice = Number(payload.price);
    let previousClose = Number(payload.price);
    let high52w: number | undefined;
    let low52w: number | undefined;
    let source: 'yahoo_live' | 'mfapi_live' | 'cached_fallback' = 'cached_fallback';

    try {
      const res = await fetch('/api/prices/refresh-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              symbol: cleanSymbol,
              instrument_type: payload.instrument_type,
              name: payload.name.trim()
            }
          ]
        })
      });
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const json = await res.json();
        const fetched = json?.instruments?.[0];
        if (fetched && typeof fetched.latest_price === 'number' && fetched.latest_price > 0) {
          latestPrice = Number(fetched.latest_price);
          previousClose = Number(fetched.previous_close || fetched.latest_price);
          high52w = typeof fetched.high_52w === 'number' ? fetched.high_52w : undefined;
          low52w = typeof fetched.low_52w === 'number' ? fetched.low_52w : undefined;
          source =
            fetched.source === 'yahoo_live' || fetched.source === 'mfapi_live'
              ? fetched.source
              : 'cached_fallback';
        }
      }
    } catch {
      // Fall back to user-entered buy price
    }

    try {
      const instDoc: Record<string, unknown> = {
        symbol: cleanSymbol,
        ownerId: uid,
        instrument_type: payload.instrument_type,
        name: payload.name.trim().slice(0, 160),
        exchange: payload.exchange,
        latest_price: latestPrice,
        previous_close: previousClose,
        last_updated: new Date().toISOString().slice(0, 40),
        source,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      if (typeof high52w === 'number') instDoc.high_52w = high52w;
      if (typeof low52w === 'number') instDoc.low_52w = low52w;
      await setDoc(doc(db, 'instruments', instDocId), instDoc);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `instruments/${instDocId}`);
    }
  }
}

export async function deleteTransactionFromFirestore(
  uid: string,
  txId: string
): Promise<void> {
  const docId = sanitizeId(`${uid}_${txId}`);
  try {
    await deleteDoc(doc(db, 'transactions', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `transactions/${docId}`);
  }
}

export async function createGoalInFirestore(
  uid: string,
  payload: {
    name: string;
    mode: 'A' | 'B';
    target_amount: number;
    accumulated_amount: number;
    target_date?: string;
    monthly_sip?: number;
    custom_return_pct?: number;
  },
  trailing1YReturnPct: number,
  referenceDate: string
): Promise<void> {
  const rPct =
    typeof payload.custom_return_pct === 'number'
      ? payload.custom_return_pct
      : trailing1YReturnPct;
  const scopedGoalId = sanitizeId(`${uid.slice(0, 12)}-goal-${Date.now()}`).replace(/\./g, '-');
  const scopedRecalcId = sanitizeId(`${uid.slice(0, 12)}-recalc-${Date.now()}`).replace(/\./g, '-');
  const ts = serverTimestamp();

  const batch = writeBatch(db);

  if (payload.mode === 'A') {
    const monthsN = monthsBetween(referenceDate, String(payload.target_date));
    const solved = calculateModeASip(
      payload.target_amount,
      monthsN,
      rPct,
      payload.accumulated_amount
    );
    const reqSip = Math.round(solved.requiredMonthlySip);

    batch.set(doc(db, 'goals', scopedGoalId), {
      id: scopedGoalId,
      ownerId: uid,
      name: payload.name.trim().slice(0, 120),
      mode: 'A',
      target_amount: Number(payload.target_amount),
      accumulated_amount: Number(payload.accumulated_amount),
      created_date: referenceDate.slice(0, 16),
      target_date: String(payload.target_date).slice(0, 16),
      initial_required_sip: reqSip,
      current_required_sip: reqSip,
      last_trailing_1y_return_pct: Number(rPct),
      createdAt: ts,
      updatedAt: ts
    });

    batch.set(doc(db, 'goal_recalcs', scopedRecalcId), {
      id: scopedRecalcId,
      ownerId: uid,
      goal_id: scopedGoalId,
      recalc_date: referenceDate.slice(0, 16),
      trailing_1y_return_pct: Number(rPct),
      accumulated_amount: Number(payload.accumulated_amount),
      adjusted_monthly_sip: reqSip,
      note: 'Goal created in Firestore (Mode A)',
      createdAt: ts,
      updatedAt: ts
    });
  } else {
    const numSip = Number(payload.monthly_sip || 0);
    const solved = calculateModeBMonths(
      payload.target_amount,
      numSip,
      rPct,
      payload.accumulated_amount,
      referenceDate
    );

    const goalDoc: Record<string, unknown> = {
      id: scopedGoalId,
      ownerId: uid,
      name: payload.name.trim().slice(0, 120),
      mode: 'B',
      target_amount: Number(payload.target_amount),
      accumulated_amount: Number(payload.accumulated_amount),
      created_date: referenceDate.slice(0, 16),
      monthly_sip: numSip,
      last_trailing_1y_return_pct: Number(rPct),
      createdAt: ts,
      updatedAt: ts
    };
    if (solved.projectedTargetDate) {
      goalDoc.initial_target_date = solved.projectedTargetDate.slice(0, 16);
      goalDoc.current_target_date = solved.projectedTargetDate.slice(0, 16);
    }
    if (typeof solved.months === 'number') {
      goalDoc.current_months_to_target = solved.months;
    }

    batch.set(doc(db, 'goals', scopedGoalId), goalDoc);

    const recalcDoc: Record<string, unknown> = {
      id: scopedRecalcId,
      ownerId: uid,
      goal_id: scopedGoalId,
      recalc_date: referenceDate.slice(0, 16),
      trailing_1y_return_pct: Number(rPct),
      accumulated_amount: Number(payload.accumulated_amount),
      note: 'Goal created in Firestore (Mode B)',
      createdAt: ts,
      updatedAt: ts
    };
    if (solved.projectedTargetDate) {
      recalcDoc.adjusted_target_date = solved.projectedTargetDate.slice(0, 16);
    }
    if (typeof solved.months === 'number') {
      recalcDoc.adjusted_months_remaining = solved.months;
    }

    batch.set(doc(db, 'goal_recalcs', scopedRecalcId), recalcDoc);
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `goals/${scopedGoalId}`);
  }
}

export async function deleteGoalFromFirestore(
  goalId: string,
  recalcHistory: GoalRecalcEntry[]
): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'goals', goalId));
  for (const r of recalcHistory.filter((item) => item.goal_id === goalId)) {
    batch.delete(doc(db, 'goal_recalcs', r.id));
  }
  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `goals/${goalId}`);
  }
}

export async function runDailySnapshotInFirestore(
  uid: string,
  transactions: TransactionRecord[],
  existingInstruments: Record<string, FirestoreInstrumentDoc>,
  existingSnapshots: DailyInstrumentSnapshot[]
): Promise<void> {
  const uniqueSymbols = Array.from(new Set(transactions.map((t) => t.symbol)));
  const itemsToRefresh = uniqueSymbols.map((sym) => {
    const sampleTx = transactions.find((t) => t.symbol === sym);
    return {
      symbol: sym,
      instrument_type:
        existingInstruments[sym]?.instrument_type ||
        sampleTx?.instrument_type ||
        'stock',
      name: existingInstruments[sym]?.name || sampleTx?.name || sym
    };
  });

  let refreshedList: Array<{
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
  }> = [];

  try {
    const res = await fetch('/api/prices/refresh-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: itemsToRefresh })
    });
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const json = await res.json();
      if (Array.isArray(json?.instruments)) {
        refreshedList = json.instruments;
      }
    }
  } catch {
    // Fallback to direct client-side fetch below
  }

  // Browser-direct fallback (queries api.mfapi.in directly for mutual funds if backend is unreachable)
  if (refreshedList.length === 0) {
    refreshedList = await Promise.all(
      itemsToRefresh.map(async (item) => {
        const existing = existingInstruments[item.symbol];
        if (item.instrument_type === 'mutual_fund') {
          try {
            const mfRes = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(item.symbol)}`);
            if (mfRes.ok) {
              const mfJson = await mfRes.json();
              if (Array.isArray(mfJson?.data) && mfJson.data.length > 0) {
                const latestNav = parseFloat(mfJson.data[0].nav);
                const prevNav = mfJson.data[1] ? parseFloat(mfJson.data[1].nav) : latestNav;
                if (!isNaN(latestNav) && latestNav > 0) {
                  return {
                    symbol: item.symbol,
                    instrument_type: 'mutual_fund' as InstrumentType,
                    name: mfJson.meta?.scheme_name || item.name,
                    exchange: 'N/A' as ExchangeType,
                    latest_price: latestNav,
                    previous_close: !isNaN(prevNav) && prevNav > 0 ? prevNav : latestNav,
                    last_updated: new Date().toISOString(),
                    source: 'mfapi_live' as const
                  };
                }
              }
            }
          } catch {
            // Fall through to cached
          }
        }
        return {
          symbol: item.symbol,
          instrument_type: item.instrument_type as InstrumentType,
          name: existing?.name || item.name,
          exchange:
            existing?.exchange ||
            (item.instrument_type === 'mutual_fund'
              ? 'N/A'
              : item.symbol.endsWith('.BO')
                ? 'BSE'
                : 'NSE'),
          latest_price: existing?.latest_price || 100,
          previous_close: existing?.previous_close || 99,
          high_52w: existing?.high_52w,
          low_52w: existing?.low_52w,
          last_updated: new Date().toISOString(),
          source: existing?.source || ('cached_fallback' as const)
        };
      })
    );
  }

  const updatedMap: Record<string, FirestoreInstrumentDoc> = { ...existingInstruments };
  const updatedPrices: Record<string, number> = {};

  for (const inst of refreshedList) {
    updatedMap[inst.symbol] = {
      ...inst,
      ownerId: uid
    };
    updatedPrices[inst.symbol] = Number(inst.latest_price);
  }

  const { openLots } = computePortfolioLotsAndPnlClient(transactions, updatedMap);
  const totalVal = Number(openLots.reduce((s, l) => s + l.current_value, 0).toFixed(2));
  const todayStr = new Date().toISOString().slice(0, 10);

  try {
    const ts = serverTimestamp();
    for (const inst of refreshedList) {
      const instDocId = sanitizeId(`${uid}_${inst.symbol}`);
      const existsAlready = Boolean(existingInstruments[inst.symbol]);
      const payload: Record<string, unknown> = {
        name: String(inst.name).slice(0, 160),
        latest_price: Number(inst.latest_price),
        previous_close: Number(inst.previous_close),
        last_updated: String(inst.last_updated).slice(0, 40),
        source: inst.source,
        updatedAt: ts
      };
      if (typeof inst.high_52w === 'number') payload.high_52w = inst.high_52w;
      if (typeof inst.low_52w === 'number') payload.low_52w = inst.low_52w;

      if (existsAlready) {
        await updateDoc(doc(db, 'instruments', instDocId), payload);
      } else {
        await setDoc(doc(db, 'instruments', instDocId), {
          symbol: String(inst.symbol).slice(0, 32),
          ownerId: uid,
          instrument_type: inst.instrument_type,
          exchange: inst.exchange,
          ...payload,
          createdAt: ts
        });
      }
    }

    const snapDocId = sanitizeId(`${uid}_${todayStr}`);
    const existingTodaySnap = existingSnapshots.find((s) => s.date === todayStr);
    const mergedPrices = {
      ...(existingSnapshots[existingSnapshots.length - 1]?.prices || {}),
      ...updatedPrices
    };

    if (existingTodaySnap) {
      await updateDoc(doc(db, 'snapshots', snapDocId), {
        prices: mergedPrices,
        portfolio_total_value: totalVal,
        timestamp: new Date().toISOString().slice(0, 40),
        updatedAt: ts
      });
    } else {
      await setDoc(doc(db, 'snapshots', snapDocId), {
        date: todayStr,
        ownerId: uid,
        prices: mergedPrices,
        portfolio_total_value: totalVal,
        timestamp: new Date().toISOString().slice(0, 40),
        createdAt: ts,
        updatedAt: ts
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'daily_snapshot_sync');
  }
}

export async function runMonthlyGoalRecalcInFirestore(
  uid: string,
  goals: GoalRecord[],
  payload: {
    recalc_date: string;
    override_return_pct: number;
    accumulated_Increment: number;
    note: string;
  }
): Promise<void> {
  const rPct = Number(payload.override_return_pct);
  const recalcDate = payload.recalc_date.slice(0, 16);
  const ts = serverTimestamp();

  try {
    for (const goal of goals) {
      const nextAccum = Number(goal.accumulated_amount + (payload.accumulated_Increment || 0));
      const recalcId = sanitizeId(
        `${uid.slice(0, 12)}-recalc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
      ).replace(/\./g, '-');

      if (goal.mode === 'A' && goal.target_date) {
        const monthsRem = monthsBetween(recalcDate, goal.target_date);
        const solved = calculateModeASip(goal.target_amount, monthsRem, rPct, nextAccum);
        const adjSip = Math.round(solved.requiredMonthlySip);

        await updateDoc(doc(db, 'goals', goal.id), {
          accumulated_amount: nextAccum,
          current_required_sip: adjSip,
          last_trailing_1y_return_pct: rPct,
          updatedAt: ts
        });

        await setDoc(doc(db, 'goal_recalcs', recalcId), {
          id: recalcId,
          ownerId: uid,
          goal_id: goal.id,
          recalc_date: recalcDate,
          trailing_1y_return_pct: rPct,
          accumulated_amount: nextAccum,
          adjusted_monthly_sip: adjSip,
          note: payload.note.slice(0, 200),
          createdAt: ts,
          updatedAt: ts
        });
      } else if (goal.mode === 'B' && goal.monthly_sip) {
        const solved = calculateModeBMonths(
          goal.target_amount,
          goal.monthly_sip,
          rPct,
          nextAccum,
          recalcDate
        );

        const goalUpdate: Record<string, unknown> = {
          accumulated_amount: nextAccum,
          last_trailing_1y_return_pct: rPct,
          updatedAt: ts
        };
        if (solved.projectedTargetDate) {
          goalUpdate.current_target_date = solved.projectedTargetDate.slice(0, 16);
        }
        if (typeof solved.months === 'number') {
          goalUpdate.current_months_to_target = solved.months;
        }
        await updateDoc(doc(db, 'goals', goal.id), goalUpdate);

        const recalcDoc: Record<string, unknown> = {
          id: recalcId,
          ownerId: uid,
          goal_id: goal.id,
          recalc_date: recalcDate,
          trailing_1y_return_pct: rPct,
          accumulated_amount: nextAccum,
          note: payload.note.slice(0, 200),
          createdAt: ts,
          updatedAt: ts
        };
        if (solved.projectedTargetDate) {
          recalcDoc.adjusted_target_date = solved.projectedTargetDate.slice(0, 16);
        }
        if (typeof solved.months === 'number') {
          recalcDoc.adjusted_months_remaining = solved.months;
        }
        await setDoc(doc(db, 'goal_recalcs', recalcId), recalcDoc);
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'monthly_goal_recalc');
  }
}

/**
 * Built-in client-side fallback portfolio so the app immediately loads even if
 * deployed to a static host (e.g. GitHub Pages) or during a serverless cold start.
 */
export function getClientFallbackPortfolio(): PortfolioDataResponse {
  const todayStr = '2026-11-10';
  const instruments: Record<string, FirestoreInstrumentDoc> = {
    'RELIANCE.NS': {
      symbol: 'RELIANCE.NS',
      ownerId: 'local',
      instrument_type: 'stock',
      name: 'Reliance Industries Ltd.',
      exchange: 'NSE',
      latest_price: 1294.65,
      previous_close: 1281.4,
      high_52w: 1608.8,
      low_52w: 1156.0,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    'HDFCBANK.NS': {
      symbol: 'HDFCBANK.NS',
      ownerId: 'local',
      instrument_type: 'stock',
      name: 'HDFC Bank Ltd.',
      exchange: 'NSE',
      latest_price: 1742.3,
      previous_close: 1728.9,
      high_52w: 1794.0,
      low_52w: 1363.55,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    'TCS.NS': {
      symbol: 'TCS.NS',
      ownerId: 'local',
      instrument_type: 'stock',
      name: 'Tata Consultancy Services Ltd.',
      exchange: 'NSE',
      latest_price: 4148.75,
      previous_close: 4162.1,
      high_52w: 4592.25,
      low_52w: 3591.5,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    '122639': {
      symbol: '122639',
      ownerId: 'local',
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
      ownerId: 'local',
      instrument_type: 'mutual_fund',
      name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      exchange: 'N/A',
      latest_price: 168.3942,
      previous_close: 167.218,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    },
    '118989': {
      symbol: '118989',
      ownerId: 'local',
      instrument_type: 'mutual_fund',
      name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth',
      exchange: 'N/A',
      latest_price: 196.482,
      previous_close: 194.85,
      last_updated: '2026-11-10T10:00:00Z',
      source: 'cached_fallback'
    }
  };

  const transactions: TransactionRecord[] = [
    {
      id: 'tx-101',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 120,
      price: 785.0,
      date: '2021-08-16',
      exchange: 'NSE'
    },
    {
      id: 'tx-102',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 60,
      price: 1120.0,
      date: '2025-02-10',
      exchange: 'NSE'
    },
    {
      id: 'tx-103',
      instrument_type: 'stock',
      transaction_type: 'sell',
      symbol: 'RELIANCE.NS',
      name: 'Reliance Industries Ltd.',
      quantity: 40,
      price: 1310.0,
      date: '2026-06-18',
      exchange: 'NSE'
    },
    {
      id: 'tx-104',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '122639',
      name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      quantity: 2450.525,
      price: 46.8,
      date: '2021-10-05',
      exchange: 'N/A'
    },
    {
      id: 'tx-105',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '122639',
      name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      quantity: 1150.0,
      price: 68.4,
      date: '2025-04-14',
      exchange: 'N/A'
    },
    {
      id: 'tx-106',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'HDFCBANK.NS',
      name: 'HDFC Bank Ltd.',
      quantity: 95,
      price: 1465.0,
      date: '2024-05-20',
      exchange: 'NSE'
    },
    {
      id: 'tx-107',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '120716',
      name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      quantity: 1420.85,
      price: 138.2,
      date: '2024-11-01',
      exchange: 'N/A'
    },
    {
      id: 'tx-108',
      instrument_type: 'mutual_fund',
      transaction_type: 'buy',
      symbol: '118989',
      name: 'HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth',
      quantity: 520.0,
      price: 191.2,
      date: '2026-10-20',
      exchange: 'N/A'
    },
    {
      id: 'tx-109',
      instrument_type: 'stock',
      transaction_type: 'buy',
      symbol: 'TCS.NS',
      name: 'Tata Consultancy Services Ltd.',
      quantity: 35,
      price: 3680.0,
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
      price: 4290.0,
      date: '2026-09-04',
      exchange: 'NSE'
    }
  ];

  const anchorPrices: Array<{ date: string; prices: Record<string, number> }> = [
    {
      date: '2021-11-10',
      prices: {
        'RELIANCE.NS': 812.4,
        'HDFCBANK.NS': 1290.0,
        'TCS.NS': 3180.0,
        '122639': 48.12,
        '120716': 104.5,
        '118989': 94.2
      }
    },
    {
      date: '2025-11-10',
      prices: {
        'RELIANCE.NS': 1118.5,
        'HDFCBANK.NS': 1512.0,
        'TCS.NS': 3740.0,
        '122639': 69.85,
        '120716': 144.6,
        '118989': 156.4
      }
    },
    {
      date: '2026-05-10',
      prices: {
        'RELIANCE.NS': 1198.2,
        'HDFCBANK.NS': 1618.4,
        'TCS.NS': 3925.0,
        '122639': 76.42,
        '120716': 155.8,
        '118989': 174.9
      }
    },
    {
      date: '2026-08-10',
      prices: {
        'RELIANCE.NS': 1244.8,
        'HDFCBANK.NS': 1682.5,
        'TCS.NS': 4055.0,
        '122639': 80.45,
        '120716': 162.1,
        '118989': 185.9
      }
    },
    {
      date: '2026-10-11',
      prices: {
        'RELIANCE.NS': 1269.4,
        'HDFCBANK.NS': 1711.2,
        'TCS.NS': 4118.0,
        '122639': 82.95,
        '120716': 165.45,
        '118989': 191.0
      }
    },
    {
      date: '2026-11-03',
      prices: {
        'RELIANCE.NS': 1281.9,
        'HDFCBANK.NS': 1726.8,
        'TCS.NS': 4158.0,
        '122639': 83.82,
        '120716': 166.95,
        '118989': 194.1
      }
    },
    {
      date: todayStr,
      prices: {
        'RELIANCE.NS': 1294.65,
        'HDFCBANK.NS': 1742.3,
        'TCS.NS': 4148.75,
        '122639': 84.6214,
        '120716': 168.3942,
        '118989': 196.482
      }
    }
  ];

  const price_snapshots: DailyInstrumentSnapshot[] = anchorPrices.map((snap) => {
    const { openLots } = computePortfolioLotsAndPnlClient(
      transactions,
      instruments,
      snap.date,
      snap.prices
    );
    const totalVal = openLots.reduce((sum, l) => sum + l.current_value, 0);
    return {
      date: snap.date,
      prices: snap.prices,
      portfolio_total_value: Number(totalVal.toFixed(2)),
      timestamp: `${snap.date}T16:30:00Z`
    };
  });

  const trailing1Y = 16.82;
  const reqSipA = Math.round(calculateModeASip(25000000, 120, trailing1Y, 952400).requiredMonthlySip);

  const goals: GoalRecord[] = [
    {
      id: 'goal-mode-a-1',
      name: 'Retirement Freedom Corpus',
      mode: 'A',
      target_amount: 25000000,
      accumulated_amount: 952400,
      created_date: '2026-06-01',
      target_date: '2036-11-10',
      initial_required_sip: 58420,
      current_required_sip: reqSipA,
      last_trailing_1y_return_pct: trailing1Y
    },
    {
      id: 'goal-mode-b-1',
      name: 'Home Downpayment Fund',
      mode: 'B',
      target_amount: 4500000,
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
      trailing_1y_return_pct: 15.1,
      accumulated_amount: 810000,
      adjusted_monthly_sip: 61850,
      note: 'Initial baseline schedule'
    },
    {
      id: 'recalc-6',
      goal_id: 'goal-mode-a-1',
      recalc_date: '2026-11-10',
      trailing_1y_return_pct: trailing1Y,
      accumulated_amount: 952400,
      adjusted_monthly_sip: reqSipA,
      note: 'Latest monthly recalculation'
    },
    {
      id: 'recalc-b1',
      goal_id: 'goal-mode-b-1',
      recalc_date: '2026-06-10',
      trailing_1y_return_pct: 15.1,
      accumulated_amount: 510000,
      adjusted_months_remaining: 48.2,
      adjusted_target_date: '2030-06-16',
      note: 'Initial baseline schedule'
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

  return buildPortfolioAnalyticsFromFirestore(
    transactions,
    instruments,
    price_snapshots,
    goals,
    goal_recalc_history
  );
}

