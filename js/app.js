import * as db from "./db.js";
import { renderDashboard } from "./dashboard.js";
import { renderStats } from "./stats.js";
import { renderHistory } from "./history.js";
import { renderSettings } from "./settings.js";
import * as sync from "./sync.js";

export const APP_VERSION = "v26";

// Traccia i giorni in cui l'app è stata aperta. Serve a Statistiche per
// distinguere giorni "zero sigarette" da giorni in cui l'utente è sparito.
function recordAppOpen() {
  try {
    const key = "contaapp:appOpens";
    const today = db.startOfDay();
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    if (!arr.includes(today)) {
      arr.push(today);
      while (arr.length > 365) arr.shift();
      localStorage.setItem(key, JSON.stringify(arr));
    }
  } catch {}
}

const VIEWS = {
  dashboard: { el: document.getElementById("view-dashboard"), render: renderDashboard, title: "Counter" },
  stats:     { el: document.getElementById("view-stats"),     render: renderStats,     title: "Statistiche" },
  history:   { el: document.getElementById("view-history"),   render: renderHistory,   title: "Cronologia" },
  settings:  { el: document.getElementById("view-settings"),  render: renderSettings,  title: "Impostazioni" },
};

let currentView = "dashboard";
let pendingRender = false;
let lastRenderDay = db.startOfDay();

export const bus = new EventTarget();
export function notifyDataChanged(detail = {}) {
  bus.dispatchEvent(new CustomEvent("data-changed", { detail }));
}

function isEditableInCurrentView(el) {
  return !!el
    && VIEWS[currentView].el.contains(el)
    && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export function toast(msg, ms = 1800) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.classList.add("hidden"), 220);
  }, ms);
}

export function show(view) {
  if (!VIEWS[view]) return;
  currentView = view;
  pendingRender = false;
  lastRenderDay = db.startOfDay();
  for (const [name, v] of Object.entries(VIEWS)) {
    v.el.classList.toggle("hidden", name !== view);
  }
  for (const btn of document.querySelectorAll("#bottomnav .navbtn")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
  document.getElementById("topbar-title").textContent = VIEWS[view].title;
  VIEWS[view].render(VIEWS[view].el);
}

document.querySelectorAll("#bottomnav .navbtn").forEach((btn) => {
  btn.addEventListener("click", () => show(btn.dataset.view));
});

document.getElementById("btn-menu").addEventListener("click", openDrawer);
document.getElementById("btn-settings").addEventListener("click", () => show("settings"));

const drawerEl = document.getElementById("drawer");
drawerEl.querySelectorAll("[data-drawer-close]").forEach((el) => {
  el.addEventListener("click", closeDrawer);
});

async function openDrawer() {
  await renderDrawerList();
  drawerEl.classList.remove("hidden");
}
function closeDrawer() {
  drawerEl.classList.add("hidden");
}

async function renderDrawerList() {
  const list = document.getElementById("drawer-list");
  const counters = await db.listCounters();
  const activeId = db.getLastCounterId();
  list.innerHTML = "";
  if (counters.length === 0) {
    list.innerHTML = `<div class="text-on-surface-variant text-sm text-center py-8">Nessun contatore.<br>Crea il primo qui sotto.</div>`;
    return;
  }
  for (const c of counters) {
    const today = await db.countTapsInRange(c.id, db.startOfDay(), db.endOfDay());
    const row = document.createElement("button");
    row.type = "button";
    row.className = "drawer-counter w-full text-left" + (c.id === activeId ? " active" : "");
    row.innerHTML = `
      <span class="dot" style="background:${c.color}"></span>
      <span class="meta">
        <span class="name block truncate">${escapeHtml(c.name)}</span>
        <span class="sub">${today} oggi${c.dailyTarget ? ` · target ${c.dailyTarget}` : ""}</span>
      </span>
      <span class="material-symbols-outlined text-on-surface-variant">chevron_right</span>
    `;
    row.addEventListener("click", () => {
      db.setLastCounterId(c.id);
      closeDrawer();
      notifyDataChanged();
    });
    list.appendChild(row);
  }
}

document.getElementById("drawer-add").addEventListener("click", async () => {
  const input = document.getElementById("drawer-new-name");
  const v = input.value.trim();
  if (!v) { input.focus(); return; }
  try {
    const c = await db.addCounter(v);
    db.setLastCounterId(c.id);
    input.value = "";
    await renderDrawerList();
    toast(`Creato: ${c.name}`);
    notifyDataChanged();
  } catch (e) {
    if (e.code === "DUPLICATE_NAME" && e.existing) {
      db.setLastCounterId(e.existing.id);
      input.value = "";
      await renderDrawerList();
      toast(`Esiste già: ${e.existing.name}`);
      notifyDataChanged();
    } else {
      toast(e.message || "Errore");
    }
  }
});
document.getElementById("drawer-new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("drawer-add").click();
});

