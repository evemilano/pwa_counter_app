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
      <button type="button" id="btn-merge-dupes"
        class="mt-3 flex items-center gap-2 bg-surface-container-lowest text-on-surface border border-outline-variant px-4 py-2.5 rounded-xl font-semibold active:scale-95 transition-transform">
        <span class="material-symbols-outlined" style="font-size:20px">merge</span>
        Trova e unisci duplicati
      </button>
    </section>

    <section class="mt-8">
      <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Backup</h3>
      <p class="text-on-surface-variant text-sm mb-3">
        Esporta tutti i dati in un file JSON e importalo su un altro device per un ripristino completo.
      </p>
      <label class="flex items-start gap-2 text-sm text-on-surface mb-3">
        <input type="checkbox" id="export-include-creds" class="mt-1">
        <span>
          Includi credenziali di sync (endpoint + token)
          <span class="block text-xs text-on-surface-variant">Il file conterrà il token in chiaro: trattalo come una password.</span>
        </span>
      </label>
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
          <input type="text" id="sync-endpoint" placeholder="api/sync.php" autocomplete="off"
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
      <h3 class="text-label-caps uppercase tracking-widest text-on-surface-variant mb-2">Preferenze statistiche</h3>
      <label class="flex items-start gap-2 text-sm text-on-surface">
        <input type="checkbox" id="show-health" class="mt-1">
        <span>
          Mostra impatto salute (tempo di vita guadagnato)
          <span class="block text-xs text-on-surface-variant">Stima ~11 min per sigaretta evitata (fonte CDC, solo indicativa).</span>
        </span>
      </label>
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
  root.querySelector("#btn-merge-dupes").addEventListener("click", () => doMergeDuplicates());

  const includeCredsBox = root.querySelector("#export-include-creds");
  includeCredsBox.checked = !!sync.getConfig();

  root.querySelector("#btn-export").addEventListener("click", () => doExport(includeCredsBox.checked));
  root.querySelector("#btn-import").addEventListener("click", () => {
    root.querySelector("#import-file").click();
  });
  root.querySelector("#import-file").addEventListener("change", (e) => {
    doImport(e.target.files[0]).finally(() => { e.target.value = ""; });
  });

  setupSyncSection(root);

  const showHealthEl = root.querySelector("#show-health");
  showHealthEl.checked = localStorage.getItem("contaapp:showHealth") !== "false";
  showHealthEl.addEventListener("change", () => {
    localStorage.setItem("contaapp:showHealth", showHealthEl.checked ? "true" : "false");
    notifyDataChanged();
  });

  root.querySelector("#btn-wipe").addEventListener("click", async () => {
    if (!confirm("Cancellare TUTTI i contatori e i tap?\nNon si può tornare indietro.")) return;
    if (!confirm("Sei sicuro? Conferma una seconda volta.")) return;
    const now = Date.now();
    await db.db.transaction("rw", db.db.counters, db.db.taps, async () => {
      await db.db.taps.toCollection().modify((t) => {
        if (!t.deletedAt) { t.deletedAt = now; t.updatedAt = now; }
      });
      await db.db.counters.toCollection().modify((c) => {
        if (!c.deletedAt) { c.deletedAt = now; c.updatedAt = now; }
      });
    });
    db.setLastCounterId(null);
    notifyDataChanged();
    // C2: wipe è destructive — force-push subito così un pull intermedio o un
    // 409 non rianima i dati appena cancellati.
    if (sync.getConfig()) {
      try {
        await sync.syncForcePush();
        toast("Tutti i dati cancellati, sync ok");
      } catch (e) {
        toast(`Cancellati localmente, sync fallita: ${e.message || e}`, 5000);
      }
    } else {
      toast("Tutti i dati cancellati");
    }
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
      <div class="flex items-center gap-2 mt-2 pl-6 flex-wrap">
        <span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">euro</span>
        <label class="text-sm text-on-surface-variant">Prezzo sig.:</label>
        <input type="number" min="0" max="99" step="0.01" placeholder="0,30"
          class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-2 py-1 text-on-surface text-sm focus:outline-none focus:border-primary"
          value="${Number(c.pricePerCig) || 0}" data-price="${c.id}">
        <span class="text-xs text-on-surface-variant">€</span>
      </div>
      <div class="flex items-center gap-2 mt-2 pl-6 flex-wrap">
        <span class="material-symbols-outlined text-on-surface-variant" style="font-size:18px">trending_down</span>
        <label class="text-sm text-on-surface-variant">Fumavi prima:</label>
        <input type="number" min="0" max="99" placeholder="auto"
          class="w-20 bg-surface-container-low border border-outline-variant rounded-lg px-2 py-1 text-on-surface text-sm focus:outline-none focus:border-primary"
          value="${Number(c.baselineOverride) || 0}" data-baseline="${c.id}">
        <span class="text-xs text-on-surface-variant">sig/giorno</span>
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

  list.querySelectorAll("[data-price]").forEach((input) => {
    const id = Number(input.dataset.price);
    input.addEventListener("change", async () => {
      await db.setPricePerCig(id, input.value);
      toast("Prezzo aggiornato");
      notifyDataChanged();
    });
  });

  list.querySelectorAll("[data-baseline]").forEach((input) => {
    const id = Number(input.dataset.baseline);
    input.addEventListener("change", async () => {
      await db.setBaselineOverride(id, input.value);
      toast(Number(input.value) > 0 ? "Baseline impostata" : "Baseline automatica");
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
    endpointInput.value = cfg.endpoint || "api/sync.php";
    tokenInput.value = cfg.token || "";
  } else {
    endpointInput.value = "api/sync.php";
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
  try {
    const c = await db.addCounter(v);
    if (!db.getLastCounterId()) db.setLastCounterId(c.id);
    input.value = "";
    toast(`Creato: ${c.name}`);
    notifyDataChanged();
  } catch (e) {
    if (e.code === "DUPLICATE_NAME" && e.existing) {
      db.setLastCounterId(e.existing.id);
      input.value = "";
      toast(`Esiste già: ${e.existing.name}`);
      notifyDataChanged();
    } else {
      toast(e.message || "Errore");
    }
  }
}

async function doExport(includeSyncCredentials) {
  const data = await db.exportAll({ includeSyncCredentials });
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
  const aliveCounters = data.counters.filter((c) => !c.deletedAt).length;
  const aliveTaps = data.taps.filter((t) => !t.deletedAt).length;
  const credNote = data.settings?.sync ? " + sync" : "";
  toast(`Esportati: ${aliveCounters} contatori, ${aliveTaps} tap${credNote}`);
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
    const parts = [];
    if (mode === "replace") {
      parts.push(`${r.countersAdded} contatori`, `${r.tapsAdded} tap`);
      if (r.tapsSkipped) parts.push(`saltati ${r.tapsSkipped}`);
      if (data.settings?.sync) parts.push("sync ripristinata");
    } else {
      parts.push(`+${r.countersAdded} nuovi`, `~${r.countersUpdated || 0} aggiornati`);
      parts.push(`+${r.tapsAdded} tap`, `~${r.tapsUpdated || 0} mod.`);
      if (r.tapsSkipped) parts.push(`saltati ${r.tapsSkipped}`);
    }
    toast(`Import: ${parts.join(", ")}`, 4000);
    notifyDataChanged();
    if (mode === "replace" && sync.getConfig()) {
      // Replace deve "vincere" sul server: force-push diretto, niente pull-then-push
      // che farebbe rientrare i dati che il file non aveva.
      sync.syncForcePush().catch(() => {});
    }
  } catch (e) {
    alert("Errore import: " + e.message);
  }
}

async function findDuplicateGroups() {
  const counters = await db.listCounters();
  const byName = new Map();
  for (const c of counters) {
    const k = (c.name || "").trim().toLowerCase();
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const groups = [];
  for (const [k, arr] of byName) {
    if (arr.length < 2) continue;
    const withCounts = await Promise.all(arr.map(async (c) => ({
      c,
      taps: await db.countTapsInRange(c.id, 0, Number.MAX_SAFE_INTEGER),
    })));
    withCounts.sort((a, b) => {
      if (b.taps !== a.taps) return b.taps - a.taps;
      return (a.c.createdAt || 0) - (b.c.createdAt || 0);
    });
    const canonical = withCounts[0].c;
    const duplicates = withCounts.slice(1).map((x) => x.c);
    groups.push({ key: k, canonical, duplicates, totalTaps: withCounts.reduce((s, x) => s + x.taps, 0) });
  }
  return groups;
}

async function doMergeDuplicates() {
  // Bug B fix: prima sincronizza per portare in locale TUTTI gli uid del server.
  // Senza questo, un Unisci basato sullo stato locale lascia su server uid
  // sconosciuti che la prossima sync ri-importerebbe come nuovi.
  if (sync.getConfig()) {
    toast("Sincronizzo prima di cercare duplicati…", 1500);
    try {
      await sync.syncNow({ silent: true });
    } catch (e) {
      if (!confirm("Sync fallita prima della ricerca duplicati. Procedere comunque sui soli dati locali?\nRiga errore: " + (e.message || e))) {
        return;
      }
    }
  }
  const groups = await findDuplicateGroups();
  if (groups.length === 0) {
    toast("Nessun duplicato trovato");
    return;
  }
  const confirmed = await confirmMergeGroups(groups);
  if (!confirmed) return;
  let mergedTotal = 0, tapsMovedTotal = 0;
  for (const g of groups) {
    const r = await db.mergeCounters(g.canonical.id, g.duplicates.map((d) => d.id));
    mergedTotal += r.mergedCount;
    tapsMovedTotal += r.tapsMoved;
  }
  notifyDataChanged();
  // Bug B fix: force-push dello stato post-merge per evitare che un pull
  // intermedio re-importi gli uid duplicati come alive (LWW dipende dai
  // timestamp, ma forcePush li sostituisce e basta).
  if (sync.getConfig()) {
    try {
      await sync.syncForcePush();
      toast(`Uniti ${mergedTotal} duplicati, ${tapsMovedTotal} tap riassegnati, sync ok`, 4000);
    } catch (e) {
      toast(`Uniti localmente ${mergedTotal}, ma sync fallita: ${e.message || e}`, 5000);
    }
  } else {
    toast(`Uniti ${mergedTotal} duplicati, ${tapsMovedTotal} tap riassegnati`, 3500);
  }
}

function confirmMergeGroups(groups) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4";
    const groupsHtml = groups.map((g) => {
      const dupNames = g.duplicates.map((d) => `<code class="text-xs">${escapeHtml(d.name)}</code>`).join(", ");
      return `
        <div class="bg-surface-container-low rounded-lg p-3 text-sm">
          <div class="text-on-surface"><b>${escapeHtml(g.canonical.name)}</b> ← ${g.duplicates.length} duplicat${g.duplicates.length > 1 ? "i" : "o"}</div>
          <div class="text-on-surface-variant text-xs mt-1">Canonico scelto: il record con più tap (${g.totalTaps} totali nel gruppo).</div>
        </div>`;
    }).join("");
    overlay.innerHTML = `
      <div class="bg-surface-container-lowest rounded-2xl p-5 max-w-md w-full shadow-2xl max-h-[80vh] overflow-y-auto">
        <h3 class="font-display font-bold text-xl mb-1">Unisci duplicati</h3>
        <p class="text-on-surface-variant text-sm mb-3">
          Trovati ${groups.length} grupp${groups.length > 1 ? "i" : "o"} con nomi identici.
          I tap dei duplicati verranno spostati nel canonico, i duplicati saranno cancellati (soft-delete propagato via sync).
        </p>
        <div class="space-y-2 mb-4">${groupsHtml}</div>
        <div class="flex gap-2">
          <button type="button" data-act="confirm"
            class="flex-1 bg-primary text-on-primary p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            Unisci tutto
          </button>
          <button type="button" data-act="cancel"
            class="flex-1 bg-surface-container text-on-surface p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            Annulla
          </button>
        </div>
      </div>`;
    overlay.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-act]")?.dataset?.act;
      if (!act) return;
      document.body.removeChild(overlay);
      resolve(act === "confirm");
    });
    document.body.appendChild(overlay);
  });
}

