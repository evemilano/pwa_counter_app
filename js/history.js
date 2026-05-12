import * as db from "./db.js";
import { toast, notifyDataChanged, escapeHtml } from "./app.js";

export async function renderHistory(root) {
  const counters = await db.listCounters();
  if (counters.length === 0) {
    root.innerHTML = `
      <div class="empty-card mt-12">
        <div class="w-20 h-20 mx-auto mb-4 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
          <span class="material-symbols-outlined" style="font-size:48px">history</span>
        </div>
        <h2 class="font-display font-bold text-xl mb-2">Nessuna cronologia</h2>
        <p class="text-on-surface-variant text-sm">Crea un contatore per iniziare a registrare i tap.</p>
      </div>`;
    return;
  }

  let activeId = db.getLastCounterId();
  if (activeId == null || !counters.find((c) => c.id === activeId)) {
    activeId = counters[0].id;
    db.setLastCounterId(activeId);
  }
  const active = counters.find((c) => c.id === activeId);

  const all = await db.getAllTaps(active.id);
  all.reverse();
  const groups = groupByDay(all);

  const summary = `
    <div class="pt-2">
      <div class="text-on-surface-variant text-sm">Contatore</div>
      <div class="font-display font-bold text-2xl text-on-surface flex items-center gap-2 mb-1">
        <span class="w-3 h-3 rounded-full" style="background:${active.color}"></span>
        ${escapeHtml(active.name)}
      </div>
      <p class="text-on-surface-variant text-sm">Cronologia di tutti i tap registrati</p>
    </div>
  `;

  if (groups.length === 0) {
    root.innerHTML = `
      ${summary}
      <div class="empty-card mt-8">
        <h4 class="font-bold text-on-surface mb-1">Nulla qui</h4>
        <p class="text-on-surface-variant text-sm">Vai sulla Dashboard e premi +.</p>
      </div>`;
    return;
  }

  const sections = groups.map((g, idx) => sectionHtml(g, idx === 0, idx === 1)).join("");

  root.innerHTML = `
    ${summary}
    ${sections}
    <div class="empty-card mt-6">
      <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-primary-fixed/60 flex items-center justify-center text-primary">
        <span class="material-symbols-outlined" style="font-size:32px">local_fire_department</span>
      </div>
      <h4 class="font-bold text-on-surface">Cronologia</h4>
      <p class="text-on-surface-variant text-sm mt-1">Ogni tap registrato qui ti aiuta a vedere il tuo ritmo giornaliero.</p>
    </div>
  `;

  root.querySelectorAll("[data-delete-tap]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.deleteTap);
      await db.deleteTap(id);
      toast("Rimosso");
      notifyDataChanged();
    });
  });
}

function groupByDay(taps) {
  const map = new Map();
  for (const t of taps) {
    const d = new Date(t.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!map.has(key)) map.set(key, { key, date: d, items: [] });
    map.get(key).items.push(t);
  }
  return [...map.values()].sort((a, b) => b.date - a.date);
}

function sectionHtml(group, isToday, isYesterday) {
  const todayStart = startOfDay(new Date());
  const yStart = todayStart - 86400000;
  const gStart = startOfDay(group.date);
  let title;
  if (gStart === todayStart) title = "Oggi";
  else if (gStart === yStart) title = "Ieri";
  else title = formatDate(group.date);

  const muted = gStart < yStart;
  const badgeColor = muted ? "muted" : "";

  const rows = group.items.map((t) => {
    const time = formatTime(t.timestamp);
    return `
      <div class="history-row ${badgeColor}">
        <div class="flex items-center gap-3 min-w-0">
          <div class="badge">
            <span class="material-symbols-outlined" style="font-size:22px">${muted ? "history" : "add_circle"}</span>
          </div>
          <div class="min-w-0">
            <div class="time">${time}</div>
            <div class="label">Incremento</div>
          </div>
        </div>
        <button type="button" class="del" data-delete-tap="${t.id}" aria-label="Elimina tap">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>`;
  }).join("");

  return `
    <section class="mt-6">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant">${title}</h3>
        <span class="text-label-caps ${muted ? "bg-surface-container text-on-surface-variant" : "bg-primary-fixed text-primary"} px-3 py-1 rounded-full">${group.items.length} tap</span>
      </div>
      <div class="space-y-2">${rows}</div>
    </section>
  `;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function formatDate(d) {
  const months = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
