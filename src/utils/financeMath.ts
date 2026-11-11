export function formatINR(amount: number, decimals = 0): string {
  const isNegative = amount < 0;
  const absVal = Math.abs(amount);
  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(absVal);
  return isNegative ? `-${formatted}` : formatted;
}

export function formatNumberIN(num: number, decimals = 2): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(num);
}

export function formatPct(pct: number, decimals = 2): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(decimals)}%`;
}

/**
 * Monthly rate from trailing annual return r (as a decimal, e.g. 0.18 for 18%):
 * i = (1 + r)^(1/12) - 1
 */
export function annualToMonthlyRate(rDecimal: number): number {
  if (rDecimal <= -0.99) return -0.5;
  return Math.pow(1 + rDecimal, 1 / 12) - 1;
}

/**
 * Mode A — solve for P given target FV, N months, trailing annual return r, and already accumulated A:
 * Effective FV = max(0, FV - A * (1+i)^N)
 * P = (Effective_FV * i) / ([(1+i)^N - 1] * (1+i))
 */
export function calculateModeASip(
  targetFV: number,
  monthsN: number,
  annualReturnPct: number,
  accumulatedA: number = 0
): {
  requiredMonthlySip: number;
  monthlyRatePct: number;
  compoundedExistingCorpus: number;
  remainingTargetAfterCorpus: number;
} {
  const rDecimal = annualReturnPct / 100;
  const i = annualToMonthlyRate(rDecimal);
  if (monthsN <= 0) {
    return {
      requiredMonthlySip: Math.max(0, targetFV - accumulatedA),
      monthlyRatePct: i * 100,
      compoundedExistingCorpus: accumulatedA,
      remainingTargetAfterCorpus: Math.max(0, targetFV - accumulatedA)
    };
  }

  const compoundedA = accumulatedA * Math.pow(1 + i, monthsN);
  const effectiveFV = Math.max(0, targetFV - compoundedA);

  if (effectiveFV <= 0) {
    return {
      requiredMonthlySip: 0,
      monthlyRatePct: i * 100,
      compoundedExistingCorpus: compoundedA,
      remainingTargetAfterCorpus: 0
    };
  }

  if (Math.abs(i) < 1e-9) {
    return {
      requiredMonthlySip: effectiveFV / monthsN,
      monthlyRatePct: 0,
      compoundedExistingCorpus: accumulatedA,
      remainingTargetAfterCorpus: effectiveFV
    };
  }

  const denom = (Math.pow(1 + i, monthsN) - 1) * (1 + i);
  const P = Math.abs(denom) < 1e-9 ? effectiveFV / monthsN : (effectiveFV * i) / denom;

  return {
    requiredMonthlySip: Math.max(0, P),
    monthlyRatePct: i * 100,
    compoundedExistingCorpus: compoundedA,
    remainingTargetAfterCorpus: effectiveFV
  };
}

/**
 * Mode B — solve numerically (binary search) for N given target FV, fixed monthly SIP P,
 * trailing annual return r, and already accumulated A:
 * (FV - A * (1+i)^N) - P * (((1+i)^N - 1)/i) * (1+i) = 0
 */
export function calculateModeBMonths(
  targetFV: number,
  monthlySipP: number,
  annualReturnPct: number,
  accumulatedA: number = 0,
  referenceDateStr: string = new Date().toISOString().slice(0, 10)
): {
  months: number | null;
  projectedTargetDate: string | null;
  status: 'ok' | 'already_reached' | 'non_positive_return' | 'unreachable';
  zeroReturnMonths: number | null;
  monthlyRatePct: number;
} {
  const rDecimal = annualReturnPct / 100;
  const i = annualToMonthlyRate(rDecimal);
  const zeroReturnMonths =
    monthlySipP > 0 && targetFV > accumulatedA
      ? Math.ceil((targetFV - accumulatedA) / monthlySipP)
      : null;

  if (accumulatedA >= targetFV) {
    return {
      months: 0,
      projectedTargetDate: referenceDateStr,
      status: 'already_reached',
      zeroReturnMonths: 0,
      monthlyRatePct: i * 100
    };
  }

  // Explicit handling when r <= 0 as required by specification
  if (annualReturnPct <= 0) {
    return {
      months: null,
      projectedTargetDate: null,
      status: 'non_positive_return',
      zeroReturnMonths,
      monthlyRatePct: i * 100
    };
  }

  if (monthlySipP <= 0 && accumulatedA <= 0) {
    return {
      months: null,
      projectedTargetDate: null,
      status: 'unreachable',
      zeroReturnMonths,
      monthlyRatePct: i * 100
    };
  }

  const evalEquation = (N: number): number => {
    const compoundedA = accumulatedA * Math.pow(1 + i, N);
    const sipFV = monthlySipP * ((Math.pow(1 + i, N) - 1) / i) * (1 + i);
    return compoundedA + sipFV - targetFV;
  };

  let low = 0;
  let high = 1200; // 100 years cap
  if (evalEquation(high) < 0) {
    return {
      months: null,
      projectedTargetDate: null,
      status: 'unreachable',
      zeroReturnMonths,
      monthlyRatePct: i * 100
    };
  }

  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (evalEquation(mid) >= 0) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const solvedMonths = Number(high.toFixed(1));
  const d = new Date(referenceDateStr + 'T00:00:00Z');
  const wholeMonths = Math.floor(solvedMonths);
  const extraDays = Math.round((solvedMonths - wholeMonths) * 30);
  d.setUTCMonth(d.getUTCMonth() + wholeMonths);
  d.setUTCDate(d.getUTCDate() + extraDays);

  return {
    months: solvedMonths,
    projectedTargetDate: d.toISOString().slice(0, 10),
    status: 'ok',
    zeroReturnMonths,
    monthlyRatePct: i * 100
  };
}

export function monthsBetween(startStr: string, endStr: string): number {
  const d1 = new Date(startStr + 'T00:00:00Z');
  const d2 = new Date(endStr + 'T00:00:00Z');
  const days = (d2.getTime() - d1.getTime()) / (1000 * 3600 * 24);
  return Math.max(0, Number((days / 30.4375).toFixed(1)));
}
