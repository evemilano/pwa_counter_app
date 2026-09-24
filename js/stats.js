import * as db from "./db.js";
import { escapeHtml, show, bus } from "./app.js";
import ApexCharts from "https://esm.sh/apexcharts@3.54.1";
import * as sm from "./stats-math.js";

const PERIODS = [
  { id: "7d",   label: "7g",     long: "7 giorni" },
  { id: "30d",  label: "30g",    long: "30 giorni" },
  { id: "90d",  label: "90g",    long: "90 giorni" },
  { id: "year", label: "Anno",   long: "anno corrente" },
  { id: "all",  label: "Sempre", long: "da sempre" },
];

const state = {
  period: "30d",
  // Liste: voce selezionata nel filtro, per contatore (null = tutte le voci).
  itemByCounter: {},
};

let charts = { trend: null, heatmap: null, hourly: null, weekday: null, saved: null, ranking: null };
let tapsCache = { counterId: null, taps: null, fetchedAt: 0 };
const CACHE_TTL = 15_000;

// Colori primari del tema corrente (scelti a ogni apertura in index.html).
function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--primary${name ? "-" + name : ""}`).trim();
}

// La cache va invalidata a ogni mutazione, non solo per TTL: +1 dalla dashboard,
// delete in Cronologia o import da un pull remoto. Senza questo, entrando in
// Statistiche entro CACHE_TTL si rileggerebbe l'array stantio.
// Registrazione lazy (come sync.init): stats.js viene valutato prima di app.js
// per l'import circolare, quindi `bus` a top-level sarebbe in TDZ.
let busHooked = false;
function hookBus() {
  if (busHooked) return;
  busHooked = true;
  bus.addEventListener("data-changed", invalidateTapsCache);
}
function invalidateTapsCache() {
  tapsCache = { counterId: null, taps: null, fetchedAt: 0 };
}

function disposeCharts() {
  for (const k of Object.keys(charts)) {
    if (charts[k]) { try { charts[k].destroy(); } catch {} charts[k] = null; }
  }
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
  hookBus();
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
  if (db.isList(active)) return renderListStats(root, active);

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
        <div class="label mt-1">Streak migliore <span class="text-on-surface-variant/70 font-normal">· da sempre</span></div>
        <div class="value" id="kpi-streak">—</div>
        <div class="sub" id="kpi-streak-sub"></div>
      </div>
    </div>

    <!-- TREND chart -->
    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">
        Andamento/giorno
      </div>
      <div id="chart-trend" class="-mx-2" style="min-height:240px"></div>
      <div class="text-xs text-on-surface-variant mt-2 flex flex-wrap gap-3 items-center">
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:var(--primary)"></span>Giornaliero</span>
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
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Sigarette evitate · da sempre</div>
      <div id="chart-saved" class="-mx-2" style="min-height:200px"></div>
      <div class="text-xs text-on-surface-variant mt-2" id="saved-note"></div>
    </section>

    <!-- CONV cards -->
    <div class="grid grid-cols-1 gap-3 mt-4" id="conv-section">
      <div class="stat-card accent" id="conv-money-card">
        <span class="material-symbols-outlined deco">savings</span>
        <div class="label text-white/85"><span id="conv-money-title">Risparmio</span></div>
        <div class="value text-white"><span id="conv-money-saved">—</span></div>
        <div class="sub text-white/80" id="conv-money-period">—</div>
      </div>
      <div class="stat-card" id="conv-life-card">
        <span class="material-symbols-outlined" style="font-size:20px;color:#10b981">favorite</span>
        <div class="label mt-1"><span id="conv-life-title">Tempo di vita guadagnato</span></div>
        <div class="value" id="conv-life-value">—</div>
        <div class="sub" id="conv-life-sub">~11 min per sigaretta evitata (stima CDC)</div>
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

  // Storia COMPLETA dalla prima sigaretta. Serve a baseline, streak, trend, savings.
  const firstDay = sm.firstTapDay(taps) ?? today;
  const historicSeries = sm.buildDailySeries(taps, firstDay, today);

  // Baseline su intera storia
  const baseline = sm.computeBaseline(historicSeries, baselineOverride, target);

  // Periodo selezionato: lo span temporale che l'utente vuole vedere nei grafici.
  // Per dare contesto storico alle MA all'inizio del periodo anticipo l'inizio di
  // altri 29 giorni (così MA30 ha base). Entrambi i bordi sono clampati a
  // firstDay: fuori dalla finestra di osservazione non ci sono giorni, e
  // rappresentarli come 0 falserebbe medie, trend e confronti.
  const { from: rawPeriodFrom, to: periodTo } = sm.slicePeriod(historicSeries, state.period, today);
  const periodFrom = Math.max(rawPeriodFrom, firstDay);
  const computeFrom = Math.max(sm.startOfDayPlus(periodFrom, -29), firstDay);
  const series = sm.buildDailySeries(taps, computeFrom, today);

  // MA su series estesa (così l'inizio del periodo ha MA già stabile)
  const ma7Full = sm.computeMA(series, 7);
  const ma30Full = sm.computeMA(series, 30);

  // Slice = la coda di series corrispondente esattamente al periodo selezionato.
  // Cercato per valore e non calcolato come delta/DAY: series è una griglia di
  // mezzanotti locali, e attraverso un cambio d'ora i delta in ms non sono più
  // multipli esatti di un giorno.
  const foundIdx = series.findIndex((r) => r.day >= periodFrom);
  const sliceStartIdx = foundIdx === -1 ? series.length : foundIdx;
  const slice = series.slice(sliceStartIdx);
  const ma7Slice = ma7Full.slice(sliceStartIdx);
  const ma30Slice = ma30Full.slice(sliceStartIdx);

  const totalPeriod = slice.reduce((a, r) => a + r.n, 0);
  const daysInPeriod = slice.length;
  const avgPeriod = daysInPeriod > 0 ? totalPeriod / daysInPeriod : 0;
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

  // Trend sul periodo selezionato dalla pillola.
  const trend = sm.computeTrend(slice, { windowDays: slice.length, baseline: baseline.value || 0 });

  // Streak — la card dice "da sempre", quindi va sull'intera storia, non sulla
  // series del periodo selezionato (che la troncherebbe alla pillola attiva).
  const streak = sm.computeStreaks(historicSeries, target);
  const onTarget = sm.daysOnTarget(slice, target);

  // Confronto periodo vs precedente. Per "all" non esiste un "precedente",
  // quindi la comparazione viene saltata. Per gli altri periodi la finestra
  // equivalente prima di `periodFrom` viene costruita direttamente dai tap
  // (così funziona anche per 90d/year, che andavano oltre il buffer).
  const sliceLen = slice.length;
  let prevTotal = 0;
  let cmp = { direction: "flat", deltaPct: null, deltaAbs: 0 };
  const prevTo = sm.startOfDayPlus(periodFrom, -1);
  const prevFrom = sm.startOfDayPlus(prevTo, -(sliceLen - 1));
  // Confronto solo se la finestra precedente è interamente osservata: misurarsi
  // contro giorni antecedenti al primo tap significa misurarsi contro zeri finti.
  if (state.period !== "all" && prevFrom >= firstDay) {
    const prevSlice = sm.buildDailySeries(taps, prevFrom, prevTo);
    prevTotal = prevSlice.reduce((a, r) => a + r.n, 0);
    cmp = sm.compareSums(totalPeriod, prevTotal);
  }

  // Hourly / weekday — sui tap del periodo
  const sliceTaps = taps.filter((t) => {
    const d = startOfDayMsLocal(t.timestamp);
    return d >= periodFrom && d <= periodTo;
  });
  const hourBuckets = sm.bucketByHour(sliceTaps);
  const wdayBuckets = sm.bucketByWeekday(sliceTaps);
  const peakH = sm.peakHour(hourBuckets);
  const peakW = sm.peakWeekday(wdayBuckets);

  // Sigarette evitate: solo giorni CONCLUSI. Oggi ha un n ancora parziale —
  // contarlo darebbe +baseline a mezzanotte per poi calare a ogni tap, cioè una
  // curva cumulativa che scende. Oggi entra nel conteggio stanotte.
  // Base = intera storia (non la series estesa, che parte prima del periodo).
  const completedHistory = historicSeries.slice(0, -1);
  const completedSlice = slice.slice(0, -1);
  const totalSaved = baseline.value ? sm.savedCigarettesTotal(completedHistory, baseline.value) : 0;
  const savedInPeriod = baseline.value ? sm.savedCigarettesTotal(completedSlice, baseline.value) : 0;

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
  const periodLabel = PERIODS.find((p) => p.id === state.period)?.label || "";
  if (trend && Math.abs(trend.slope) > 0.05) {
    const perWeek = Math.round(trend.slope * 7 * 10) / 10;
    const word = perWeek < 0 ? "calando" : "aumentando";
    slopeEl.textContent = `Trend: ${word} di ~${Math.abs(perWeek)} sig/settimana (${periodLabel}, r²=${trend.r2.toFixed(2)})`;
  } else {
    slopeEl.textContent = trend ? `Trend stabile (${periodLabel})` : "Trend non ancora calcolabile";
  }

  root.querySelector("#kpi-total").textContent = sm.fmtNum(totalPeriod);
  const kpiTotalSub = root.querySelector("#kpi-total-sub");
  if (state.period === "all") {
    kpiTotalSub.textContent = "totale storico";
  } else if (cmp.deltaPct != null) {
    kpiTotalSub.textContent = `${cmp.deltaPct > 0 ? "+" : ""}${cmp.deltaPct}% vs precedente`;
  } else if (prevTotal === 0 && totalPeriod === 0) {
    kpiTotalSub.textContent = "—";
  } else {
    kpiTotalSub.textContent = "";
  }

  root.querySelector("#kpi-avg").textContent = sm.fmtNum(avgPeriod, 1);
  root.querySelector("#kpi-avg-sub").textContent = `su ${daysInPeriod} giorni tracciati`;

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

  // Conv cards — il valore "grande" è scoped al periodo; lifetime sta nel sub.
  // Quando il periodo è "all" i due coincidono → mostro solo lifetime senza sub redundante.
  const showHealth = localStorage.getItem("contaapp:showHealth") !== "false";
  const moneyCard = root.querySelector("#conv-money-card");
  const lifeCard = root.querySelector("#conv-life-card");
  const periodLong = PERIODS.find((p) => p.id === state.period)?.long || "periodo";
  const isAllPeriod = state.period === "all";
  const moneyTitleEl = root.querySelector("#conv-money-title");
  const lifeTitleEl = root.querySelector("#conv-life-title");
  const lifeSubEl = root.querySelector("#conv-life-sub");

  if (pricePerCig > 0 && baseline.value) {
    moneyCard.classList.remove("hidden");
    moneyTitleEl.textContent = isAllPeriod ? "Risparmio · da sempre" : `Risparmio · ${periodLong}`;
    if (isAllPeriod) {
      root.querySelector("#conv-money-saved").textContent = sm.fmtMoney(sm.moneySaved(totalSaved, pricePerCig));
      root.querySelector("#conv-money-period").textContent = "";
    } else {
      root.querySelector("#conv-money-saved").textContent = sm.fmtMoney(sm.moneySaved(savedInPeriod, pricePerCig));
      root.querySelector("#conv-money-period").textContent =
        `${sm.fmtMoney(sm.moneySaved(totalSaved, pricePerCig))} da sempre`;
    }
  } else if (pricePerCig > 0 && !baseline.value) {
    moneyCard.classList.remove("hidden");
    moneyTitleEl.textContent = "Risparmio";
    root.querySelector("#conv-money-saved").textContent = "—";
    root.querySelector("#conv-money-period").textContent = "Imposta una baseline per calcolare i risparmi";
  } else {
    moneyCard.classList.remove("hidden");
    moneyTitleEl.textContent = "Risparmio";
    root.querySelector("#conv-money-saved").textContent = "—";
    root.querySelector("#conv-money-period").innerHTML =
      `<button class="underline text-white" id="conv-money-cta">Imposta il prezzo per vederlo</button>`;
    const cta = root.querySelector("#conv-money-cta");
    if (cta) cta.addEventListener("click", () => show("settings"));
  }

  if (showHealth && baseline.value) {
    lifeCard.classList.remove("hidden");
    if (isAllPeriod) {
      lifeTitleEl.textContent = "Tempo di vita guadagnato · da sempre";
      root.querySelector("#conv-life-value").textContent = sm.formatLifeTime(sm.lifeRegained(totalSaved));
      lifeSubEl.textContent = "~11 min per sigaretta evitata (stima CDC)";
    } else {
      lifeTitleEl.textContent = `Tempo di vita guadagnato · ${periodLong}`;
      root.querySelector("#conv-life-value").textContent = sm.formatLifeTime(sm.lifeRegained(savedInPeriod));
      const lifetimeFmt = sm.formatLifeTime(sm.lifeRegained(totalSaved));
      lifeSubEl.textContent = `${lifetimeFmt} da sempre · ~11 min/sigaretta`;
    }
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

  // Saved section: serve una baseline e almeno un giorno concluso
  const canShowSaved = !!baseline.value && completedHistory.length > 0;
  const savedSection = root.querySelector("#saved-section");
  savedSection.classList.toggle("hidden", !canShowSaved);

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
  if (canShowSaved) {
    const histCumSaved = sm.savedCigarettesCumulative(completedHistory, baseline.value);
    drawSaved(root.querySelector("#chart-saved"), completedHistory, histCumSaved);
    root.querySelector("#saved-note").textContent =
      `Baseline: ${sm.fmtNum(baseline.value, 1)} sig/g (${labelBaselineSource(baseline.source)}) · totale evitate: ${sm.fmtNum(totalSaved)} · il giorno in corso viene conteggiato a fine giornata`;
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

function drawTrend(el, slice, ma7Slice, ma30Slice, target, unit = "sig") {
  if (charts.trend) { try { charts.trend.destroy(); } catch {} charts.trend = null; }
  if (!el || !el.isConnected) return;

  // Il giornaliero è denso: ogni giorno della finestra ha un valore (0 incluso).
  // Sulle MA filtriamo i null di inizio serie: con curve "smooth" ApexCharts non
  // disegna in modo affidabile i tratti che attraversano i null (anche con
  // connectNulls). L'asse datetime preserva comunque la spaziatura corretta.
  const daily = slice.map((r) => ({ x: r.day, y: r.n }));
  const ma7Data = slice
    .map((r, i) => ({ x: r.day, y: ma7Slice[i] }))
    .filter((p) => p.y != null);
  const ma30Data = slice
    .map((r, i) => ({ x: r.day, y: ma30Slice[i] }))
    .filter((p) => p.y != null);

  const hasDaily = daily.length > 0;
  const hasMA7 = ma7Data.length > 0;
  const hasMA30 = ma30Data.length > 0;

  const series = [];
  const colors = [];
  const widths = [];
  const curves = [];
  if (hasDaily) { series.push({ name: "Giornaliero", data: daily });  colors.push(themeColor()); widths.push(2); curves.push("straight"); }
  if (hasMA7)   { series.push({ name: "MA 7gg",      data: ma7Data }); colors.push("#10b981"); widths.push(3); curves.push("smooth");   }
  if (hasMA30)  { series.push({ name: "MA 30gg",     data: ma30Data });colors.push("#6366f1"); widths.push(2); curves.push("smooth");   }

  if (series.length === 0) {
    el.innerHTML = `<div class="text-center text-on-surface-variant text-sm py-12">Nessun dato nel periodo selezionato.</div>`;
    return;
  }

  const validCount = daily.length;
  const markerSize = validCount <= 10 ? 4 : 0;

  const opts = {
    chart: { type: "line", height: 240, ...BASE_CHART },
    series,
    stroke: { curve: curves, width: widths },
    colors,
    markers: { size: markerSize, hover: { size: markerSize + 2 } },
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
      y: { formatter: (v) => v == null ? "—" : `${Math.round(v * 10) / 10} ${unit}` },
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

function drawHeatmap(el, series, target, baselineValue, unit = "sig") {
  if (charts.heatmap) { try { charts.heatmap.destroy(); } catch {} charts.heatmap = null; }
  if (!el || !el.isConnected) return;

  // Costruisci griglia 7 (Lun-Dom) × N settimane (ultimi 52 + corrente)
  const today = series.length ? series[series.length - 1].day : db.startOfDay();
  // Trova il lunedì della settimana 52 fa. Tutta la griglia va costruita con
  // aritmetica di calendario: 53 settimane attraversano sempre almeno un cambio
  // d'ora, e con i multipli di 86.400.000 ms le celle successive cadrebbero alle
  // 01:00/23:00, mancando le chiavi (mezzanotte locale) della serie.
  const todayDate = new Date(today);
  const dow = (todayDate.getDay() + 6) % 7; // Lun=0
  const mondayThisWeek = sm.startOfDayPlus(today, -dow);
  const startMonday = sm.startOfDayPlus(mondayThisWeek, -52 * 7);
  // Mappa day -> n dalla serie
  const byDay = new Map();
  for (const r of series) byDay.set(r.day, r.n);
  // Costruisci serie per ApexCharts heatmap: una series per riga (giorno settimana)
  const rowNames = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  const seriesData = [];
  for (let r = 6; r >= 0; r--) {
    const data = [];
    for (let w = 0; w < 53; w++) {
      const dayTs = sm.startOfDayPlus(startMonday, w * 7 + r);
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
            { from: 0.5,  to: T * 0.5, color: themeColor("soft"), name: "lieve" },
            { from: T * 0.5 + 0.001, to: T,       color: themeColor("mid"), name: "vicino target" },
            { from: T + 0.001, to: T * 1.5,  color: themeColor(), name: "sopra target" },
            { from: T * 1.5 + 0.001, to: 99999,    color: themeColor("deep"), name: "molto sopra" },
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
      y: { formatter: (v) => v == null ? "—" : `${v} ${unit}` },
    },
  };

  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.heatmap = new ApexCharts(el, opts);
    charts.heatmap.render();
  });
}

function drawHourly(el, buckets, peakIdx, unit = "sig", seriesName = "Sigarette") {
  if (charts.hourly) { try { charts.hourly.destroy(); } catch {} charts.hourly = null; }
  if (!el || !el.isConnected) return;
  const colors = buckets.map((_, i) => i === peakIdx ? themeColor("deep") : themeColor());
  const opts = {
    chart: { type: "bar", height: 180, ...BASE_CHART },
    series: [{ name: seriesName, data: buckets }],
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
      y: { formatter: (v) => `${v} ${unit}` },
      x: { formatter: (v) => `${v}:00–${v}:59` },
    },
  };
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.hourly = new ApexCharts(el, opts);
    charts.hourly.render();
  });
}

function drawWeekday(el, buckets, peakIdx, unit = "sig", seriesName = "Sigarette") {
  if (charts.weekday) { try { charts.weekday.destroy(); } catch {} charts.weekday = null; }
  if (!el || !el.isConnected) return;
  const colors = buckets.map((_, i) => i === peakIdx ? themeColor("deep") : themeColor());
  const opts = {
    chart: { type: "bar", height: 160, ...BASE_CHART },
    series: [{ name: seriesName, data: buckets }],
    plotOptions: {
      bar: {
        columnWidth: "55%",
        borderRadius: 6,
        borderRadiusApplication: "end",
        distributed: true,
        dataLabels: { position: "top" },
      },
    },
    colors,
    legend: { show: false },
    dataLabels: {
      enabled: true,
      formatter: (v) => v > 0 ? v : "",
      offsetY: -16,
      style: { fontSize: "10px", colors: ["#1a1c1c"], fontWeight: 600 },
    },
    grid: { borderColor: "rgba(216,196,196,0.3)", strokeDashArray: 4, padding: { top: 14 } },
    xaxis: {
      categories: ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"],
      labels: { style: { fontSize: "11px", colors: "#5a4a4a" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { labels: { formatter: (v) => Math.round(v) }, tickAmount: 3 },
    tooltip: { theme: "light", y: { formatter: (v) => `${v} ${unit}` } },
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
      labels: {
        style: { fontSize: "10px", colors: "#5a4a4a" },
        datetimeUTC: false,
        datetimeFormatter: {
          year: "yyyy",
          month: "MMM 'yy",
          day: "d MMM",
          hour: "HH:mm",
        },
      },
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

/* ── LISTE (es. Amici) ───────────────────────────────────────
   Nessun concetto di sigarette/target/risparmio: conta gli incontri, per voce
   o per l'intera lista, con classifica e "da risentire". */

async function renderListStats(root, active) {
  const items = await db.listItems(active);
  if (items.length === 0) {
    root.innerHTML = `
      <div class="empty-card mt-12">
        <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
          <span class="material-symbols-outlined" style="font-size:48px">group</span>
        </div>
        <h2 class="font-display font-bold text-xl mb-2">${escapeHtml(active.name)} è vuota</h2>
        <p class="text-on-surface-variant text-sm">Aggiungi le voci dalla Dashboard e inizia a toccarle.</p>
      </div>`;
    return;
  }
  let selectedId = state.itemByCounter[active.id] ?? null;
  if (selectedId != null && !items.some((i) => i.id === selectedId)) selectedId = null;

  root.innerHTML = `
    <div class="pt-2 pb-2">
      <div class="text-on-surface-variant text-sm">Contatore</div>
      <div class="font-display font-bold text-2xl text-on-surface flex items-center gap-2">
        <span class="w-3 h-3 rounded-full" style="background:${active.color}"></span>
        ${escapeHtml(active.name)}
      </div>
      <select id="item-filter" aria-label="Filtra per voce"
        class="mt-2 w-full rounded-xl border border-outline-variant px-3 py-2.5 bg-surface-container-lowest text-on-surface font-semibold focus:outline-none focus:border-primary">
        <option value="">Tutte le voci (${items.length})</option>
        ${[...items].sort((a, b) => a.name.localeCompare(b.name, "it", { sensitivity: "base" }))
          .map((i) => `<option value="${i.id}" ${i.id === selectedId ? "selected" : ""}>${escapeHtml(i.name)}</option>`).join("")}
      </select>
    </div>

    <div class="flex justify-center my-3">
      <div class="period-pill" id="period-pill"></div>
    </div>

    <div class="grid grid-cols-2 gap-3 mt-1">
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">handshake</span>
        <div class="label mt-1">Incontri</div>
        <div class="value" id="l-total">0</div>
        <div class="sub" id="l-total-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">date_range</span>
        <div class="label mt-1">Media a settimana</div>
        <div class="value" id="l-week">0</div>
        <div class="sub" id="l-week-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px" id="l-c-icon">group</span>
        <div class="label mt-1" id="l-c-label">—</div>
        <div class="value truncate" id="l-c-value">—</div>
        <div class="sub" id="l-c-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px" id="l-d-icon">star</span>
        <div class="label mt-1" id="l-d-label">—</div>
        <div class="value truncate" id="l-d-value">—</div>
        <div class="sub" id="l-d-sub"></div>
      </div>
    </div>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4" id="ranking-section">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Classifica</div>
      <div id="chart-ranking" class="-mx-2"></div>
    </section>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4" id="stale-section">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Da risentire</div>
      <div id="stale-list" class="space-y-1"></div>
    </section>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Andamento/giorno</div>
      <div id="chart-trend" class="-mx-2" style="min-height:240px"></div>
      <div class="text-xs text-on-surface-variant mt-2 flex flex-wrap gap-3 items-center">
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:var(--primary)"></span>Giornaliero</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#10b981"></span>MA 7gg</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-full" style="background:#6366f1"></span>MA 30gg</span>
      </div>
    </section>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Calendario · ultimi 12 mesi</div>
      <div id="chart-heatmap" class="-mx-2" style="min-height:240px"></div>
    </section>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Distribuzione oraria</div>
      <div id="chart-hourly" class="-mx-2" style="min-height:190px"></div>
    </section>

    <section class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30 mt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Distribuzione per giorno settimana</div>
      <div id="chart-weekday" class="-mx-2" style="min-height:170px"></div>
    </section>

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

  const pillEl = root.querySelector("#period-pill");
  for (const p of PERIODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.className = p.id === state.period ? "active" : "";
    b.addEventListener("click", () => {
      if (state.period === p.id) return;
      state.period = p.id;
      pillEl.querySelectorAll("button").forEach((btn, i) =>
        btn.classList.toggle("active", PERIODS[i].id === state.period)
      );
      refreshList(root, active, items).catch(console.error);
    });
    pillEl.appendChild(b);
  }

  root.querySelector("#item-filter").addEventListener("change", (e) => {
    state.itemByCounter[active.id] = e.target.value ? Number(e.target.value) : null;
    refreshList(root, active, items).catch(console.error);
    // Il select non deve restare a fuoco: app.js rimanderebbe i re-render.
    e.target.blur();
  });

  await refreshList(root, active, items);
}

