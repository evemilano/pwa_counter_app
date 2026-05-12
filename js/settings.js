import * as db from "./db.js";
import { toast, notifyDataChanged, escapeHtml, show, bus } from "./app.js";
import * as sync from "./sync.js";

export async function renderSettings(root) {
  const counters = await db.listCounters();
  const activeId = db.getLastCounterId();

  root.innerHTML = `
    <div class="pt-2 pb-2">
      <h2 class="font-display font-bold text-2xl text-on-surface">Impostazioni</h2>
      <p class="text-on-surface-variant text-sm">Gestisci contatori, target e backup</p>
    </div>

    <section class="mt-4">
      <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Contatori</h3>
      <div id="counter-list" class="space-y-2"></div>
      <div class="flex gap-2 mt-3">
        <input type="text" id="new-name" placeholder="Nuovo contatore" maxlength="40" autocomplete="off"
          class="flex-1 rounded-xl border border-outline-variant px-3 py-2.5 bg-surface-container-lowest text-on-surface focus:outline-none focus:border-primary">
        <button type="button" id="btn-add"
          class="bg-primary text-on-primary px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
          Aggiungi
        </button>
      </div>
    </section>

    <section class="mt-8">
      <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Backup</h3>
      <p class="text-on-surface-variant text-sm mb-3">
        Esporta tutti i dati in un file JSON e importalo su un altro telefono.
      </p>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="btn-export"
          class="flex items-center gap-2 bg-surface-container-lowest text-on-surface border border-outline-variant px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
          <span class="material-symbols-outlined" style="font-size:20px">file_download</span>
          Esporta dati
        </button>
        <button type="button" id="btn-import"
          class="flex items-center gap-2 bg-surface-container-lowest text-on-surface border border-outline-variant px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
          <span class="material-symbols-outlined" style="font-size:20px">file_upload</span>
          Importa dati
        </button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </section>

    <section class="mt-8">
      <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Sincronizzazione cloud</h3>
      <p class="text-on-surface-variant text-sm mb-3">
        Sincronizza i dati tra più device tramite il tuo endpoint su evemilano.com.
        I dati restano sul tuo server, protetti da token.
      </p>
      <div class="space-y-2">
        <label class="block">
          <span class="text-xs font-semibold text-on-surface-variant">Endpoint URL</span>
          <input type="url" id="sync-endpoint" placeholder="https://www.evemilano.com/cntr/api/sync.php" autocomplete="off"
            class="mt-1 w-full rounded-xl border border-outline-variant px-3 py-2 bg-surface-container-lowest text-on-surface focus:outline-none focus:border-primary">
        </label>
        <label class="block">
          <span class="text-xs font-semibold text-on-surface-variant">Token segreto</span>
          <input type="password" id="sync-token" placeholder="Incolla il token configurato sul server" autocomplete="off"
            class="mt-1 w-full rounded-xl border border-outline-variant px-3 py-2 bg-surface-container-lowest text-on-surface focus:outline-none focus:border-primary">
        </label>
      </div>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" id="btn-sync-save"
          class="bg-primary text-on-primary px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
          Salva e testa
        </button>
        <button type="button" id="btn-sync-now"
          class="flex items-center gap-2 bg-surface-container-lowest text-on-surface border border-outline-variant px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
          <span class="material-symbols-outlined" style="font-size:20px">sync</span>
          Sincronizza ora
        </button>
        <button type="button" id="btn-sync-clear"
          class="text-on-surface-variant text-sm underline px-2 py-2.5">
          Disconnetti questo device
        </button>
      </div>
      <p id="sync-status" class="text-on-surface-variant text-sm mt-3"></p>
    </section>

    <section class="mt-8">
      <h3 class="text-label-caps uppercase tracking-widest text-error mb-2">Zona pericolosa</h3>
      <button type="button" id="btn-wipe"
        class="flex items-center gap-2 bg-error-container text-error border border-error/30 px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
        <span class="material-symbols-outlined" style="font-size:20px">delete_forever</span>
        Cancella tutti i dati
      </button>
    </section>

    <p class="text-center text-xs text-on-surface-variant mt-12">
      Counter · PWA · v1.0 · dati locali sul dispositivo
    </p>
  `;

  renderCounterList(root, counters, activeId);

  root.querySelector("#btn-add").addEventListener("click", () => doAdd(root));
  root.querySelector("#new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd(root);
  });

  root.querySelector("#btn-export").addEventListener("click", doExport);
  root.querySelector("#btn-import").addEventListener("click", () => {
    root.querySelector("#import-file").click();
  });
  root.querySelector("#import-file").addEventListener("change", (e) => {
    doImport(e.target.files[0]).finally(() => { e.target.value = ""; });
  });

  setupSyncSection(root);

  root.querySelector("#btn-wipe").addEventListener("click", async () => {
    if (!confirm("Cancellare TUTTI i contatori e i tap?\nNon si può tornare indietro.")) return;
    if (!confirm("Sei sicuro? Conferma una seconda volta.")) return;
    await db.db.transaction("rw", db.db.counters, db.db.taps, async () => {
      await db.db.taps.clear();
      await db.db.counters.clear();
    });
    db.setLastCounterId(null);
    toast("Tutti i dati cancellati");
    notifyDataChanged();
  });
}

