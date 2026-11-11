import React, { useState } from 'react';
import { CalendarClock, RefreshCw, Trash2, AlertTriangle, Plus } from 'lucide-react';
import { GoalRecalcEntry, GoalRecord } from '../types';
import {
  calculateModeASip,
  calculateModeBMonths,
  formatINR,
  formatPct,
  monthsBetween
} from '../utils/financeMath';

interface GoalsSectionProps {
  goals: GoalRecord[];
  recalcHistory: GoalRecalcEntry[];
  trailing1YReturnPct: number;
  referenceDate: string;
  portfolioCurrentValue: number;
  onCreateGoal: (payload: {
    name: string;
    mode: 'A' | 'B';
    target_amount: number;
    accumulated_amount: number;
    target_date?: string;
    monthly_sip?: number;
    custom_return_pct?: number;
  }) => Promise<void>;
  onDeleteGoal: (id: string) => Promise<void>;
  onRunMonthlyRecalc: (payload: {
    recalc_date: string;
    override_return_pct: number;
    accumulated_Increment: number;
    note: string;
  }) => Promise<void>;
}

export const GoalsSection: React.FC<GoalsSectionProps> = ({
  goals,
  recalcHistory,
  trailing1YReturnPct,
  referenceDate,
  portfolioCurrentValue,
  onCreateGoal,
  onDeleteGoal,
  onRunMonthlyRecalc
}) => {
  const [creationMode, setCreationMode] = useState<'A' | 'B'>('A');
  const [goalName, setGoalName] = useState('');
  const [targetAmount, setTargetAmount] = useState('10000000'); // ₹1 Crore default
  const [accumulatedAmount, setAccumulatedAmount] = useState('500000');
  const [targetDate, setTargetDate] = useState('2034-11-10');
  const [monthlySipInput, setMonthlySipInput] = useState('35000');
  const [assumedReturnPct, setAssumedReturnPct] = useState<string>(String(trailing1YReturnPct));
  const [isCreating, setIsCreating] = useState(false);

  // Selected goal for drift history chart
  const [selectedGoalId, setSelectedGoalId] = useState<string>(
    goals[0]?.id || 'goal-mode-a-1'
  );

  // Monthly recalculation simulation controls
  const [simDate, setSimDate] = useState('2026-12-10');
  const [simReturnPct, setSimReturnPct] = useState(String(trailing1YReturnPct));
  const [simAccumIncrement, setSimAccumIncrement] = useState('45000');
  const [isRecalculating, setIsRecalculating] = useState(false);

  const parsedTarget = parseFloat(targetAmount) || 0;
  const parsedAccum = parseFloat(accumulatedAmount) || 0;
  const parsedReturn = parseFloat(assumedReturnPct);
  const effectiveReturnPct = isNaN(parsedReturn) ? trailing1YReturnPct : parsedReturn;

  // Live preview for Mode A
  const monthsRemainingPreview = monthsBetween(referenceDate, targetDate);
  const modeAPreview = calculateModeASip(
    parsedTarget,
    monthsRemainingPreview,
    effectiveReturnPct,
    parsedAccum
  );

  // Live preview for Mode B
  const parsedMonthlySip = parseFloat(monthlySipInput) || 0;
  const modeBPreview = calculateModeBMonths(
    parsedTarget,
    parsedMonthlySip,
    effectiveReturnPct,
    parsedAccum,
    referenceDate
  );

  const handleCreateGoalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goalName.trim() || parsedTarget <= 0) return;
    setIsCreating(true);
    try {
      await onCreateGoal({
        name: goalName.trim(),
        mode: creationMode,
        target_amount: parsedTarget,
        accumulated_amount: parsedAccum,
        target_date: creationMode === 'A' ? targetDate : undefined,
        monthly_sip: creationMode === 'B' ? parsedMonthlySip : undefined,
        custom_return_pct: effectiveReturnPct
      });
      setGoalName('');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRunMonthlyRecalcSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRecalculating(true);
    try {
      await onRunMonthlyRecalc({
        recalc_date: simDate,
        override_return_pct: parseFloat(simReturnPct) || trailing1YReturnPct,
        accumulated_Increment: parseFloat(simAccumIncrement) || 0,
        note: `Monthly recalculation (${simDate})`
      });
      const nextD = new Date(simDate + 'T00:00:00Z');
      nextD.setUTCMonth(nextD.getUTCMonth() + 1);
      setSimDate(nextD.toISOString().slice(0, 10));
    } finally {
      setIsRecalculating(false);
    }
  };

  const activeGoalForChart =
    goals.find((g) => g.id === selectedGoalId) || goals[0];
  const historyForSelected = activeGoalForChart
    ? recalcHistory
        .filter((h) => h.goal_id === activeGoalForChart.id)
        .sort((a, b) => a.recalc_date.localeCompare(b.recalc_date))
    : [];

  return (
    <div className="space-y-5 sm:space-y-8">
      {/* Top Banner: Trailing 1-Year Portfolio Return & Explicit Spec Caveat */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div>
            <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
              SIP & Goal Math Engine (Trailing 1-Year Return)
            </h2>
            <p className="mt-1 text-xs text-slate-600 leading-relaxed">
              Monthly rate:{' '}
              <span className="font-mono text-slate-900">i = (1 + r)^(1/12) − 1</span> · Remaining
              target after corpus <span className="font-mono">A</span>:{' '}
              <span className="font-mono text-slate-900">
                FV_rem = FV − A × (1 + i)^N
              </span>
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 sm:flex sm:items-center sm:gap-6 sm:bg-transparent sm:p-0">
            <div>
              <div className="text-[11px] text-slate-500 sm:text-xs">Trailing 1Y Return (r)</div>
              <div className="font-mono text-lg font-bold text-emerald-700 tabular-nums sm:text-xl">
                {formatPct(trailing1YReturnPct, 2)} p.a.
              </div>
            </div>
            <div className="hidden h-8 w-px bg-slate-200 sm:block" />
            <div>
              <div className="text-[11px] text-slate-500 sm:text-xs">Monthly Rate (i)</div>
              <div className="font-mono text-lg font-bold text-slate-900 tabular-nums sm:text-xl">
                {formatPct(modeAPreview.monthlyRatePct, 3)} / mo
              </div>
            </div>
          </div>
        </div>

        {/* Mandatory Spec Caveat Notice */}
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-3.5 py-3 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="leading-relaxed">
            <span className="font-semibold">Model Assumption Caveat:</span> Goal Mode A and Mode B
            assume the next <span className="font-mono">N</span> years repeat your portfolio&apos;s
            trailing 1-year return (<span className="font-mono">{formatPct(effectiveReturnPct, 2)}</span>
            ). Because a single trailing year is a noisy estimate, check the monthly recalculation
            drift chart below as returns change.
          </div>
        </div>
      </div>

      {/* Main Split: Left = Goal Mode A / Mode B Calculator & Creator | Right = Active Goals & Recalculation Drift */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left 5 cols: Interactive Calculator & Goal Creator */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6 lg:col-span-5">
          <div className="flex flex-col gap-3 border-b border-slate-200 pb-4">
            <h3 className="text-base font-semibold text-slate-900">
              Create & Solve Financial Goal
            </h3>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setCreationMode('A')}
                className={`min-h-[44px] rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  creationMode === 'A'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mode A: Find SIP
              </button>
              <button
                type="button"
                onClick={() => setCreationMode('B')}
                className={`min-h-[44px] rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  creationMode === 'B'
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Mode B: Find Time (ETA)
              </button>
            </div>
          </div>

          <form onSubmit={handleCreateGoalSubmit} className="mt-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-700">
                Goal Title
              </label>
              <input
                type="text"
                required
                value={goalName}
                onChange={(e) => setGoalName(e.target.value)}
                placeholder={
                  creationMode === 'A'
                    ? 'e.g. Child Higher Education Corpus'
                    : 'e.g. Early Retirement Milestone'
                }
                className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
              />
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-700">
                  Target Amount (FV in INR)
                </label>
                <input
                  type="number"
                  required
                  min="1000"
                  step="any"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700">
                    Already Accumulated (A)
                  </label>
                  <button
                    type="button"
                    onClick={() => setAccumulatedAmount(String(Math.round(portfolioCurrentValue)))}
                    className="text-[11px] font-medium text-slate-600 underline hover:text-slate-900"
                  >
                    Use Portfolio
                  </button>
                </div>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={accumulatedAmount}
                  onChange={(e) => setAccumulatedAmount(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              {creationMode === 'A' ? (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-700">
                    Target Date ({monthsRemainingPreview} mos left)
                  </label>
                  <input
                    type="date"
                    required
                    min={referenceDate}
                    value={targetDate}
                    onChange={(e) => setTargetDate(e.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-700">
                    Monthly SIP Installment (P in INR)
                  </label>
                  <input
                    type="number"
                    required
                    min="500"
                    step="any"
                    value={monthlySipInput}
                    onChange={(e) => setMonthlySipInput(e.target.value)}
                    className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                  />
                </div>
              )}

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-slate-700">
                    Annual Return r (%)
                  </label>
                  <button
                    type="button"
                    onClick={() => setAssumedReturnPct(String(trailing1YReturnPct))}
                    className="text-[11px] font-medium text-slate-600 underline hover:text-slate-900"
                  >
                    Reset to 1Y ({trailing1YReturnPct}%)
                  </button>
                </div>
                <input
                  type="number"
                  step="0.1"
                  value={assumedReturnPct}
                  onChange={(e) => setAssumedReturnPct(e.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-slate-900 focus:outline-hidden sm:text-xs"
                />
              </div>
            </div>

            {/* Live Math Solution Output Box */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              {creationMode === 'A' ? (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-600">
                      Required Monthly SIP (P):
                    </span>
                    <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                      {formatINR(Math.round(modeAPreview.requiredMonthlySip))}/mo
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                    <div className="flex justify-between font-mono">
                      <span>Compounded Existing A × (1+i)^N:</span>
                      <span>{formatINR(Math.round(modeAPreview.compoundedExistingCorpus))}</span>
                    </div>
                    <div className="flex justify-between font-mono">
                      <span>Remaining Target for SIP:</span>
                      <span>{formatINR(Math.round(modeAPreview.remainingTargetAfterCorpus))}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {modeBPreview.status === 'non_positive_return' ? (
                    <div className="space-y-1.5 text-xs text-rose-800">
                      <div className="font-semibold">
                        Zero or Negative Return Detected (r = {formatPct(effectiveReturnPct, 2)})
                      </div>
                      <p className="text-[11px] leading-relaxed">
                        Because the assumed trailing 1-year return is zero or negative, positive
                        compounding cannot accelerate your target. Without investment growth (0%
                        return), reaching {formatINR(parsedTarget)} purely via principal
                        installments of {formatINR(parsedMonthlySip)}/mo takes{' '}
                        <span className="font-mono font-semibold">
                          {modeBPreview.zeroReturnMonths ?? '∞'} months
                        </span>
                        . At a negative return, investments erode principal over time.
                      </p>
                    </div>
                  ) : modeBPreview.status === 'already_reached' ? (
                    <div className="text-xs font-semibold text-emerald-700">
                      Target already reached! Accumulated corpus A ≥ Target FV.
                    </div>
                  ) : modeBPreview.status === 'unreachable' ? (
                    <div className="text-xs font-semibold text-rose-700">
                      Target exceeds 100-year horizon at current SIP installment. Increase monthly
                      SIP.
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-600">
                          Time to Reach (N):
                        </span>
                        <span className="font-mono text-lg font-bold text-slate-900 tabular-nums">
                          {modeBPreview.months}m ({((modeBPreview.months || 0) / 12).toFixed(1)}{' '}
                          yrs)
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-xs text-slate-600">
                        <span>Projected Target Date (ETA):</span>
                        <span className="font-mono font-semibold text-emerald-700">
                          {modeBPreview.projectedTargetDate}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isCreating}
              className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              {isCreating
                ? 'Saving Goal...'
                : `Save Mode ${creationMode} Goal to Active Tracker`}
            </button>
          </form>
        </div>

        {/* Right 7 cols: Active Goals Cards + Monthly Recalculation Drift History Chart */}
        <div className="space-y-6 lg:col-span-7">
          {/* Active Goals List */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
            <div className="border-b border-slate-200 pb-3.5">
              <h3 className="text-base font-semibold text-slate-900">
                Active Tracked Goals ({goals.length})
              </h3>
              <p className="text-xs text-slate-500">
                Tap any goal to view its monthly SIP / ETA recalculation drift over time.
              </p>
            </div>

            <div className="mt-4 space-y-3">
              {goals.map((g) => {
                const isSelected = activeGoalForChart?.id === g.id;
                const progressPct = Math.min(
                  100,
                  g.target_amount > 0 ? (g.accumulated_amount / g.target_amount) * 100 : 0
                );
                return (
                  <div
                    key={g.id}
                    onClick={() => setSelectedGoalId(g.id)}
                    className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                      isSelected
                        ? 'border-slate-900 bg-slate-50/80'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-slate-900">{g.name}</span>
                          <span className="text-xs text-slate-500">
                            · Mode {g.mode} (
                            {g.mode === 'A' ? 'Fixed Date → SIP' : 'Fixed SIP → ETA'})
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600 font-mono tabular-nums">
                          <span>Target: {formatINR(g.target_amount)}</span>
                          <span>·</span>
                          <span>
                            Saved: {formatINR(g.accumulated_amount)} ({progressPct.toFixed(1)}%)
                          </span>
                          <span>·</span>
                          <span>1Y r: {formatPct(g.last_trailing_1y_return_pct, 2)}</span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-2.5 sm:border-t-0 sm:pt-0">
                        <div className="font-mono tabular-nums sm:text-right">
                          {g.mode === 'A' ? (
                            <>
                              <div className="text-[11px] text-slate-500">
                                Adjusted SIP (Target {g.target_date})
                              </div>
                              <div className="text-sm font-bold text-slate-900">
                                {formatINR(g.current_required_sip || 0)}/mo
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-[11px] text-slate-500">
                                Adjusted ETA @ {formatINR(g.monthly_sip || 0)}/mo
                              </div>
                              <div className="text-sm font-bold text-emerald-700">
                                {g.current_target_date || 'N/A (r ≤ 0)'}{' '}
                                {g.current_months_to_target != null &&
                                  `(${g.current_months_to_target}m)`}
                              </div>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteGoal(g.id);
                          }}
                          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Delete goal"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Monthly Goal Recalculation Drift History Chart & Simulator */}
          {activeGoalForChart && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
              <div className="border-b border-slate-200 pb-3.5">
                <h3 className="text-base font-semibold text-slate-900">
                  Monthly Recalculation Drift — {activeGoalForChart.name}
                </h3>
                <p className="text-xs text-slate-500">
                  Shows how{' '}
                  {activeGoalForChart.mode === 'A'
                    ? 'Adjusted Monthly SIP'
                    : 'Projected Months Remaining (ETA)'}{' '}
                  drifted each month.
                </p>
              </div>

              {/* SVG Drift Line Chart */}
              {historyForSelected.length > 0 && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-3 sm:p-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-600">
                    <span className="font-medium truncate">
                      {activeGoalForChart.mode === 'A'
                        ? 'Adjusted Monthly SIP (INR/mo)'
                        : 'Months Remaining to Target'}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-slate-500">
                      {historyForSelected.length} mos
                    </span>
                  </div>

                  {(() => {
                    const values = historyForSelected.map((h) =>
                      activeGoalForChart.mode === 'A'
                        ? h.adjusted_monthly_sip || 0
                        : h.adjusted_months_remaining || 0
                    );
                    const minVal = Math.min(...values) * 0.92;
                    const maxVal = Math.max(...values) * 1.08 || 1;
                    const width = 560;
                    const height = 145;

                    const points = historyForSelected.map((h, i) => {
                      const val =
                        activeGoalForChart.mode === 'A'
                          ? h.adjusted_monthly_sip || 0
                          : h.adjusted_months_remaining || 0;
                      const x =
                        historyForSelected.length === 1
                          ? width / 2
                          : 40 + (i / (historyForSelected.length - 1)) * (width - 80);
                      const y =
                        height -
                        28 -
                        ((val - minVal) / Math.max(1e-5, maxVal - minVal)) * (height - 56);
                      return { x, y, val, entry: h };
                    });

                    const polylineStr = points.map((p) => `${p.x},${p.y}`).join(' ');

                    return (
                      <svg
                        viewBox={`0 0 ${width} ${height}`}
                        className="h-36 w-full overflow-visible"
                      >
                        <line
                          x1={40}
                          y1={height - 28}
                          x2={width - 40}
                          y2={height - 28}
                          stroke="#e2e8f0"
                          strokeWidth="1"
                        />
                        <polyline
                          fill="none"
                          stroke="#0f172a"
                          strokeWidth="2.5"
                          points={polylineStr}
                        />
                        {points.map((p, idx) => (
                          <g key={idx}>
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r="4.5"
                              className="fill-slate-900 stroke-white stroke-2"
                            />
                            <text
                              x={p.x}
                              y={p.y - 10}
                              textAnchor="middle"
                              className="fill-slate-900 font-mono text-[10px] font-semibold"
                            >
                              {activeGoalForChart.mode === 'A'
                                ? formatINR(p.val)
                                : `${p.val}m`}
                            </text>
                            <text
                              x={p.x}
                              y={height - 8}
                              textAnchor="middle"
                              className="fill-slate-500 font-mono text-[10px]"
                            >
                              {p.entry.recalc_date.slice(0, 7)}
                            </text>
                          </g>
                        ))}
                      </svg>
                    );
                  })()}
                </div>
              )}

              {/* Recalculation History Table */}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 font-medium">Date</th>
                      <th className="py-2 text-right font-medium">1Y r</th>
                      <th className="py-2 text-right font-medium">Saved (A)</th>
                      <th className="py-2 text-right font-medium">
                        {activeGoalForChart.mode === 'A' ? 'Adjusted SIP' : 'Adjusted ETA'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {historyForSelected.map((h) => (
                      <tr key={h.id} className="hover:bg-slate-50">
                        <td className="py-2.5 text-slate-900">{h.recalc_date}</td>
                        <td className="py-2.5 text-right text-emerald-700">
                          {formatPct(h.trailing_1y_return_pct, 2)}
                        </td>
                        <td className="py-2.5 text-right text-slate-700">
                          {formatINR(h.accumulated_amount)}
                        </td>
                        <td className="py-2.5 text-right font-semibold text-slate-900">
                          {activeGoalForChart.mode === 'A'
                            ? `${formatINR(h.adjusted_monthly_sip || 0)}/mo`
                            : `${h.adjusted_target_date || 'N/A'} (${
                                h.adjusted_months_remaining ?? '—'
                              }m)`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Monthly Cron Job Trigger / Simulator */}
              <form
                onSubmit={handleRunMonthlyRecalcSubmit}
                className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                  <CalendarClock className="h-4 w-4 text-slate-700" />
                  <span>Simulate Monthly Goal Recalculation</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Recomputes active goals with updated trailing 1Y return and accumulated corpus{' '}
                  <span className="font-mono">A</span>.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-600">
                      Recalc Date
                    </label>
                    <input
                      type="date"
                      value={simDate}
                      onChange={(e) => setSimDate(e.target.value)}
                      className="min-h-[42px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-600">
                      Trailing 1Y Return (%)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={simReturnPct}
                      onChange={(e) => setSimReturnPct(e.target.value)}
                      className="min-h-[42px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-600">
                      Add to Saved A (INR)
                    </label>
                    <input
                      type="number"
                      step="1000"
                      value={simAccumIncrement}
                      onChange={(e) => setSimAccumIncrement(e.target.value)}
                      className="min-h-[42px] w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      disabled={isRecalculating}
                      className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isRecalculating ? 'animate-spin' : ''}`} />
                      {isRecalculating ? 'Running...' : 'Run Recalc'}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
