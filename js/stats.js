import * as db from "./db.js";
import { escapeHtml, show } from "./app.js";
import ApexCharts from "https://esm.sh/apexcharts@3.54.1";
import * as sm from "./stats-math.js";

const PERIODS = [
  { id: "7d",   label: "7g" },
  { id: "30d",  label: "30g" },
  { id: "90d",  label: "90g" },
  { id: "year", label: "Anno" },
  { id: "all",  label: "Sempre" },
];

const state = {
  period: "30d",
};

let charts = { trend: null, heatmap: null, hourly: null, weekday: null, saved: null };
let tapsCache = { counterId: null, taps: null, fetchedAt: 0 };
const CACHE_TTL = 15_000;

function disposeCharts() {
  for (const k of Object.keys(charts)) {
    if (charts[k]) { try { charts[k].destroy(); } catch {} charts[k] = null; }
  }
}

function getAppOpens() {
  try {
    const raw = localStorage.getItem("contaapp:appOpens");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function loadTaps(counterId) {
  const now = Date.now();
  if (tapsCache.counterId === counterId && tapsCache.taps && now - tapsCache.fetchedAt < CACHE_TTL) {
    return tapsCache.taps;
  }
  const taps = await db.getAllTaps(counterId);
  tapsCache = { counterId, taps, fetchedAt: now };
  return taps;
}

export async function renderStats(root) {
  disposeCharts();
  const counters = await db.listCounters();
  if (counters.length === 0) {
    root.innerHTML = `
      <div class="empty-card mt-12">
        <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
          <span class="material-symbols-outlined" style="font-size:48px">leaderboard</span>
        </div>
        <h2 class="font-display font-bold text-xl mb-2">Nessun dato</h2>
        <p class="text-on-surface-variant text-sm">Crea un contatore e inizia a tracciare.</p>
      </div>`;
    return;
  }

  let activeId = db.getLastCounterId();
  if (activeId == null || !counters.find((c) => c.id === activeId)) {
    activeId = counters[0].id;
    db.setLastCounterId(activeId);
  }
  const active = counters.find((c) => c.id === activeId);

  root.innerHTML = buildSkeleton(active);

  const pillEl = root.querySelector("#period-pill");
  for (const p of PERIODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.className = p.id === state.period ? "active" : "";
    b.addEventListener("click", () => {
      if (state.period === p.id) return;
      state.period = p.id;
      // re-render solo il bottone attivo + ricalcoli (non re-buildSkeleton, evitiamo flash)
      pillEl.querySelectorAll("button").forEach((btn, i) =>
        btn.classList.toggle("active", PERIODS[i].id === state.period)
      );
      refresh(root, active).catch(console.error);
    });
    pillEl.appendChild(b);
  }

  await refresh(root, active);
}

function buildSkeleton(counter) {
  return `
    <div class="pt-2 pb-2">
      <div class="text-on-surface-variant text-sm">Contatore</div>
      <div class="font-display font-bold text-2xl text-on-surface flex items-center gap-2">
        <span class="w-3 h-3 rounded-full" style="background:${counter.color}"></span>
        ${escapeHtml(counter.name)}
      </div>
    </div>

    <div class="flex justify-center my-3">
      <div class="period-pill" id="period-pill"></div>
    </div>

    <!-- HERO: media mobile 7gg -->
    <div class="stat-card mt-1" id="hero-card">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-1">
        Media mobile 7 giorni
      </div>
      <div class="flex items-baseline gap-2">
        <span class="font-display font-bold text-5xl text-on-surface" id="hero-ma7">—</span>
        <span class="text-xs text-on-surface-variant">sig/giorno</span>
      </div>
      <div class="flex items-center gap-2 mt-2">
        <span id="hero-arrow" class="material-symbols-outlined" style="font-size:20px">trending_flat</span>
        <span id="hero-delta" class="text-sm font-semibold">—</span>
        <span class="text-xs text-on-surface-variant">vs 7 giorni prima</span>
      </div>
      <div class="text-xs text-on-surface-variant mt-2" id="hero-slope">—</div>
    </div>

    <!-- KPI 2x2 -->
    <div class="grid grid-cols-2 gap-3 mt-3">
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">history_toggle_off</span>
        <div class="label mt-1">Totale periodo</div>
        <div class="value" id="kpi-total">0</div>
        <div class="sub" id="kpi-total-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">show_chart</span>
        <div class="label mt-1">Media giornaliera</div>
        <div class="value" id="kpi-avg">0</div>
        <div class="sub" id="kpi-avg-sub">nel periodo</div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">target</span>
        <div class="label mt-1">Giorni sotto target</div>
        <div class="value" id="kpi-ontarget">—</div>
        <div class="sub" id="kpi-ontarget-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">local_fire_department</span>
        <div class="label mt-1">Streak migliore</div>
        <div class="value" id="kpi-streak">—</div>
        <div class="sub" id="kpi-streak-sub"></div>
      </div>
    </div>

    <!-- TREND chart -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">
        Andamento sigarette/giorno
      </div>
      <div id="chart-trend" class="-mx-2" style="min-height:240px"></div>
      <div class="text-xs text-on-surface-variant mt-2 flex flex-wrap gap-3 items-center">
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#e85454"></span>Giornaliero</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#10b981"></span>MA 7gg</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#6366f1"></span>MA 30gg</span>
        <span class="flex items-center gap-1" id="trend-target-legend" hidden><span class="inline-block w-3 h-0.5" style="background:#5a4a4a"></span>Target</span>
      </div>
    </section>

    <!-- HEATMAP -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Calendario · ultimi 12 mesi</div>
      <div id="chart-heatmap" class="-mx-2" style="min-height:240px"></div>
    </section>

    <!-- HOURLY -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Distribuzione oraria</div>
      <div id="chart-hourly" class="-mx-2" style="min-height:190px"></div>
      <div class="text-xs text-on-surface-variant mt-2" id="hourly-note"></div>
    </section>

    <!-- WEEKDAY -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Distribuzione per giorno settimana</div>
      <div id="chart-weekday" class="-mx-2" style="min-height:170px"></div>
      <div class="text-xs text-on-surface-variant mt-2" id="weekday-note"></div>
    </section>

    <!-- CUMULATIVE SAVED -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4" id="saved-section">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Sigarette evitate (cumulato)</div>
      <div id="chart-saved" class="-mx-2" style="min-height:200px"></div>
      <div class="text-xs text-on-surface-variant mt-2" id="saved-note"></div>
    </section>

    <!-- CONV cards -->
    <div class="grid grid-cols-1 gap-3 mt-4" id="conv-section">
      <div class="stat-card accent" id="conv-money-card">
        <span class="material-symbols-outlined deco">savings</span>
        <div class="label text-white/85">Risparmio cumulativo</div>
        <div class="value text-white"><span id="conv-money-saved">—</span></div>
        <div class="sub text-white/80" id="conv-money-period">—</div>
      </div>
      <div class="stat-card" id="conv-life-card">
        <span class="material-symbols-outlined" style="font-size:20px;color:#10b981">favorite</span>
        <div class="label mt-1">Tempo di vita guadagnato</div>
        <div class="value" id="conv-life-value">—</div>
        <div class="sub">~11 min per sigaretta evitata (stima CDC)</div>
      </div>
    </div>

    <!-- BASELINE banner -->
    <div class="mt-4 hidden bg-primary-fixed/40 rounded-2xl p-4 flex gap-3 items-start" id="baseline-banner">
      <div class="w-8 h-8 rounded-full bg-surface-container-lowest flex items-center justify-center text-primary flex-shrink-0">
        <span class="material-symbols-outlined" style="font-size:18px">info</span>
      </div>
      <div class="flex-1">
        <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-1">Baseline</div>
        <div class="text-sm text-on-surface" id="baseline-text">—</div>
        <button type="button" class="text-sm text-primary font-semibold mt-2 underline" id="baseline-cta">Imposta nelle Impostazioni</button>
      </div>
    </div>

    <!-- INSIGHT -->
    <div class="mt-4 bg-primary-fixed/40 rounded-2xl p-4 flex gap-3 items-start">
      <div class="w-8 h-8 rounded-full bg-surface-container-lowest flex items-center justify-center text-primary flex-shrink-0">
        <span class="material-symbols-outlined" style="font-size:18px">lightbulb</span>
      </div>
      <div>
        <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-1">Insight</div>
        <div class="text-sm text-on-surface" id="insight-text">—</div>
      </div>
    </div>
  `;
}

async function refresh(root, counter) {
  const taps = await loadTaps(counter.id);
  const today = db.startOfDay();
  const target = Number(counter.dailyTarget) || 0;
  const pricePerCig = Number(counter.pricePerCig) || 0;
  const baselineOverride = Number(counter.baselineOverride) || 0;
  const appOpens = getAppOpens();
  const DAY = 24 * 60 * 60 * 1000;

  // Storia COMPLETA dalla prima sigaretta. Serve a baseline, streak, trend, savings.
  const firstDay = sm.firstTapDay(taps) ?? today;
  const historicSeries = sm.buildDailySeries(taps, firstDay, today, appOpens);

  // Baseline su intera storia
  const baseline = sm.computeBaseline(historicSeries, baselineOverride, target);

  // Periodo selezionato: lo span temporale che l'utente vuole vedere nei grafici.
  // Costruiamo `series` denso dal periodo from (anche prima di firstDay → giorni
  // missing). Per dare contesto storico alle MA all'inizio del periodo, anticipo
  // l'inizio di altri 29 giorni (così MA30 ha base).
  const { from: periodFrom, to: periodTo } = sm.slicePeriod(historicSeries, state.period, today);
  const computeFrom = periodFrom - 29 * DAY;
  const series = sm.buildDailySeries(taps, computeFrom, today, appOpens);

  // MA su series estesa (così l'inizio del periodo ha MA già stabile)
  const ma7Full = sm.computeMA(series, 7);
  const ma30Full = sm.computeMA(series, 30);

  // Slice = la coda di series corrispondente esattamente al periodo selezionato
  const sliceStartIdx = Math.round((periodFrom - computeFrom) / DAY);
  const slice = series.slice(sliceStartIdx);
  const ma7Slice = ma7Full.slice(sliceStartIdx);
  const ma30Slice = ma30Full.slice(sliceStartIdx);

  const totalPeriod = slice.reduce((a, r) => a + r.n, 0);
  const nonMissingDays = slice.filter((r) => !r.missing).length;
  const avgPeriod = nonMissingDays > 0 ? totalPeriod / nonMissingDays : 0;
  const ma7 = ma7Full;
  const ma30 = ma30Full;

  const lastMA7 = ma7[ma7.length - 1];

  // Δ MA7 vs MA7 di 7 giorni prima
  const prevMA7Idx = ma7.length - 8;
  const prevMA7 = prevMA7Idx >= 0 ? ma7[prevMA7Idx] : null;
  let heroDelta = null, heroDir = "flat";
  if (lastMA7 != null && prevMA7 != null && prevMA7 > 0) {
    const pct = Math.round(((lastMA7 - prevMA7) / prevMA7) * 100);
    heroDelta = pct;
    heroDir = pct < -3 ? "down" : pct > 3 ? "up" : "flat";
  }

  // Trend
  const trend = sm.computeTrend(series, { windowDays: 30, baseline: baseline.value || 0 });

  // Streak
  const streak = sm.computeStreaks(series, target);
  const onTarget = sm.daysOnTarget(slice, target);

  // Confronto periodo vs precedente
  const sliceLen = slice.length;
  const prevSlice = series.slice(Math.max(0, series.length - sliceLen * 2), series.length - sliceLen);
  const prevTotal = prevSlice.reduce((a, r) => a + r.n, 0);
  const cmp = sm.compareSums(totalPeriod, prevTotal);

  // Hourly / weekday — sui tap del periodo
  const sliceTaps = taps.filter((t) => {
    const d = startOfDayMsLocal(t.timestamp);
    return d >= periodFrom && d <= periodTo;
  });
  const hourBuckets = sm.bucketByHour(sliceTaps);
  const wdayBuckets = sm.bucketByWeekday(sliceTaps);
  const peakH = sm.peakHour(hourBuckets);
  const peakW = sm.peakWeekday(wdayBuckets);

  // Saved cumulative su INTERA storia (non sulla series estesa con buffer di null)
  const totalSaved = baseline.value ? sm.savedCigarettesTotal(historicSeries, baseline.value) : 0;
  const savedInPeriod = baseline.value
    ? slice.filter((r) => !r.missing).reduce((a, r) => a + Math.max(0, baseline.value - r.n), 0)
    : 0;

  // ── Render testo ─────────────────────────────────────────
  const hero = root.querySelector("#hero-ma7");
  hero.textContent = lastMA7 != null ? sm.fmtNum(lastMA7, 1) : "—";

  const arrowEl = root.querySelector("#hero-arrow");
  const deltaEl = root.querySelector("#hero-delta");
  if (heroDelta != null) {
    arrowEl.textContent = heroDir === "down" ? "trending_down" : heroDir === "up" ? "trending_up" : "trending_flat";
    deltaEl.textContent = `${heroDelta > 0 ? "+" : ""}${heroDelta}%`;
    const cls = heroDir === "down" ? "delta-good" : heroDir === "up" ? "delta-bad" : "delta-flat";
    deltaEl.className = `text-sm font-semibold ${cls}`;
    arrowEl.className = `material-symbols-outlined ${cls}`;
    arrowEl.style.fontSize = "20px";
  } else {
    arrowEl.textContent = "trending_flat";
    deltaEl.textContent = "—";
    deltaEl.className = "text-sm font-semibold delta-flat";
  }

  const slopeEl = root.querySelector("#hero-slope");
  if (trend && Math.abs(trend.slope) > 0.05) {
    const perWeek = Math.round(trend.slope * 7 * 10) / 10;
    const word = perWeek < 0 ? "calando" : "aumentando";
    slopeEl.textContent = `Trend: ${word} di ~${Math.abs(perWeek)} sig/settimana (30 giorni, r²=${trend.r2.toFixed(2)})`;
  } else {
    slopeEl.textContent = trend ? "Trend stabile (30 giorni)" : "Trend non ancora calcolabile";
  }

  root.querySelector("#kpi-total").textContent = sm.fmtNum(totalPeriod);
  root.querySelector("#kpi-total-sub").textContent =
    cmp.deltaPct != null
      ? `${cmp.deltaPct > 0 ? "+" : ""}${cmp.deltaPct}% vs precedente`
      : (prevTotal === 0 && totalPeriod === 0 ? "—" : "");

  root.querySelector("#kpi-avg").textContent = sm.fmtNum(avgPeriod, 1);
  root.querySelector("#kpi-avg-sub").textContent = `su ${nonMissingDays} giorni attivi`;

  if (target > 0) {
    root.querySelector("#kpi-ontarget").textContent = String(onTarget.on);
    root.querySelector("#kpi-ontarget-sub").textContent = `${onTarget.over} sforati / ${onTarget.total} tot.`;
    root.querySelector("#kpi-streak").textContent = String(streak.best);
    root.querySelector("#kpi-streak-sub").textContent = `in corso: ${streak.current}`;
  } else {
    root.querySelector("#kpi-ontarget").textContent = "—";
    root.querySelector("#kpi-ontarget-sub").textContent = "imposta un target";
    root.querySelector("#kpi-streak").textContent = "—";
    root.querySelector("#kpi-streak-sub").textContent = "imposta un target";
  }

  // Conv cards
  const showHealth = localStorage.getItem("contaapp:showHealth") !== "false";
  const moneyCard = root.querySelector("#conv-money-card");
  const lifeCard = root.querySelector("#conv-life-card");

  if (pricePerCig > 0 && baseline.value) {
    moneyCard.classList.remove("hidden");
    root.querySelector("#conv-money-saved").textContent = sm.fmtMoney(sm.moneySaved(totalSaved, pricePerCig));
    root.querySelector("#conv-money-period").textContent =
      `${sm.fmtMoney(sm.moneySaved(savedInPeriod, pricePerCig))} in questo periodo`;
  } else if (pricePerCig > 0 && !baseline.value) {
    moneyCard.classList.remove("hidden");
    root.querySelector("#conv-money-saved").textContent = "—";
    root.querySelector("#conv-money-period").textContent = "Imposta una baseline per calcolare i risparmi";
  } else {
    moneyCard.classList.remove("hidden");
    root.querySelector("#conv-money-saved").textContent = "—";
    root.querySelector("#conv-money-period").innerHTML =
      `<button class="underline text-white" id="conv-money-cta">Imposta il prezzo per vederlo</button>`;
    const cta = root.querySelector("#conv-money-cta");
    if (cta) cta.addEventListener("click", () => show("settings"));
  }

  if (showHealth && baseline.value) {
    lifeCard.classList.remove("hidden");
    const life = sm.lifeRegained(totalSaved);
    root.querySelector("#conv-life-value").textContent = sm.formatLifeTime(life);
  } else {
    lifeCard.classList.add("hidden");
  }

  // Baseline banner
  const banner = root.querySelector("#baseline-banner");
  const bannerText = root.querySelector("#baseline-text");
  const bannerCta = root.querySelector("#baseline-cta");
  if (baseline.source === "none") {
    banner.classList.remove("hidden");
    bannerText.textContent = "Imposta quante sigarette fumavi prima di iniziare a tracciare (campo \"Fumavi prima\" in Impostazioni). Senza, non posso calcolare risparmi e tempo di vita guadagnato.";
    bannerCta.onclick = () => show("settings");
  } else {
    banner.classList.add("hidden");
  }

  // Saved section: nascondi se baseline none
  const savedSection = root.querySelector("#saved-section");
  if (baseline.value) savedSection.classList.remove("hidden");
  else savedSection.classList.add("hidden");

  // Insight
  root.querySelector("#insight-text").textContent = pickInsight({
    totalPeriod, target, baseline, streak, trend, cmp, peakH, peakW,
    totalSaved, savedInPeriod, pricePerCig, daysOnTargetData: onTarget,
  });

  // Note hourly/weekday
  const hourlyNote = root.querySelector("#hourly-note");
  if (peakH.pct >= 0.15 && peakH.value >= 3) {
    hourlyNote.textContent = `Fascia critica: ${String(peakH.hour).padStart(2, "0")}:00 — ${Math.round(peakH.pct * 100)}% delle sigarette del periodo.`;
  } else {
    hourlyNote.textContent = "";
  }
  const wdayNote = root.querySelector("#weekday-note");
  if (peakW.pct >= 0.18 && peakW.value >= 5) {
    wdayNote.textContent = `Picco sul ${weekdayName(peakW.wday)}: ${Math.round(peakW.pct * 100)}% del totale.`;
  } else {
    wdayNote.textContent = "";
  }

  // ── Charts ───────────────────────────────────────────────
  drawTrend(root.querySelector("#chart-trend"), slice, ma7Slice, ma30Slice, target);
  drawHeatmap(root.querySelector("#chart-heatmap"), historicSeries, target, baseline.value || 0);
  drawHourly(root.querySelector("#chart-hourly"), hourBuckets, peakH.hour);
  drawWeekday(root.querySelector("#chart-weekday"), wdayBuckets, peakW.wday);
  if (baseline.value) {
    const histCumSaved = sm.savedCigarettesCumulative(historicSeries, baseline.value);
    drawSaved(root.querySelector("#chart-saved"), historicSeries, histCumSaved);
    root.querySelector("#saved-note").textContent =
      `Baseline: ${sm.fmtNum(baseline.value, 1)} sig/g (${labelBaselineSource(baseline.source)}) · totale evitate: ${sm.fmtNum(totalSaved)}`;
  }
}

function labelBaselineSource(s) {
  if (s === "manual") return "impostata manualmente";
  if (s === "learned") return "calcolata dai primi 14 giorni";
  if (s === "target") return "derivata dal target";
  return "—";
}

function weekdayName(idx) {
  return ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"][idx] || "—";
}

function startOfDayMsLocal(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── INSIGHT ENGINE ──────────────────────────────────────── */

function pickInsight(m) {
  const { totalPeriod, target, baseline, streak, trend, cmp, peakH, peakW, totalSaved, pricePerCig, daysOnTargetData } = m;

  if (totalPeriod === 0) return "Nessuna sigaretta in questo periodo. Continua così.";
  if (streak.current >= 7 && target > 0) return `${streak.current} giorni consecutivi sotto target. La routine sta cambiando.`;
  if (streak.current >= 3 && target > 0) return `${streak.current} giorni sotto target di fila. Tieni il ritmo.`;
  if (trend && trend.slope <= -0.5) {
    const perWeek = Math.round(Math.abs(trend.slope) * 7);
    return `Stai calando di circa ${perWeek} sigarette a settimana.`;
  }
  if (trend && trend.slope >= 0.5) {
    const perWeek = Math.round(trend.slope * 7);
    return `Stai aumentando di circa ${perWeek} sigarette a settimana — vale la pena fermarsi a capire cosa è cambiato.`;
  }
  if (cmp.direction === "down" && cmp.deltaPct != null && Math.abs(cmp.deltaPct) >= 10) {
    return `${Math.abs(cmp.deltaPct)}% in meno rispetto al periodo precedente.`;
  }
  if (cmp.direction === "up" && cmp.deltaPct != null && cmp.deltaPct >= 10) {
    return `${cmp.deltaPct}% in più rispetto al periodo precedente — vale la pena fermarsi.`;
  }
  if (peakH.pct >= 0.18 && peakH.value >= 3) {
    return `Picco di ${peakH.value} sigarette intorno alle ${String(peakH.hour).padStart(2, "0")}:00 — è la fascia su cui lavorare.`;
  }
  if (peakW.pct >= 0.20 && peakW.value >= 5) {
    return `Il ${weekdayName(peakW.wday)} concentra il ${Math.round(peakW.pct * 100)}% delle sigarette — pianifica un'alternativa.`;
  }
  if (target > 0 && daysOnTargetData.on >= daysOnTargetData.over * 2 && daysOnTargetData.total >= 5) {
    return `Hai rispettato il target in ${daysOnTargetData.on} giorni su ${daysOnTargetData.total}.`;
  }
  if (baseline.source === "learned" && totalSaved >= 50) {
    const money = pricePerCig > 0 ? ` (~${sm.fmtMoney(totalSaved * pricePerCig)} risparmiati)` : "";
    return `Da quando misuri, hai evitato circa ${Math.round(totalSaved)} sigarette${money}.`;
  }
  return "Continua a misurare. La consapevolezza è il primo passo.";
}

/* ── CHARTS ───────────────────────────────────────────────── */

const BASE_CHART = {
  toolbar: { show: false },
  animations: { enabled: true, speed: 180, easing: "easeOutCubic" },
  fontFamily: "Inter, system-ui, sans-serif",
  foreColor: "#5a4a4a",
  parentHeightOffset: 0,
};

function drawTrend(el, slice, ma7Slice, ma30Slice, target) {
  if (charts.trend) { try { charts.trend.destroy(); } catch {} charts.trend = null; }
  if (!el || !el.isConnected) return;

  // Costruisce le serie. Per il "Giornaliero" usiamo null sui giorni missing,
  // ma se il valore reale è 0 lo lasciamo a 0 (NON null) — è un dato reale.
  const daily = slice.map((r) => ({ x: r.day, y: r.missing ? null : r.n }));
  const ma7Data = slice.map((r, i) => ({ x: r.day, y: ma7Slice[i] }));
  const ma30Data = slice.map((r, i) => ({ x: r.day, y: ma30Slice[i] }));

  // Escludi le serie tutte-null: Apex con smooth curve può crashare/non disegnare.
  const hasDaily = daily.some((p) => p.y != null);
  const hasMA7 = ma7Data.some((p) => p.y != null);
  const hasMA30 = ma30Data.some((p) => p.y != null);

  const series = [];
  const colors = [];
  const widths = [];
  const fillTypes = [];
  if (hasDaily) { series.push({ name: "Giornaliero", data: daily });  colors.push("#e85454"); widths.push(2); fillTypes.push("gradient"); }
  if (hasMA7)   { series.push({ name: "MA 7gg",      data: ma7Data }); colors.push("#10b981"); widths.push(3); fillTypes.push("solid");    }
  if (hasMA30)  { series.push({ name: "MA 30gg",     data: ma30Data });colors.push("#6366f1"); widths.push(2); fillTypes.push("solid");    }

  if (series.length === 0) {
    // Niente da disegnare: mostra placeholder testuale
    el.innerHTML = `<div class="text-center text-on-surface-variant text-sm py-12">Nessun dato nel periodo selezionato.</div>`;
    return;
  }

  // Per pochi punti, curve "straight" + marker visibili (smooth con 1-2 punti non rende).
  const validCount = daily.filter((p) => p.y != null).length;
  const curve = validCount <= 3 ? "straight" : "smooth";
  const markerSize = validCount <= 10 ? 4 : 0;
  // Con pochi punti reali nel grafico, collegare i punti attraverso i null aiuta
  // a vedere la linea (altrimenti i marker appaiono isolati).
  const connectNulls = validCount <= 10;

  const opts = {
    chart: { type: "line", height: 240, ...BASE_CHART },
    series,
    stroke: { curve, width: widths },
    connectNulls,
    colors,
    markers: { size: markerSize, hover: { size: markerSize + 2 } },
    fill: {
      type: fillTypes,
      gradient: { opacityFrom: 0.25, opacityTo: 0, shadeIntensity: 0.5 },
    },
    grid: {
      borderColor: "rgba(216,196,196,0.3)",
      strokeDashArray: 4,
      yaxis: { lines: { show: true } },
      xaxis: { lines: { show: false } },
      padding: { top: 10, right: 0, bottom: 0, left: 0 },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
    xaxis: {
      type: "datetime",
      labels: { format: "d MMM", style: { fontSize: "10px", colors: "#5a4a4a" }, hideOverlappingLabels: true },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tickAmount: Math.min(6, Math.max(2, slice.length - 1)),
    },
    yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v) => Math.round(v), style: { fontSize: "10px", colors: "#5a4a4a" } } },
    tooltip: {
      shared: true,
      theme: "light",
      x: { format: "d MMM yyyy" },
      y: { formatter: (v) => v == null ? "—" : `${Math.round(v * 10) / 10} sig` },
    },
    annotations: target > 0 ? {
      yaxis: [{
        y: target,
        borderColor: "#5a4a4a",
        strokeDashArray: 4,
        label: {
          text: `target ${target}`,
          position: "left",
          offsetX: 70,
          style: { background: "#5a4a4a", color: "#fff", fontSize: "10px" },
        },
      }],
    } : {},
  };

  const legendTarget = el.parentElement.querySelector("#trend-target-legend");
  if (legendTarget) legendTarget.hidden = target <= 0;

  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    try {
      charts.trend = new ApexCharts(el, opts);
      charts.trend.render();
    } catch (err) {
      console.error("drawTrend failed:", err);
      el.innerHTML = `<div class="text-center text-on-surface-variant text-sm py-12">Errore nel rendering del grafico.</div>`;
    }
  });
}

