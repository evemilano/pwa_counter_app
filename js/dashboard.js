import * as db from "./db.js";
import { toast, show, escapeHtml, notifyDataChanged } from "./app.js";

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
  if (db.isList(active)) return renderListDashboard(root, active);

  const now = new Date();
  const todayStart = db.startOfDay(now);
  const todayEnd = db.endOfDay(now);
  // Bordi di "ieri" per calendario. Il giorno prima va ricavato da todayStart e
  // rinormalizzato: nei fusi in cui il DST scatta a mezzanotte (America/Santiago…)
  // quella mezzanotte non esiste, e il solo addDays lascerebbe i bordi sfasati di
  // un'ora, tagliando o duplicando i tap di confine. yEnd = todayStart - 1 chiude
  // esattamente contro l'inizio di oggi, senza buchi.
  const yStart = db.startOfDay(new Date(db.addDays(todayStart, -1)));
  const yEnd = todayStart - 1;
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
    try {
      await db.addTap(active.id);
    } catch (err) {
      console.error("[dashboard] addTap fallito:", err);
      if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
      toast("⚠ Tap NON salvato, riprova", 4000);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(12);
    btnPlus.classList.remove("pop");
    void btnPlus.offsetWidth;
    btnPlus.classList.add("pop");
    // Vista renderizzata prima di mezzanotte: il tap è salvato con l'ora giusta,
    // ma i bordi "oggi/ieri" sono vecchi. Ri-renderizza tutto invece di contare
    // nell'intervallo sbagliato.
    if (db.startOfDay() !== todayStart) {
      notifyDataChanged();
      return;
    }
    const newCount = await db.countTapsInRange(active.id, todayStart, todayEnd);
    totalEl.textContent = String(newCount);
    const d = newCount - yesterdayCount;
    diffEl.textContent = d === 0 ? "= rispetto a ieri" : `${d > 0 ? "+" : ""}${d} rispetto a ieri`;
    btnUndo.classList.remove("invisible");
    // C1: schedula sync push senza distruggere l'animazione/il focus locale.
    notifyDataChanged({ skipViewRefresh: true });
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
    notifyDataChanged({ skipViewRefresh: true });
  });
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/* ── Contatore di tipo lista (es. Amici) ─────────────────────── */

// Modalità modifica (rinomina/elimina voci) della lista attiva. È solo stato di
// UI: sopravvive ai re-render ma si azzera cambiando contatore.
let editState = { counterId: null, on: false };

