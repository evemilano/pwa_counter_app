import * as db from "./db.js";
import { escapeHtml } from "./app.js";
import ApexCharts from "https://esm.sh/apexcharts@3.54.1";

const PERIODS = [
  { id: "day",   label: "Giorno" },
  { id: "week",  label: "Settimana" },
  { id: "month", label: "Mese" },
  { id: "year",  label: "Anno" },
];

const state = {
  period: "day",
  offset: 0,
};

let chart = null;

export async function renderStats(root) {
  const counters = await db.listCounters();
  if (counters.length === 0) {
    root.innerHTML = `
      <div class="empty-card mt-12">
        <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
          <span class="material-symbols-outlined" style="font-size:48px">leaderboard</span>
        </div>
        <h2 class="font-display font-bold text-xl mb-2">Nessun dato</h2>
        <p class="text-on-surface-variant text-sm">Crea un contatore e fai qualche tap per vedere le statistiche.</p>
      </div>`;
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  let activeId = db.getLastCounterId();
  if (activeId == null || !counters.find((c) => c.id === activeId)) {
    activeId = counters[0].id;
    db.setLastCounterId(activeId);
  }
  const active = counters.find((c) => c.id === activeId);

  root.innerHTML = `
    <div class="pt-2 pb-2">
      <div class="text-on-surface-variant text-sm">Contatore</div>
      <div class="font-display font-bold text-2xl text-on-surface flex items-center gap-2">
        <span class="w-3 h-3 rounded-full" style="background:${active.color}"></span>
        ${escapeHtml(active.name)}
      </div>
    </div>

    <div class="flex justify-center my-3">
      <div class="period-pill" id="period-pill"></div>
    </div>

    <div class="period-nav">
      <button type="button" id="nav-prev" aria-label="Periodo precedente">
        <span class="material-symbols-outlined" style="font-size:20px">chevron_left</span>
      </button>
      <span class="range" id="range-label">—</span>
      <button type="button" id="nav-next" aria-label="Periodo successivo">
        <span class="material-symbols-outlined" style="font-size:20px">chevron_right</span>
      </button>
    </div>

    <div class="bg-surface-container-lowest rounded-2xl p-4 border border-outline-variant/30">
      <div class="flex items-end justify-between mb-2">
        <div>
          <div class="text-label-caps uppercase tracking-widest text-on-surface-variant" id="period-title">PERIODO</div>
          <div class="font-display font-bold text-4xl text-primary" id="period-total">0</div>
        </div>
        <div class="text-sm text-on-surface-variant" id="period-compare"></div>
      </div>
      <div id="chart" class="-mx-2"></div>
    </div>

    <div class="mt-4 stat-card accent">
      <span class="material-symbols-outlined deco">history_toggle_off</span>
      <div class="label">Totale periodo</div>
      <div class="value text-white" id="kpi-total">0</div>
    </div>

    <div class="grid grid-cols-2 gap-3 mt-3">
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">trending_up</span>
        <div class="label mt-1">Media</div>
        <div class="value" id="kpi-avg">0</div>
        <div class="text-xs text-on-surface-variant mt-1" id="kpi-avg-sub"></div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">star</span>
        <div class="label mt-1">Record</div>
        <div class="value" id="kpi-peak">0</div>
        <div class="text-xs text-on-surface-variant mt-1" id="kpi-peak-sub"></div>
      </div>
    </div>

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
      state.offset = 0;
      renderStats(root);
    });
    pillEl.appendChild(b);
  }

  root.querySelector("#nav-prev").addEventListener("click", () => {
    state.offset -= 1;
    refresh(root, active);
  });
  root.querySelector("#nav-next").addEventListener("click", () => {
    if (state.offset >= 0) return;
    state.offset += 1;
    refresh(root, active);
  });

  await refresh(root, active);
}

async function refresh(root, counter) {
  const next = root.querySelector("#nav-next");
  next.disabled = state.offset >= 0;

  const { from, to, labels, values, rangeLabel, periodTitle, compareText, summary, insight } = await buildPeriod(counter.id, state.period, state.offset);

  root.querySelector("#range-label").textContent = rangeLabel;
  root.querySelector("#period-title").textContent = periodTitle;
  const total = values.reduce((a, b) => a + b, 0);
  root.querySelector("#period-total").textContent = total.toLocaleString("it-IT");
  root.querySelector("#period-compare").textContent = compareText;
  root.querySelector("#kpi-total").textContent = total.toLocaleString("it-IT");
  root.querySelector("#kpi-avg").textContent = summary.avg;
  root.querySelector("#kpi-avg-sub").textContent = summary.avgSub;
  root.querySelector("#kpi-peak").textContent = summary.peak;
  root.querySelector("#kpi-peak-sub").textContent = summary.peakSub;
  root.querySelector("#insight-text").textContent = insight;

  drawChart(root.querySelector("#chart"), labels, values, counter.color);
}

async function buildPeriod(counterId, period, offset) {
  const now = new Date();
  let from, to, labels, values, rangeLabel, periodTitle, compareText, summary, insight;

  if (period === "day") {
    const ref = new Date(db.startOfDay(now));
    ref.setDate(ref.getDate() + offset);
    from = db.startOfDay(ref);
    to = db.endOfDay(ref);
    const taps = await db.getTapsInRange(counterId, from, to);
    values = new Array(24).fill(0);
    for (const t of taps) values[new Date(t.timestamp).getHours()]++;
    labels = values.map((_, i) => String(i).padStart(2, "0"));

    const prevTaps = await db.countTapsInRange(counterId, db.addDays(from, -1), db.addDays(to, -1));
    rangeLabel = offset === 0 ? "Oggi" : offset === -1 ? "Ieri" : formatDate(ref);
    periodTitle = "OGGI";
    compareText = relCompare(taps.length, prevTaps, "ieri");

    const peakIdx = argmax(values);
    summary = {
      avg: average(values.filter(v => v > 0)) || 0,
      avgSub: "per ora attiva",
      peak: peakIdx >= 0 ? `${String(peakIdx).padStart(2, "0")}:00` : "—",
      peakSub: peakIdx >= 0 ? `${values[peakIdx]} tap` : "",
    };
    insight = makeInsight(values, "ora");
  }
  else if (period === "week") {
    const ref = new Date(db.startOfWeek(now));
    ref.setDate(ref.getDate() + offset * 7);
    from = db.startOfWeek(ref);
    to = db.addDays(from, 7);
    const taps = await db.getTapsInRange(counterId, from, to);
    values = new Array(7).fill(0);
    for (const t of taps) {
      const d = new Date(t.timestamp);
      values[(d.getDay() || 7) - 1]++;
    }
    labels = ["L", "M", "M", "G", "V", "S", "D"];

    const prevTaps = await db.countTapsInRange(counterId, db.addDays(from, -7), from);
    const fromD = new Date(from), toD = new Date(to - 1);
    rangeLabel = `${fromD.getDate()}–${toD.getDate()} ${monthShort(toD)}`;
    periodTitle = offset === 0 ? "SETTIMANA CORRENTE" : "SETTIMANA";
    compareText = relCompare(taps.length, prevTaps, "settimana scorsa");

    summary = {
      avg: Math.round(taps.length / 7 * 10) / 10,
      avgSub: "tap / giorno",
      peak: Math.max(...values).toString(),
      peakSub: dayName(argmax(values)),
    };
    insight = makeInsight(values, "giorno");
  }
  else if (period === "month") {
    const ref = new Date(now);
    ref.setDate(1);
    ref.setMonth(ref.getMonth() + offset);
    from = db.startOfMonth(ref);
    const refNext = new Date(ref); refNext.setMonth(refNext.getMonth() + 1);
    to = db.startOfMonth(refNext);
    const taps = await db.getTapsInRange(counterId, from, to);
    const days = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
    values = new Array(days).fill(0);
    for (const t of taps) values[new Date(t.timestamp).getDate() - 1]++;
    labels = values.map((_, i) => (i + 1) % 5 === 0 || i === 0 ? String(i + 1) : "");

    const prevRef = new Date(ref); prevRef.setMonth(prevRef.getMonth() - 1);
    const prevFrom = db.startOfMonth(prevRef);
    const prevTaps = await db.countTapsInRange(counterId, prevFrom, from);
    rangeLabel = `${monthLong(ref)} ${ref.getFullYear()}`;
    periodTitle = offset === 0 ? "MESE CORRENTE" : "MESE";
    compareText = relCompare(taps.length, prevTaps, "mese scorso");

    const peakIdx = argmax(values);
    summary = {
      avg: Math.round(taps.length / days * 10) / 10,
      avgSub: "tap / giorno",
      peak: Math.max(...values).toString(),
      peakSub: peakIdx >= 0 ? `giorno ${peakIdx + 1}` : "",
    };
    insight = makeInsight(values, "giorno");
  }
  else {
    const ref = new Date(now);
    ref.setFullYear(ref.getFullYear() + offset);
    from = db.startOfYear(ref);
    const refNext = new Date(ref); refNext.setFullYear(refNext.getFullYear() + 1);
    to = db.startOfYear(refNext);
    const taps = await db.getTapsInRange(counterId, from, to);
    values = new Array(12).fill(0);
    for (const t of taps) values[new Date(t.timestamp).getMonth()]++;
    labels = ["G", "F", "M", "A", "M", "G", "L", "A", "S", "O", "N", "D"];

    const prevFrom = db.startOfYear(new Date(ref.getFullYear() - 1, 0, 1));
    const prevTaps = await db.countTapsInRange(counterId, prevFrom, from);
    rangeLabel = `${ref.getFullYear()}`;
    periodTitle = offset === 0 ? "ANNO CORRENTE" : "ANNO";
    compareText = relCompare(taps.length, prevTaps, "anno scorso");

    const peakIdx = argmax(values);
    summary = {
      avg: Math.round(taps.length / 12 * 10) / 10,
      avgSub: "tap / mese",
      peak: Math.max(...values).toString(),
      peakSub: peakIdx >= 0 ? monthLong(new Date(2024, peakIdx, 1)) : "",
    };
    insight = makeInsight(values, "mese");
  }

  return { from, to, labels, values, rangeLabel, periodTitle, compareText, summary, insight };
}

function drawChart(el, labels, values, color) {
  const max = Math.max(...values, 1);
  const peakIdx = argmax(values);

  const colors = values.map((_, i) =>
    i === peakIdx ? color : "rgba(216,196,196,0.5)"
  );

  const opts = {
    chart: {
      type: "bar",
      height: 220,
      toolbar: { show: false },
      animations: { enabled: true, speed: 220, easing: "easeOutCubic" },
      fontFamily: "Inter, system-ui, sans-serif",
      foreColor: "#5a4a4a",
      parentHeightOffset: 0,
    },
    plotOptions: {
      bar: {
        columnWidth: "65%",
        borderRadius: 6,
        borderRadiusApplication: "end",
        distributed: true,
        dataLabels: { position: "top" },
      },
    },
    colors,
    legend: { show: false },
    grid: {
      show: true,
      borderColor: "rgba(216,196,196,0.3)",
      strokeDashArray: 4,
      yaxis: { lines: { show: true } },
      xaxis: { lines: { show: false } },
      padding: { top: 10, right: 0, bottom: 0, left: 0 },
    },
    dataLabels: {
      enabled: true,
      enabledOnSeries: [0],
      formatter: (v, { dataPointIndex }) =>
        dataPointIndex === peakIdx && v > 0 ? v : "",
      offsetY: -22,
      style: {
        fontSize: "11px",
        fontWeight: 700,
        colors: ["#ffffff"],
      },
      background: {
        enabled: true,
        foreColor: "#ffffff",
        padding: 4,
        borderRadius: 6,
        borderWidth: 0,
        opacity: 1,
        dropShadow: { enabled: false },
        backgroundColor: color,
      },
    },
    tooltip: {
      enabled: true,
      theme: "light",
      x: { show: false },
      y: { formatter: (v) => `${v} tap` },
    },
    xaxis: {
      categories: labels,
      labels: {
        style: { fontSize: "11px", colors: "#5a4a4a" },
        rotate: 0,
        hideOverlappingLabels: true,
      },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: {
      show: true,
      max: Math.ceil(max * 1.15),
      tickAmount: 3,
      labels: {
        style: { fontSize: "11px", colors: "#5a4a4a" },
        formatter: (v) => Math.round(v),
      },
    },
    series: [{ name: "Tap", data: values }],
    states: {
      hover: { filter: { type: "lighten", value: 0.05 } },
      active: { filter: { type: "darken", value: 0.1 } },
    },
  };

  if (chart) { chart.destroy(); chart = null; }
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    chart = new ApexCharts(el, opts);
    chart.render();
  });
}

function relCompare(curr, prev, label) {
  if (prev === 0 && curr === 0) return `nessun dato vs ${label}`;
  if (prev === 0) return `${curr} tap (${label}: 0)`;
  const pct = Math.round((curr - prev) / prev * 100);
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}% vs ${label}`;
}

function makeInsight(values, unit) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return "Ancora nessun tap in questo periodo. Inizia col primo!";
  const peak = argmax(values);
  if (unit === "ora") {
    return `Sei più attivo intorno alle ${String(peak).padStart(2, "0")}:00 con ${values[peak]} tap.`;
  }
  if (unit === "giorno") {
    return `Picco di ${values[peak]} tap. Stai mantenendo una buona regolarità.`;
  }
  return `Mese di punta: ${values[peak]} tap.`;
}

function argmax(arr) {
  let m = -Infinity, idx = -1;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) { m = arr[i]; idx = i; }
  return m > 0 ? idx : -1;
}
function average(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10;
}
function dayName(idx) {
  return ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"][idx] || "";
}
function monthShort(d) {
  return ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"][d.getMonth()];
}
function monthLong(d) {
  return ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"][d.getMonth()];
}
function formatDate(d) {
  return `${d.getDate()} ${monthShort(d)} ${d.getFullYear()}`;
}