function drawHeatmap(el, series, target, baselineValue) {
  if (charts.heatmap) { try { charts.heatmap.destroy(); } catch {} charts.heatmap = null; }
  if (!el || !el.isConnected) return;

  // Costruisci griglia 7 (Lun-Dom) × N settimane (ultimi 52 + corrente)
  const today = series.length ? series[series.length - 1].day : db.startOfDay();
  const DAY = 24 * 60 * 60 * 1000;
  // Trova il lunedì della settimana 52 fa
  const todayDate = new Date(today);
  const dow = (todayDate.getDay() + 6) % 7; // Lun=0
  const mondayThisWeek = today - dow * DAY;
  const startMonday = mondayThisWeek - 52 * 7 * DAY;
  // Mappa day -> n dalla serie
  const byDay = new Map();
  for (const r of series) if (!r.missing) byDay.set(r.day, r.n);
  // Costruisci serie per ApexCharts heatmap: una series per riga (giorno settimana)
  const rowNames = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  const seriesData = [];
  for (let r = 6; r >= 0; r--) {
    const data = [];
    for (let w = 0; w < 53; w++) {
      const dayTs = startMonday + (w * 7 + r) * DAY;
      const label = `S${w + 1}`;
      let val = null;
      if (dayTs <= today) {
        val = byDay.has(dayTs) ? byDay.get(dayTs) : 0;
      }
      data.push({ x: label, y: val });
    }
    seriesData.push({ name: rowNames[r], data });
  }

  const T = Math.max(Number(target) || 0, baselineValue || 0, 5);
  const opts = {
    chart: { type: "heatmap", height: 230, ...BASE_CHART, toolbar: { show: false } },
    series: seriesData,
    plotOptions: {
      heatmap: {
        radius: 3,
        shadeIntensity: 0.6,
        distributed: false,
        colorScale: {
          ranges: [
            { from: -0.5, to: 0,       color: "#f4eaea", name: "—" },
            { from: 0.5,  to: T * 0.5, color: "#fad2cf", name: "lieve" },
            { from: T * 0.5 + 0.001, to: T,       color: "#f08585", name: "vicino target" },
            { from: T + 0.001, to: T * 1.5,  color: "#e85454", name: "sopra target" },
            { from: T * 1.5 + 0.001, to: 99999,    color: "#8a1818", name: "molto sopra" },
          ],
        },
      },
    },
    dataLabels: { enabled: false },
    xaxis: { labels: { show: false }, axisBorder: { show: false }, axisTicks: { show: false } },
    yaxis: { labels: { style: { fontSize: "10px", colors: "#5a4a4a" } } },
    grid: { padding: { top: 0, right: 0, bottom: 0, left: 0 } },
    legend: { show: false },
    tooltip: {
      theme: "light",
      x: { show: false },
      y: { formatter: (v) => v == null ? "—" : `${v} sig` },
    },
  };

  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.heatmap = new ApexCharts(el, opts);
    charts.heatmap.render();
  });
}

