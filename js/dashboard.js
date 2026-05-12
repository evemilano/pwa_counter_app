import * as db from "./db.js";
import { toast, show, escapeHtml } from "./app.js";

export async function renderDashboard(root) {
  const counters = await db.listCounters();

  if (counters.length === 0) {
    root.innerHTML = `
      <div class="empty-card mt-12">
        <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
          <span class="material-symbols-outlined" style="font-size:48px">add_circle</span>
        </div>
        <h2 class="font-display font-bold text-xl mb-2">Crea il tuo primo contatore</h2>
        <p class="text-on-surface-variant text-sm mb-4">Inizia a contare qualunque cosa: caffè, flessioni, sigarette...</p>
        <button type="button" id="empty-add" class="bg-primary text-on-primary font-semibold px-5 py-3 rounded-full active:scale-95 transition-transform">
          Crea contatore
        </button>
      </div>`;
    root.querySelector("#empty-add").addEventListener("click", () => {
      document.getElementById("btn-menu").click();
    });
    return;
  }

  let activeId = db.getLastCounterId();
  if (activeId == null || !counters.find((c) => c.id === activeId)) {
    activeId = counters[0].id;
    db.setLastCounterId(activeId);
  }
  const active = counters.find((c) => c.id === activeId);

  const now = new Date();
  const todayStart = db.startOfDay(now);
  const todayEnd = db.endOfDay(now);
  const yStart = db.addDays(todayStart, -1);
  const yEnd = db.addDays(todayEnd, -1);
  const [todayTaps, yesterdayCount, latest] = await Promise.all([
    db.getTapsInRange(active.id, todayStart, todayEnd),
    db.countTapsInRange(active.id, yStart, yEnd),
    db.getLatestTap(active.id),
  ]);
  const todayCount = todayTaps.length;
  const diff = todayCount - yesterdayCount;
  const diffText = diff === 0
    ? "= rispetto a ieri"
    : `${diff > 0 ? "+" : ""}${diff} rispetto a ieri`;

  const target = Number(active.dailyTarget) || 0;
  const lastTimeText = latest ? formatTime(latest.timestamp) : "—";

  root.innerHTML = `
    <div class="text-center pt-4">
      <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-1">Oggi · ${escapeHtml(active.name)}</div>
      <div class="font-display text-counter-display-mobile sm:text-counter-display text-on-surface" id="big-total">${todayCount}</div>
    </div>

    <div class="flex justify-center mt-8 mb-3">
      <button type="button" id="btn-plus" class="btn-counter" aria-label="Aggiungi uno">
        <span class="material-symbols-outlined">add</span>
      </button>
    </div>

    <div class="text-center text-on-surface-variant text-sm mb-2" id="diff-text">${diffText}</div>

    <div class="flex justify-center mb-8">
      <button type="button" id="btn-undo" class="undo-floating ${todayCount === 0 ? "invisible" : ""}">
        <span class="material-symbols-outlined">undo</span>
        annulla ultimo
      </button>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="stat-card">
        <div class="flex items-center justify-between">
          <span class="material-symbols-outlined text-primary" style="font-size:20px">flag</span>
          ${target > 0 ? `<span class="text-xs font-semibold text-on-surface-variant">${Math.min(100, Math.round(todayCount / target * 100))}%</span>` : ""}
        </div>
        <div class="label mt-1">Target</div>
        <div class="value">${target > 0 ? target : "—"}</div>
      </div>
      <div class="stat-card">
        <span class="material-symbols-outlined text-primary" style="font-size:20px">schedule</span>
        <div class="label mt-1">Ultimo</div>
        <div class="value">${lastTimeText}</div>
      </div>
    </div>
  `;

  const btnPlus = root.querySelector("#btn-plus");
  const btnUndo = root.querySelector("#btn-undo");
  const totalEl = root.querySelector("#big-total");
  const diffEl = root.querySelector("#diff-text");

  btnPlus.addEventListener("click", async () => {
    await db.addTap(active.id);
    if (navigator.vibrate) navigator.vibrate(12);
    btnPlus.classList.remove("pop");
    void btnPlus.offsetWidth;
    btnPlus.classList.add("pop");
    const newCount = await db.countTapsInRange(active.id, todayStart, todayEnd);
    totalEl.textContent = String(newCount);
    const d = newCount - yesterdayCount;
    diffEl.textContent = d === 0 ? "= rispetto a ieri" : `${d > 0 ? "+" : ""}${d} rispetto a ieri`;
    btnUndo.classList.remove("invisible");
  });

  btnUndo.addEventListener("click", async () => {
    const removed = await db.removeLatestTap(active.id);
    if (!removed) { toast("Niente da rimuovere"); return; }
    if (navigator.vibrate) navigator.vibrate([8, 30, 8]);
    const newCount = await db.countTapsInRange(active.id, todayStart, todayEnd);
    totalEl.textContent = String(newCount);
    const d = newCount - yesterdayCount;
    diffEl.textContent = d === 0 ? "= rispetto a ieri" : `${d > 0 ? "+" : ""}${d} rispetto a ieri`;
    if (newCount === 0) btnUndo.classList.add("invisible");
  });
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
