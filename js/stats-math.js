// Modulo puro di calcolo per la pagina Statistiche orientata a riduzione del fumo.
// Nessun import di db / DOM / Apex: tutte le funzioni sono pure, prendono dati
// in input e ritornano numeri/array. Riusabile e testabile dalla console.

export const HEALTH_CONSTS = {
  minutesPerCig: 11,
  sourceCDC: "Stima CDC/Surgeon General — 11 min di aspettativa di vita per sigaretta evitata.",
};

export const DEFAULTS = {
  baselineAutoWindow: 14,
  baselineFloorMultiplier: 1.3,
  pricePerCigDefault: 0.30,
  currency: "€",
  maWindows: [7, 30],
  trendWindow: 30,
  trendMinPoints: 7,
  r2Threshold: 0.15,
  slopeSignificance: -0.01,
  extremeOutlierMultiple: 3.0,
};

function startOfDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Ritorna l'inizio del giorno locale distante n giorni da ts.
//
// Aritmetica sui giorni di CALENDARIO, non su multipli di 86.400.000 ms: al
// cambio d'ora legale un giorno locale dura 23h o 25h, quindi sommare DAY_MS
// produce timestamp alle 01:00/23:00 che non coincidono più con nessuna
// mezzanotte e non matchano più le chiavi prodotte da startOfDayMs().
//
// Il setHours() finale non è ridondante: in alcuni fusi (America/Santiago,
// Asia/Beirut…) il DST scatta A mezzanotte e la mezzanotte locale quel giorno
// NON esiste, quindi startOfDayMs() ritorna l'01:00. Senza rinormalizzare,
// setDate() propagherebbe quell'01:00 a tutti i giorni successivi — lo stesso
// scivolamento che questa funzione esiste per evitare.
export function startOfDayPlus(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── BINNING ───────────────────────────────────────────────── */

// taps = array di {timestamp} vivi (già filtrati alive lato chiamante).
// fromDay e toDay = ms a midnight locale, inclusivi.
//
// FINESTRA DI OSSERVAZIONE — assioma di tutto il modulo: un tap = una sigaretta,
// quindi dentro l'intervallo [primo tap … oggi] un giorno senza tap È il dato 0,
// non un buco. Non esiste uno stato "giorno sconosciuto": l'incertezza è una
// proprietà dei bordi dell'intervallo (dove la serie inizia), non dei singoli
// giorni. Sta al chiamante non chiedere giorni antecedenti al primo tap —
// altrimenti si ottengono zeri finti che sgonfiano medie, trend e baseline.
export function buildDailySeries(taps, fromDay, toDay) {
  const counts = new Map();
  for (const t of taps) {
    const d = startOfDayMs(t.timestamp);
    if (d < fromDay || d > toDay) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const out = [];
  for (let d = fromDay; d <= toDay; d = startOfDayPlus(d, 1)) {
    out.push({ day: d, n: counts.get(d) || 0 });
  }
  return out;
}

export function bucketByHour(taps) {
  const out = new Array(24).fill(0);
  for (const t of taps) out[new Date(t.timestamp).getHours()]++;
  return out;
}

export function bucketByWeekday(taps) {
  // Lun=0 .. Dom=6
  const out = new Array(7).fill(0);
  for (const t of taps) {
    const d = new Date(t.timestamp).getDay(); // 0=Dom .. 6=Sab
    out[(d + 6) % 7]++;
  }
  return out;
}

export function firstTapDay(taps) {
  if (!taps.length) return null;
  let min = Infinity;
  for (const t of taps) if (t.timestamp < min) min = t.timestamp;
  return min === Infinity ? null : startOfDayMs(min);
}

/* ── MEDIE E TREND ─────────────────────────────────────────── */

// MA trailing sugli ultimi `window` giorni (i-window+1 .. i). Resta null finché
// i giorni disponibili sono < ceil(window*0.6): non è un buco nei dati, è storia
// insufficiente all'inizio della serie.
export function computeMA(series, window = 7) {
  const out = new Array(series.length).fill(null);
  const minPoints = Math.ceil(window * 0.6);
  for (let i = 0; i < series.length; i++) {
    const from = Math.max(0, i - window + 1);
    const cnt = i - from + 1;
    if (cnt < minPoints) continue;
    let sum = 0;
    for (let j = from; j <= i; j++) sum += series[j].n;
    out[i] = sum / cnt;
  }
  return out;
}

// OLS su array di {x, y}. y = slope*x + intercept. r2 = R^2.
export function linearRegression(points) {
  const n = points.length;
  if (n < 7) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const p of points) {
    sumX += p.x; sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }
  const meanX = sumX / n, meanY = sumY / n;
  const denom = sumX2 - n * meanX * meanX;
  if (denom === 0) return null;
  const slope = (sumXY - n * meanX * meanY) / denom;
  const intercept = meanY - slope * meanX;
  const ssTot = sumY2 - n * meanY * meanY;
  let ssRes = 0;
  for (const p of points) {
    const pred = slope * p.x + intercept;
    ssRes += (p.y - pred) * (p.y - pred);
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, n };
}

// Trend sui dati. windowDays = quanti ultimi giorni considerare.
// Se baseline è positiva, winsorise: ogni n > baseline*extremeOutlierMultiple → cap.
export function computeTrend(series, { windowDays = DEFAULTS.trendWindow, baseline = 0 } = {}) {
  const slice = series.slice(-windowDays);
  if (slice.length < DEFAULTS.trendMinPoints) return null;
  const cap = baseline > 0 ? baseline * DEFAULTS.extremeOutlierMultiple : Infinity;
  const originDay = slice[0].day;
  // x = indice nello slice, non (row.day - originDay) / DAY_MS: la griglia è
  // densa e contigua per costruzione, e dopo un cambio d'ora i delta in ms non
  // sono più multipli esatti di DAY_MS.
  const points = slice.map((row, i) => ({
    x: i,
    y: Math.min(row.n, cap),
  }));
  const reg = linearRegression(points);
  if (!reg) return null;
  const projection = { zeroDay: null, daysToZero: null };
  if (reg.slope < DEFAULTS.slopeSignificance && reg.r2 >= DEFAULTS.r2Threshold) {
    const xZero = -reg.intercept / reg.slope;
    const lastX = points[points.length - 1].x;
    if (xZero > lastX) {
      const days = Math.ceil(xZero - lastX);
      projection.daysToZero = days;
      projection.zeroDay = startOfDayPlus(originDay, Math.ceil(xZero));
    }
  }
  return { ...reg, projection };
}

/* ── STREAK ────────────────────────────────────────────────── */

// Ogni giorno della finestra conta: un giorno a 0 sigarette prolunga la striscia.
export function computeStreaks(series, target) {
  if (!target || target <= 0) return { current: 0, best: 0, currentStartDay: null, bestRange: null };
  let cur = 0, curStart = null;
  let best = 0, bestStart = null, bestEnd = null;
  let runStart = null;
  for (const row of series) {
    if (row.n <= target) {
      if (cur === 0) { curStart = row.day; runStart = row.day; }
      cur++;
      if (cur > best) {
        best = cur;
        bestStart = runStart;
        bestEnd = row.day;
      }
    } else {
      cur = 0; curStart = null; runStart = null;
    }
  }
  return {
    current: cur,
    best,
    currentStartDay: curStart,
    bestRange: bestStart != null ? [bestStart, bestEnd] : null,
  };
}

export function daysOnTarget(series, target) {
  let on = 0, over = 0, total = 0;
  for (const row of series) {
    total++;
    if (!target || target <= 0) continue;
    if (row.n <= target) on++; else over++;
  }
  return { on, over, total };
}

/* ── BASELINE ──────────────────────────────────────────────── */

// Priorità: override > learned (media giorni 2-14) > target. Floor a target*1.3.
// series è l'intera storia (fromFirstTap..oggi).
export function computeBaseline(series, override = 0, dailyTarget = 0) {
  const target = Number(dailyTarget) || 0;
  const floor = target > 0 ? target * DEFAULTS.baselineFloorMultiplier : 0;
  if (override > 0) {
    return { value: Math.max(override, floor), source: "manual", raw: override };
  }
  // Learned: salta giorno 1 (parziale), prende fino a giorno 14, richiede ≥7 giorni.
  const learnSlice = series.slice(1, DEFAULTS.baselineAutoWindow);
  if (learnSlice.length >= 7) {
    const auto = learnSlice.reduce((a, r) => a + r.n, 0) / learnSlice.length;
    return { value: Math.max(auto, floor), source: "learned", raw: auto };
  }
  if (target > 0) {
    return { value: floor || target, source: "target", raw: target };
  }
  return { value: null, source: "none", raw: null };
}

/* ── SAVINGS / CONVERSIONI ─────────────────────────────────── */

// Cumulativo clampato per giorno: max(0, baseline - n). Mai negativo.
// `series` deve contenere solo giorni CONCLUSI (vedi stats.js): il giorno in
// corso avrebbe un n parziale e farebbe scendere una curva cumulativa.
export function savedCigarettesCumulative(series, baseline) {
  const out = [];
  if (!baseline || baseline <= 0) return series.map(() => 0);
  let acc = 0;
  for (const row of series) {
    acc += Math.max(0, baseline - row.n);
    out.push(acc);
  }
  return out;
}

export function savedCigarettesTotal(series, baseline) {
  if (!baseline || baseline <= 0) return 0;
  let acc = 0;
  for (const row of series) acc += Math.max(0, baseline - row.n);
  return acc;
}

export function moneySpent(totalTaps, pricePerCig) {
  return (Number(totalTaps) || 0) * (Number(pricePerCig) || 0);
}

export function moneySaved(savedCigs, pricePerCig) {
  return (Number(savedCigs) || 0) * (Number(pricePerCig) || 0);
}

export function lifeRegained(savedCigs, minutesPerCig = HEALTH_CONSTS.minutesPerCig) {
  const totalMinutes = Math.max(0, Math.round((Number(savedCigs) || 0) * minutesPerCig));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  return { totalMinutes, days, hours, minutes };
}

export function formatLifeTime(life) {
  if (!life || life.totalMinutes <= 0) return "—";
  const parts = [];
  if (life.days > 0) parts.push(`${life.days}g`);
  if (life.hours > 0) parts.push(`${life.hours}h`);
  if (life.minutes > 0 || parts.length === 0) parts.push(`${life.minutes}min`);
  return parts.join(" ");
}

/* ── PICCHI ────────────────────────────────────────────────── */

export function peakHour(hourBuckets) {
  let idx = -1, val = 0, total = 0;
  for (let i = 0; i < hourBuckets.length; i++) {
    total += hourBuckets[i];
    if (hourBuckets[i] > val) { val = hourBuckets[i]; idx = i; }
  }
  if (idx < 0 || total === 0) return { hour: -1, value: 0, pct: 0 };
  return { hour: idx, value: val, pct: val / total };
}

export function peakWeekday(weekdayBuckets) {
  let idx = -1, val = 0, total = 0;
  for (let i = 0; i < weekdayBuckets.length; i++) {
    total += weekdayBuckets[i];
    if (weekdayBuckets[i] > val) { val = weekdayBuckets[i]; idx = i; }
  }
  if (idx < 0 || total === 0) return { wday: -1, value: 0, pct: 0 };
  return { wday: idx, value: val, pct: val / total };
}

export function peakDay(series, fromIdx = 0, toIdx = -1) {
  if (toIdx < 0) toIdx = series.length - 1;
  let idx = -1, val = 0;
  for (let i = fromIdx; i <= toIdx; i++) {
    if (series[i].n > val) { val = series[i].n; idx = i; }
  }
  return { dayIdx: idx, value: val };
}

/* ── COMPARE PERIODI ───────────────────────────────────────── */

export function compareSums(currSum, prevSum) {
  if (prevSum === 0 && currSum === 0) return { direction: "flat", deltaPct: 0, deltaAbs: 0 };
  if (prevSum === 0) return { direction: "up", deltaPct: null, deltaAbs: currSum };
  const deltaAbs = currSum - prevSum;
  const deltaPct = Math.round((deltaAbs / prevSum) * 100);
  const direction = deltaPct < -3 ? "down" : deltaPct > 3 ? "up" : "flat";
  return { direction, deltaPct, deltaAbs };
}

/* ── PERIODI ───────────────────────────────────────────────── */

// Dato l'intero series e una pillola periodo, ritorna i bounds {from, to}.
// Lo slice denso lo costruisce il chiamante: stats.js usa una series estesa
// (con buffer per le MA), quindi farlo qui sarebbe spreco.
export function slicePeriod(series, period, todayDay) {
  if (!series.length) return { from: todayDay, to: todayDay };
  const last = series[series.length - 1].day;
  let from;
  if (period === "7d") from = startOfDayPlus(last, -6);
  else if (period === "30d") from = startOfDayPlus(last, -29);
  else if (period === "90d") from = startOfDayPlus(last, -89);
  else if (period === "year") {
    const d = new Date(last); d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
    from = d.getTime();
  } else from = series[0].day; // "all"
  return { from, to: last };
}

/* ── FORMAT ────────────────────────────────────────────────── */

const NF_IT = new Intl.NumberFormat("it-IT");
const NF_IT_1 = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });
const NF_EUR = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });

export function fmtNum(n, decimals = 0) {
  if (n == null || isNaN(n)) return "—";
  return decimals > 0 ? NF_IT_1.format(n) : NF_IT.format(Math.round(n));
}

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return NF_EUR.format(n);
}