async function refreshList(root, active, items) {
  disposeCharts();
  const selectedId = state.itemByCounter[active.id] ?? null;
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) : null;
  const unit = "incontri";

  // Tap per voce (tutta la storia): servono a classifica, "da risentire" e serie.
  const perItem = await Promise.all(items.map(async (item) => ({ item, taps: await db.getAllTaps(item.id) })));
  const allTaps = selected
    ? perItem.find((p) => p.item.id === selected.id).taps
    : perItem.flatMap((p) => p.taps).sort((a, b) => a.timestamp - b.timestamp);

  const today = db.startOfDay();
  const firstDay = sm.firstTapDay(allTaps) ?? today;
  const historicSeries = sm.buildDailySeries(allTaps, firstDay, today);
  const { from: rawPeriodFrom, to: periodTo } = sm.slicePeriod(historicSeries, state.period, today);
  const periodFrom = Math.max(rawPeriodFrom, firstDay);
  const computeFrom = Math.max(sm.startOfDayPlus(periodFrom, -29), firstDay);
  const series = sm.buildDailySeries(allTaps, computeFrom, today);
  const ma7Full = sm.computeMA(series, 7);
  const ma30Full = sm.computeMA(series, 30);
  const foundIdx = series.findIndex((r) => r.day >= periodFrom);
  const sliceStartIdx = foundIdx === -1 ? series.length : foundIdx;
  const slice = series.slice(sliceStartIdx);

  const inPeriod = (t) => {
    const d = startOfDayMsLocal(t.timestamp);
    return d >= periodFrom && d <= periodTo;
  };
  const sliceTaps = allTaps.filter(inPeriod);
  const total = sliceTaps.length;
  const days = slice.length;
  const perWeek = days > 0 ? total / days * 7 : 0;

  // Confronto con la finestra precedente di pari durata (solo se interamente osservata).
  let cmp = { deltaPct: null };
  const prevTo = sm.startOfDayPlus(periodFrom, -1);
  const prevFrom = sm.startOfDayPlus(prevTo, -(days - 1));
  if (state.period !== "all" && prevFrom >= firstDay) {
    const prevTotal = sm.buildDailySeries(allTaps, prevFrom, prevTo).reduce((a, r) => a + r.n, 0);
    cmp = sm.compareSums(total, prevTotal);
  }

  root.querySelector("#l-total").textContent = sm.fmtNum(total);
  root.querySelector("#l-total-sub").textContent = state.period === "all"
    ? "totale storico"
    : cmp.deltaPct != null ? `${cmp.deltaPct > 0 ? "+" : ""}${cmp.deltaPct}% vs precedente` : "";
  root.querySelector("#l-week").textContent = sm.fmtNum(perWeek, 1);
  root.querySelector("#l-week-sub").textContent = `su ${days} giorni`;

  const now = Date.now();
  const ranking = perItem
    .map((p) => ({ item: p.item, n: p.taps.filter(inPeriod).length, last: p.taps.length ? p.taps[p.taps.length - 1].timestamp : null }))
    .sort((a, b) => b.n - a.n || (b.last || 0) - (a.last || 0));

  const setCard = (key, icon, label, value, sub) => {
    root.querySelector(`#l-${key}-icon`).textContent = icon;
    root.querySelector(`#l-${key}-label`).textContent = label;
    root.querySelector(`#l-${key}-value`).textContent = value;
    root.querySelector(`#l-${key}-sub`).textContent = sub;
  };
  if (selected) {
    const last = allTaps.length ? allTaps[allTaps.length - 1].timestamp : null;
    const activeDays = slice.filter((r) => r.n > 0).length;
    const rank = ranking.findIndex((r) => r.item.id === selected.id) + 1;
    setCard("c", "schedule", "Ultimo incontro", last ? daysAgoLabel(last, now) : "mai",
      last ? new Date(last).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }) : "");
    setCard("d", "leaderboard", "Posizione", total > 0 ? `#${rank}` : "—",
      `${activeDays} giorni con incontri`);
  } else {
    const seen = ranking.filter((r) => r.n > 0);
    setCard("c", "group", "Voci viste", `${seen.length}/${items.length}`, "nel periodo");
    setCard("d", "star", "Più frequente", seen[0] ? seen[0].item.name : "—",
      seen[0] ? `${seen[0].n} ${seen[0].n === 1 ? "incontro" : "incontri"}` : "");
  }

  // Classifica + "da risentire": hanno senso solo sull'intera lista.
  root.querySelector("#ranking-section").classList.toggle("hidden", !!selected);
  root.querySelector("#stale-section").classList.toggle("hidden", !!selected);
  if (!selected) {
    drawRanking(root.querySelector("#chart-ranking"), ranking.filter((r) => r.n > 0).slice(0, 15));
    const stale = [...ranking].sort((a, b) => (a.last ?? -Infinity) - (b.last ?? -Infinity)).slice(0, 5);
    root.querySelector("#stale-list").innerHTML = stale.map((r) => `
      <div class="flex items-center justify-between py-1.5">
        <span class="flex items-center gap-2 min-w-0">
          <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${r.item.color}"></span>
          <span class="font-semibold text-on-surface truncate">${escapeHtml(r.item.name)}</span>
        </span>
        <span class="text-sm text-on-surface-variant flex-shrink-0">${r.last ? daysAgoLabel(r.last, now) : "mai"}</span>
      </div>`).join("");
  }

  const hourBuckets = sm.bucketByHour(sliceTaps);
  const wdayBuckets = sm.bucketByWeekday(sliceTaps);
  const peakH = sm.peakHour(hourBuckets);
  const peakW = sm.peakWeekday(wdayBuckets);

  root.querySelector("#insight-text").textContent = pickListInsight({ selected, ranking, total, cmp, peakW, now });

  drawTrend(root.querySelector("#chart-trend"), slice, ma7Full.slice(sliceStartIdx), ma30Full.slice(sliceStartIdx), 0, unit);
  drawHeatmap(root.querySelector("#chart-heatmap"), historicSeries, 0, 0, unit);
  drawHourly(root.querySelector("#chart-hourly"), hourBuckets, peakH.hour, unit, "Incontri");
  drawWeekday(root.querySelector("#chart-weekday"), wdayBuckets, peakW.wday, unit, "Incontri");
}