function pickImportMode(data) {
  const cCount = data.counters?.filter?.((c) => !c.deletedAt).length ?? data.counters?.length ?? "?";
  const tCount = data.taps?.filter?.((t) => !t.deletedAt).length ?? data.taps?.length ?? "?";
  const hasSettings = !!data.settings?.sync;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4";
    overlay.innerHTML = `
      <div class="bg-surface-container-lowest rounded-2xl p-5 max-w-sm w-full shadow-2xl">
        <h3 class="font-display font-bold text-xl mb-1">Modalità import</h3>
        <p class="text-on-surface-variant text-sm mb-4">
          File con <b>${cCount}</b> contatori e <b>${tCount}</b> tap${hasSettings ? " + sync" : ""}.
        </p>
        <div class="space-y-2">
          <button type="button" data-mode="merge"
            class="w-full text-left bg-primary text-on-primary p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            <div>Unisci ai dati esistenti</div>
            <div class="text-xs font-normal opacity-85">Per ogni record vince la versione più recente (last-write-wins).${hasSettings ? " I settings del file vengono ignorati." : ""}</div>
          </button>
          <button type="button" data-mode="replace"
            class="w-full text-left bg-error-container text-error border border-error/30 p-3 rounded-xl font-semibold active:scale-95 transition-transform">
            <div>Sostituisci tutto</div>
            <div class="text-xs font-normal opacity-85">Cancella tutto e ricarica dal file${hasSettings ? " (anche sync)" : ""}</div>
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