function renderCounterList(root, counters, activeId) {
  const list = root.querySelector("#counter-list");
  if (counters.length === 0) {
    list.innerHTML = `<div class="text-on-surface-variant text-sm text-center py-6 bg-surface-container-low rounded-xl">Nessun contatore. Aggiungine uno qui sotto.</div>`;
    return;
  }
  list.innerHTML = "";
  for (const c of counters) {
    const row = document.createElement("div");
    row.className = "bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-3";
    const isActive = c.id === activeId;
    row.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${c.color}"></span>
        <input type="text" class="flex-1 min-w-0 bg-transparent text-on-surface font-semibold focus:outline-none px-1 py-1 rounded focus:bg-surface-container-low"
          value="${escapeHtml(c.name)}" maxlength="40" data-rename="${c.id}">
        ${isActive ? `<span class="text-xs font-semibold bg-primary-fixed text-primary px-2 py-1 rounded-full">attivo</span>` : ""}
        <button type="button" class="text-on-surface-variant active:text-error p-1" data-delete="${c.id}" aria-label="Elimina">
          <span class="material-symbols-outlined" style="font-size:20px">delete</span>
        </button>
      </div>
      <div class="flex items-center gap-2 mt-2 pl-6">
        <span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">flag</span>
        <label class="text-sm text-on-surface-variant">Target giornaliero:</label>
        <input type="number" min="0" max="9999" class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-2 py-1 text-on-surface text-sm focus:outline-none focus:border-primary"
          value="${Number(c.dailyTarget) || 0}" data-target="${c.id}">
      </div>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll("[data-rename]").forEach((input) => {
    const id = Number(input.dataset.rename);
    let original = input.value;
    input.addEventListener("blur", async () => {
      const v = input.value.trim();
      if (!v) { input.value = original; return; }
      if (v === original) return;
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

  list.querySelectorAll("[data-target]").forEach((input) => {
    const id = Number(input.dataset.target);
    input.addEventListener("change", async () => {
      await db.setDailyTarget(id, input.value);
      toast("Target aggiornato");
      notifyDataChanged();
    });
  });

  list.querySelectorAll("[data-delete]").forEach((btn) => {
    const id = Number(btn.dataset.delete);
    btn.addEventListener("click", async () => {
      const c = counters.find((c) => c.id === id);
      const tapCount = await db.countTapsInRange(id, 0, Number.MAX_SAFE_INTEGER);
      const msg = tapCount > 0
        ? `Eliminare "${c.name}" e i suoi ${tapCount} tap?\nNon recuperabile.`
        : `Eliminare "${c.name}"?`;
      if (!confirm(msg)) return;
      await db.deleteCounter(id);
      if (db.getLastCounterId() === id) db.setLastCounterId(null);
      toast("Eliminato");
      notifyDataChanged();
    });
  });
}

function setupSyncSection(root) {
  const endpointInput = root.querySelector("#sync-endpoint");
  const tokenInput = root.querySelector("#sync-token");
  const statusEl = root.querySelector("#sync-status");
  const cfg = sync.getConfig();
  if (cfg) {
    endpointInput.value = cfg.endpoint || "";
    tokenInput.value = cfg.token || "";
  }
  renderSyncStatus(statusEl);

  const onStatus = () => renderSyncStatus(statusEl);
  bus.addEventListener("sync-status", onStatus);

  root.querySelector("#btn-sync-save").addEventListener("click", async () => {
    const endpoint = endpointInput.value.trim();
    const token = tokenInput.value.trim();
    if (!endpoint || !token) {
      statusEl.textContent = "Compila entrambi i campi.";
      return;
    }
    sync.setConfig({ endpoint, token });
    statusEl.textContent = "Test in corso…";
    try {
      await sync.fetchRemote();
      statusEl.textContent = "Connessione OK. Avvio sync…";
      await sync.syncNow();
      renderSyncStatus(statusEl);
      toast("Sync configurata");
    } catch (err) {
      statusEl.textContent = "Errore: " + (err.message || err);
    }
  });

  root.querySelector("#btn-sync-now").addEventListener("click", async () => {
    statusEl.textContent = "Sync in corso…";
    try {
      await sync.syncNow();
      renderSyncStatus(statusEl);
      toast("Sincronizzato");
    } catch (err) {
      statusEl.textContent = "Errore: " + (err.message || err);
    }
  });

  root.querySelector("#btn-sync-clear").addEventListener("click", () => {
    if (!confirm("Disconnetti questo device dal sync cloud?\nI dati locali restano, ma non saranno più sincronizzati.")) return;
    sync.setConfig(null);
    endpointInput.value = "";
    tokenInput.value = "";
    statusEl.textContent = "Device disconnesso.";
    toast("Sync disattivata");
  });
}

function renderSyncStatus(el) {
  const cfg = sync.getConfig();
  if (!cfg) { el.textContent = "Non configurato."; return; }
  const st = sync.getState();
  if (st.lastError) { el.textContent = "Errore: " + st.lastError; return; }
  if (st.lastSyncAt) {
    el.textContent = "Ultima sync: " + formatAgo(st.lastSyncAt);
  } else {
    el.textContent = "In attesa della prima sync…";
  }
}

function formatAgo(ts) {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s fa`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  const d = Math.floor(h / 24);
  return `${d} giorni fa`;
}

async function doAdd(root) {
  const input = root.querySelector("#new-name");
  const v = input.value.trim();
  if (!v) { input.focus(); return; }
  const c = await db.addCounter(v);
  if (!db.getLastCounterId()) db.setLastCounterId(c.id);
  input.value = "";
  toast(`Creato: ${c.name}`);
  notifyDataChanged();
}

async function doExport() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `counter-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Esportati: ${data.counters.length} contatori, ${data.taps.length} tap`);
}

async function doImport(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("File non leggibile (JSON non valido).");
    return;
  }
  const mode = await pickImportMode(data);
  if (!mode) return;
  try {
    const r = await db.importAll(data, mode);
    toast(`Importati: ${r.countersAdded} contatori, ${r.tapsAdded} tap (saltati ${r.tapsSkipped})`, 3500);
    notifyDataChanged();
  } catch (e) {
    alert("Errore import: " + e.message);
  }
}

function pickImportMode(data) {
  const cCount = data.counters?.length ?? "?";
  const tCount = data.taps?.length ?? "?";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4";
    overlay.innerHTML = `
      <div class="bg-surface-container-lowest rounded-2xl p-5 max-w-sm w-full shadow-2xl">
        <h3 class="font-display font-bold text-xl mb-1">Modalità import</h3>
        <p class="text-on-surface-variant text-sm mb-4">
          File con <b>${cCount}</b> contatori e <b>${tCount}</b> tap.
        </p>
        <div class="space-y-2">
          <button type="button" data-mode="merge"
            class="w-full text-left bg-primary text-on-primary p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            <div>Unisci ai dati esistenti</div>
            <div class="text-xs font-normal opacity-85">Aggiunge solo i tap nuovi (dedup automatica)</div>
          </button>
          <button type="button" data-mode="replace"
            class="w-full text-left bg-error-container text-error border border-error/30 p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            <div>Sostituisci tutto</div>
            <div class="text-xs font-normal opacity-85">Cancella tutto e ricarica dal file</div>
          </button>
          <button type="button" data-mode=""
            class="w-full bg-surface-container text-on-surface p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            Annulla
          </button>
        </div>
      </div>`;
    overlay.addEventListener("click", async (e) => {
      const mode = e.target?.closest?.("[data-mode]")?.dataset?.mode;
      if (mode === undefined) return;
      document.body.removeChild(overlay);
      if (mode === "replace") {
        if (!confirm("Sostituire DAVVERO tutti i dati locali col contenuto del file?")) {
          resolve(null);
          return;
        }
      }
      resolve(mode || null);
    });
    document.body.appendChild(overlay);
  });
}
