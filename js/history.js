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

  root.querySelectorAll("[data-edit-tap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".history-row");
      root.querySelectorAll(".history-row.editing").forEach((r) => {
        if (r !== row) r.classList.remove("editing");
      });
      row.classList.add("editing");
      const timeInput = row.querySelector(".edit-time");
      setTimeout(() => timeInput?.focus(), 0);
    });
  });

  root.querySelectorAll(".edit-time").forEach((input) => {
    input.addEventListener("input", () => {
      const raw = input.value.replace(/[^\d]/g, "").slice(0, 4);
      if (raw.length <= 2) input.value = raw;
      else input.value = raw.slice(0, 2) + ":" + raw.slice(2);
    });
  });

  root.querySelectorAll("[data-edit-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".history-row");
      const dateInput = row.querySelector(".edit-date");
      const timeInput = row.querySelector(".edit-time");
      if (dateInput) dateInput.value = dateInput.defaultValue;
      if (timeInput) timeInput.value = timeInput.defaultValue;
      row.classList.remove("editing");
    });
  });

  root.querySelectorAll("[data-edit-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".history-row");
      const dateInput = row.querySelector(".edit-date");
      const timeInput = row.querySelector(".edit-time");
      const id = Number(btn.dataset.editSave);
      const newTs = parseEditedDateTime(dateInput?.value, timeInput?.value);
      if (newTs == null) { toast("Orario non valido (HH:MM in 24h)"); return; }
      await db.updateTapTimestamp(id, newTs);
      toast("Orario aggiornato");
      notifyDataChanged();
    });
  });
}

function parseEditedDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeStr);
  if (!dm || !tm) return null;
  const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), 0, 0);
  const ts = d.getTime();
  return Number.isFinite(ts) ? ts : null;
}

function toEditValues(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
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
    const edit = toEditValues(t.timestamp);
    return `
      <div class="history-row ${badgeColor}" data-row-tap="${t.id}">
        <div class="history-row-view">
          <div class="flex items-center gap-3 min-w-0">
            <div class="badge">
              <span class="material-symbols-outlined" style="font-size:22px">${muted ? "history" : "add_circle"}</span>
            </div>
            <div class="min-w-0">
              <div class="time">${time}</div>
              <div class="label">Incremento</div>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="edit" data-edit-tap="${t.id}" aria-label="Modifica orario tap">
              <span class="material-symbols-outlined">edit</span>
            </button>
            <button type="button" class="del" data-delete-tap="${t.id}" aria-label="Elimina tap">
              <span class="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>
        <div class="history-row-edit">
          <label class="edit-label">Modifica data e ora (formato 24h)</label>
          <div class="edit-fields">
            <input type="date" class="edit-date" value="${edit.date}" aria-label="Data">
            <input type="text" class="edit-time" value="${edit.time}" inputmode="numeric"
              maxlength="5" placeholder="HH:MM" pattern="^([01]\\d|2[0-3]):[0-5]\\d$"
              aria-label="Ora in formato 24h">
          </div>
          <div class="edit-actions">
            <button type="button" class="btn-cancel" data-edit-cancel>Annulla</button>
            <button type="button" class="btn-save" data-edit-save="${t.id}">Salva</button>
          </div>
        </div>
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