function daysAgoLabel(ts, now) {
  const days = Math.round((db.startOfDay(new Date(now)) - db.startOfDay(new Date(ts))) / 86_400_000);
  if (days <= 0) return "oggi";
  if (days === 1) return "ieri";
  return `${days} giorni fa`;
}

function pickListInsight({ selected, ranking, total, cmp, peakW, now }) {
  const DAY = 86_400_000;
  if (selected) {
    const r = ranking.find((x) => x.item.id === selected.id);
    if (!r?.last) return `Non hai ancora registrato incontri con ${selected.name}.`;
    const days = Math.floor((now - r.last) / DAY);
    if (days >= 30) return `Sono passati ${days} giorni dall'ultima volta con ${selected.name}: forse è ora di farsi sentire.`;
    if (total > 0 && peakW.pct >= 0.3 && peakW.value >= 3) return `Con ${selected.name} ti vedi soprattutto di ${weekdayName(peakW.wday).toLowerCase()}.`;
    return `${selected.name}: ${total} ${total === 1 ? "incontro" : "incontri"} nel periodo.`;
  }
  if (total === 0) return "Nessun incontro registrato in questo periodo.";
  const forgotten = ranking.filter((r) => r.last && now - r.last >= 30 * DAY)
    .sort((a, b) => a.last - b.last)[0];
  if (forgotten) {
    return `Non senti ${forgotten.item.name} da ${Math.floor((now - forgotten.last) / DAY)} giorni.`;
  }
  const top = ranking[0];
  if (top && top.n > 0 && total >= 5 && top.n / total >= 0.4) {
    return `${top.item.name} vale il ${Math.round(top.n / total * 100)}% dei tuoi incontri nel periodo.`;
  }
  if (cmp.deltaPct != null && Math.abs(cmp.deltaPct) >= 20) {
    return cmp.deltaPct > 0
      ? `${cmp.deltaPct}% di incontri in più rispetto al periodo precedente.`
      : `${Math.abs(cmp.deltaPct)}% di incontri in meno rispetto al periodo precedente.`;
  }
  const never = ranking.filter((r) => !r.last);
  if (never.length) return `${never.length} ${never.length === 1 ? "voce non ha" : "voci non hanno"} ancora nessun incontro.`;
  return "Continua a registrare: più dati, più la classifica diventa affidabile.";
}