function drawHourly(el, buckets, peakIdx) {
  if (charts.hourly) { try { charts.hourly.destroy(); } catch {} charts.hourly = null; }
  if (!el || !el.isConnected) return;
  const colors = buckets.map((_, i) => i === peakIdx ? "#8a1818" : "#e85454");
  const opts = {
    chart: { type: "bar", height: 180, ...BASE_CHART },
    series: [{ name: "Sigarette", data: buckets }],
    plotOptions: {
      bar: {
        columnWidth: "70%",
        borderRadius: 4,
        borderRadiusApplication: "end",
        distributed: true,
      },
    },
    colors,
    legend: { show: false },
    dataLabels: { enabled: false },
    grid: { borderColor: "rgba(216,196,196,0.3)", strokeDashArray: 4 },
    xaxis: {
      categories: buckets.map((_, i) => String(i).padStart(2, "0")),
      labels: { style: { fontSize: "10px", colors: "#5a4a4a" }, hideOverlappingLabels: true },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { labels: { formatter: (v) => Math.round(v), style: { fontSize: "10px" } }, tickAmount: 3 },
    tooltip: {
      theme: "light",
      y: { formatter: (v) => `${v} sig` },
      x: { formatter: (v) => `${v}:00–${v}:59` },
    },
  };
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.hourly = new ApexCharts(el, opts);
    charts.hourly.render();
  });
}