bus.addEventListener("data-changed", (e) => {
  // C1: chi ha già aggiornato il DOM in-place (dashboard +1/undo) chiede di
  // saltare il re-render globale per preservare animazione e focus, ma lascia
  // partire scheduleSync e altri listener del bus.
  if (e.detail?.skipViewRefresh) return;
  // C3: se l'utente sta digitando dentro la view corrente, posticipiamo il
  // re-render finché non perde focus. Senza questa guardia, un pull remoto
  // mid-typing distruggerebbe l'input.
  if (isEditableInCurrentView(document.activeElement)) {
    pendingRender = true;
    return;
  }
  lastRenderDay = db.startOfDay();
  VIEWS[currentView].render(VIEWS[currentView].el);
});

document.addEventListener("focusout", () => {
  if (!pendingRender) return;
  // Attendi un tick: se il focus sta passando a un altro input nella stessa
  // view (es. utente che tabba tra rename input), non renderizzare.
  setTimeout(() => {
    if (!pendingRender) return;
    if (isEditableInCurrentView(document.activeElement)) return;
    pendingRender = false;
    lastRenderDay = db.startOfDay();
    VIEWS[currentView].render(VIEWS[currentView].el);
  }, 0);
});

// C4: refresh quando il giorno cambia (rollover di mezzanotte o wake-from-sleep).
function refreshIfDayChanged() {
  const today = db.startOfDay();
  if (today === lastRenderDay) return;
  lastRenderDay = today;
  recordAppOpen();
  notifyDataChanged();
}

function scheduleMidnightRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = next.getTime() - now.getTime() + 500;
  setTimeout(() => {
    refreshIfDayChanged();
    scheduleMidnightRefresh();
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshIfDayChanged();
});

async function handleShortcut() {
  const params = new URLSearchParams(location.search);
  const action = params.get("action");
  if (action !== "quick-inc") return false;

  let counterId = db.getLastCounterId();
  const counters = await db.listCounters();
  if (!counters.length) {
    history.replaceState({}, "", location.pathname);
    return false;
  }
  if (counterId == null || !counters.find((c) => c.id === counterId)) {
    counterId = counters[counters.length - 1].id;
  }
  await db.addTap(counterId);
  db.setLastCounterId(counterId);
  // C1: schedula il push remoto del tap dello shortcut. skipViewRefresh perché
  // show("dashboard") che segue renderà comunque la view.
  notifyDataChanged({ skipViewRefresh: true });
  const c = counters.find((c) => c.id === counterId);
  if (navigator.vibrate) navigator.vibrate(15);
  toast(`+1 → ${c.name}`);
  history.replaceState({}, "", location.pathname);
  return true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export { escapeHtml };

let deferredInstallPrompt = null;
const installBtn = document.getElementById("btn-install");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBtn.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  installBtn.disabled = true;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === "accepted") toast("Installazione avviata");
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
  installBtn.disabled = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installBtn.classList.add("hidden");
  toast("App installata");
});

async function renderVersionFooter() {
  const el = document.getElementById("app-version");
  if (!el) return;
  let swCache = null;
  if ("caches" in self) {
    try {
      const keys = await caches.keys();
      swCache = keys.find((k) => k.startsWith("counter-")) || null;
    } catch {}
  }
  const swTag = swCache ? swCache.replace("counter-", "") : "—";
  const mismatch = swCache && swCache !== `counter-${APP_VERSION}`;
  el.textContent = mismatch
    ? `app ${APP_VERSION} · sw ${swTag} (chiudi e riapri per aggiornare)`
    : `app ${APP_VERSION}`;
}

async function main() {
  recordAppOpen();
  // Avvia subito sync.init (registra listener + lancia syncNow in background).
  // NON aspettiamo: se la rete è lenta o il server lento, l'UI deve comunque
  // partire — la race "DB vuoto durante pull" è mitigata da Fix 3 (post-import
  // collapse) e Fix 6 (dedup server-side).
  sync.init();

  await handleShortcut();
  show("dashboard");
  renderVersionFooter();
  scheduleMidnightRefresh();

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
      renderVersionFooter();
    } catch (err) {
      console.warn("SW registration failed:", err);
    }
  }
}

main();