function drawRanking(el, rows) {
  if (charts.ranking) { try { charts.ranking.destroy(); } catch {} charts.ranking = null; }
  if (!el || !el.isConnected) return;
  if (rows.length === 0) {
    el.innerHTML = `<div class="text-center text-on-surface-variant text-sm py-8">Nessun incontro nel periodo selezionato.</div>`;
    return;
  }
  const opts = {
    chart: { type: "bar", height: Math.max(120, rows.length * 34 + 30), ...BASE_CHART },
    series: [{ name: "Incontri", data: rows.map((r) => r.n) }],
    plotOptions: {
      bar: {
        horizontal: true,
        barHeight: "70%",
        borderRadius: 4,
        borderRadiusApplication: "end",
        distributed: true,
        dataLabels: { position: "top" },
      },
    },
    colors: rows.map((r) => r.item.color),
    legend: { show: false },
    dataLabels: {
      enabled: true,
      offsetX: 18,
      style: { fontSize: "11px", colors: ["#1a1c1c"], fontWeight: 700 },
    },
    grid: { borderColor: "rgba(216,196,196,0.3)", strokeDashArray: 4, padding: { right: 24 } },
    xaxis: {
      categories: rows.map((r) => r.item.name),
      labels: { formatter: (v) => Math.round(v), style: { fontSize: "10px", colors: "#5a4a4a" } },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: { labels: { maxWidth: 120, style: { fontSize: "12px", colors: "#1a1c1c", fontWeight: 600 } } },
    tooltip: { theme: "light", y: { formatter: (v) => `${v} incontri` } },
  };
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    charts.ranking = new ApexCharts(el, opts);
    charts.ranking.render();
  });
}