function drawWeekday(el, buckets, peakIdx) {
  if (charts.weekday) { try { charts.weekday.destroy(); } catch {} charts.weekday = null; }
  if (!el || !el.isConnected) return;
  const colors = buckets.map((_, i) => i === peakIdx ? "#8a1818" : "#e85454");
  const opts = {
    chart: { type: "bar", height: 160, ...BASE_CHART },
    series: [{ name: "Sigarette", data: buckets }],
    plotOptions: {
      bar: {
        columnWidth: "55%",
        borderRadius: 6,
        borderRadiusApplication: "end",
        distributed: true,
      },
    },
    colors,
    legend: { show: false },
    dataLabels: {
      enabled: true,
      formatter: (v) => v > 0 ? v : "",
      offsetY: -18,
      style: { fontSize: "10px", colors: ["#1a1c1c"], fontWeight: 600 },
    },
    grid: { borderColor: "rgba(216,196,196,0.3)", strokeDashArray: 4 },
    xaxis: {
      categories: ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"],
      labels: { style: { fontSize: "11px", colors: "#5a4a4a" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { labels: { formatter: (v) => Math.round(v) }, tickAmount: 3 },
    tooltip: { theme: "light", y: { formatter: (v) => `${v} sig` } },
  };
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.weekday = new ApexCharts(el, opts);
    charts.weekday.render();
  });
}

function drawSaved(el, series, cumSaved) {
  if (charts.saved) { try { charts.saved.destroy(); } catch {} charts.saved = null; }
  if (!el || !el.isConnected) return;
  const data = series.map((r, i) => ({ x: r.day, y: cumSaved[i] }));
  const opts = {
    chart: { type: "area", height: 200, ...BASE_CHART },
    series: [{ name: "Sigarette evitate", data }],
    colors: ["#10b981"],
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "gradient", gradient: { shadeIntensity: 0.6, opacityFrom: 0.4, opacityTo: 0 } },
    dataLabels: { enabled: false },
    grid: { borderColor: "rgba(216,196,196,0.3)", strokeDashArray: 4 },
    xaxis: {
      type: "datetime",
      labels: { format: "MMM 'yy", style: { fontSize: "10px", colors: "#5a4a4a" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { labels: { formatter: (v) => Math.round(v), style: { fontSize: "10px" } } },
    tooltip: {
      theme: "light",
      x: { format: "d MMM yyyy" },
      y: { formatter: (v) => `${Math.round(v)} sigarette evitate` },
    },
  };
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.saved = new ApexCharts(el, opts);
    charts.saved.render();
  });
}