async function renderListDashboard(root, active) {
  if (editState.counterId !== active.id) editState = { counterId: active.id, on: false };
  const editing = editState.on;

  root.innerHTML = `
    <div class="pt-2 flex items-end justify-between gap-3">
      <div class="min-w-0">
        <div class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-1 truncate">Oggi · ${escapeHtml(active.name)}</div>
        <div class="font-display font-bold text-5xl text-on-surface" id="list-today">0</div>
        <div class="text-on-surface-variant text-sm mt-1" id="list-summary">&nbsp;</div>
      </div>
      <button type="button" id="btn-edit-items"
        class="flex items-center gap-1 text-primary font-semibold px-3 py-2 rounded-full active:scale-95 transition-transform ${editing ? "bg-primary-fixed" : ""}">
        <span class="material-symbols-outlined" style="font-size:20px">${editing ? "check" : "edit"}</span>
        ${editing ? "Fine" : "Modifica"}
      </button>
    </div>

    <div id="item-list" class="space-y-2 mt-5"></div>

    <div class="flex justify-center mt-4">
      <button type="button" id="btn-undo" class="undo-floating invisible">
        <span class="material-symbols-outlined">undo</span>
        annulla ultimo
      </button>
    </div>

    <div class="flex gap-2 mt-4">
      <input type="text" id="new-item" placeholder="Aggiungi a ${escapeHtml(active.name)}" maxlength="40" autocomplete="off"
        class="flex-1 min-w-0 rounded-xl border border-outline-variant px-3 py-2.5 bg-surface-container-lowest text-on-surface focus:outline-none focus:border-primary">
      <button type="button" id="btn-add-item"
        class="bg-primary text-on-primary px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
        Aggiungi
      </button>
    </div>
  `;

  const listEl = root.querySelector("#item-list");
  const btnUndo = root.querySelector("#btn-undo");
  let dayStart = db.startOfDay();

  async function refreshList(poppedId = null) {
    const now = Date.now();
    const todayStart = db.startOfDay();
    const weekStart = db.startOfWeek();
    const monthStart = db.startOfMonth();
    const items = await db.listItems(active);
    const rows = await Promise.all(items.map(async (item) => {
      const taps = await db.getAllTaps(item.id);
      let month = 0;
      for (const t of taps) if (t.timestamp >= monthStart) month++;
      return { item, total: taps.length, month, last: taps.length ? taps[taps.length - 1].timestamp : null, taps };
    }));
    rows.sort((a, b) =>
      b.total - a.total ||
      (b.last || 0) - (a.last || 0) ||
      a.item.name.localeCompare(b.item.name, "it", { sensitivity: "base" })
    );

    let today = 0, week = 0, month = 0;
    for (const r of rows) {
      for (const t of r.taps) {
        if (t.timestamp >= todayStart) today++;
        if (t.timestamp >= weekStart) week++;
        if (t.timestamp >= monthStart) month++;
      }
    }
    root.querySelector("#list-today").textContent = String(today);
    root.querySelector("#list-summary").textContent = `${week} questa settimana · ${month} questo mese`;
    btnUndo.classList.toggle("invisible", editing || !rows.some((r) => r.total > 0));

    if (rows.length === 0) {
      listEl.innerHTML = `
        <div class="empty-card">
          <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
            <span class="material-symbols-outlined" style="font-size:36px">group_add</span>
          </div>
          <h4 class="font-bold text-on-surface mb-1">Lista vuota</h4>
          <p class="text-on-surface-variant text-sm">Aggiungi la prima voce qui sotto, poi toccala ogni volta che la vedi o la senti.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = rows.map((r, i) => editing ? editRowHtml(r) : itemRowHtml(r, i, now)).join("");

    if (editing) {
      listEl.querySelectorAll("[data-rename-item]").forEach((input) => {
        const id = Number(input.dataset.renameItem);
        let original = input.value;
        input.addEventListener("blur", async () => {
          const v = input.value.trim();
          if (!v) { input.value = original; return; }
          if (v === original) return;
          const dup = (await db.listItems(active)).find((x) => x.id !== id && db.nameKey(x) === db.nameKey({ name: v, parentUid: active.uid }));
          if (dup) { toast(`Esiste già: ${dup.name}`); input.value = original; return; }
          await db.renameCounter(id, v);
          original = v;
          toast("Rinominato");
          notifyDataChanged();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") input.blur();
          if (e.key === "Escape") { input.value = original; input.blur(); }
        });
      });
      listEl.querySelectorAll("[data-delete-item]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = Number(btn.dataset.deleteItem);
          const r = rows.find((x) => x.item.id === id);
          const msg = r.total > 0
            ? `Eliminare "${r.item.name}" e i suoi ${r.total} tap?\nNon recuperabile.`
            : `Eliminare "${r.item.name}"?`;
          if (!confirm(msg)) return;
          await db.deleteCounter(id);
          toast("Eliminato");
          notifyDataChanged();
        });
      });
      return;
    }

    listEl.querySelectorAll("[data-tap-item]").forEach((btn) => {
      btn.addEventListener("click", () => onTapItem(Number(btn.dataset.tapItem), rows));
    });

    if (poppedId != null) {
      const el = listEl.querySelector(`[data-tap-item="${poppedId}"]`);
      if (el) {
        el.classList.add("pop");
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  async function onTapItem(itemId, rows) {
    const item = rows.find((r) => r.item.id === itemId)?.item;
    if (!item) return;
    try {
      await db.addTap(item.id);
    } catch (err) {
      console.error("[dashboard] addTap fallito:", err);
      if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
      toast("⚠ Tap NON salvato, riprova", 4000);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(12);
    toast(`+1 · ${item.name}`);
    if (db.startOfDay() !== dayStart) {
      notifyDataChanged();
      return;
    }
    await refreshList(item.id);
    // C1: aggiornato in-place, schedula solo la sync.
    notifyDataChanged({ skipViewRefresh: true });
  }

  btnUndo.addEventListener("click", async () => {
    const removed = await db.removeLatestTapFor(active);
    if (!removed) { toast("Niente da rimuovere"); return; }
    if (navigator.vibrate) navigator.vibrate([8, 30, 8]);
    const item = await db.getCounter(removed.counterId);
    toast(`Annullato${item ? ` · ${item.name}` : ""}`);
    dayStart = db.startOfDay();
    await refreshList();
    notifyDataChanged({ skipViewRefresh: true });
  });

  root.querySelector("#btn-edit-items").addEventListener("click", () => {
    editState.on = !editState.on;
    renderListDashboard(root, active);
  });

  const input = root.querySelector("#new-item");
  const doAdd = async () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    try {
      const item = await db.addItem(active, v);
      input.value = "";
      toast(`Aggiunto: ${item.name}`);
    } catch (e) {
      toast(e.code === "DUPLICATE_NAME" ? `Esiste già: ${e.existing.name}` : (e.message || "Errore"));
      return;
    }
    input.blur();
    notifyDataChanged();
  };
  root.querySelector("#btn-add-item").addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });

  await refreshList();
}

function itemRowHtml(r, index, now) {
  const { item, total, month, last } = r;
  const lastText = last ? `ultimo: ${formatAgoDay(last, now)}` : "mai";
  return `
    <button type="button" class="item-row" data-tap-item="${item.id}" aria-label="+1 ${escapeHtml(item.name)}">
      <span class="rank">${total > 0 ? index + 1 : ""}</span>
      <span class="avatar" style="background:${item.color}">${escapeHtml(initial(item.name))}</span>
      <span class="meta">
        <span class="name block truncate">${escapeHtml(item.name)}</span>
        <span class="sub block truncate">${lastText}${month > 0 ? ` · ${month} questo mese` : ""}</span>
      </span>
      <span class="count">${total}</span>
    </button>`;
}

function editRowHtml(r) {
  const { item } = r;
  return `
    <div class="item-row editing">
      <span class="avatar" style="background:${item.color}">${escapeHtml(initial(item.name))}</span>
      <input type="text" class="rename" value="${escapeHtml(item.name)}" maxlength="40" data-rename-item="${item.id}" aria-label="Nome">
      <button type="button" class="del" data-delete-item="${item.id}" aria-label="Elimina ${escapeHtml(item.name)}">
        <span class="material-symbols-outlined">delete</span>
      </button>
    </div>`;
}

function initial(name) {
  return [...String(name).trim()][0] || "?";
}

// "oggi 14:32", "ieri", "3 giorni fa", "12 set"
function formatAgoDay(ts, now) {
  const todayStart = db.startOfDay(new Date(now));
  const dayStart = db.startOfDay(new Date(ts));
  if (dayStart === todayStart) return `oggi ${formatTime(ts)}`;
  const days = Math.round((todayStart - dayStart) / 86_400_000);
  if (days === 1) return "ieri";
  if (days < 30) return `${days} giorni fa`;
  return new Date(ts).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
}
