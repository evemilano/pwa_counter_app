import * as db from "./db.js";
import { renderDashboard } from "./dashboard.js";
import { renderStats } from "./stats.js";
import { renderHistory } from "./history.js";
import { renderSettings } from "./settings.js";

const VIEWS = {
  dashboard: { el: document.getElementById("view-dashboard"), render: renderDashboard, title: "Counter" },
  stats:     { el: document.getElementById("view-stats"),     render: renderStats,     title: "Statistiche" },
  history:   { el: document.getElementById("view-history"),   render: renderHistory,   title: "Cronologia" },
  settings:  { el: document.getElementById("view-settings"),  render: renderSettings,  title: "Impostazioni" },
};

let currentView = "dashboard";

export const bus = new EventTarget();
export function notifyDataChanged() {
  bus.dispatchEvent(new CustomEvent("data-changed"));
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
  const c = await db.addCounter(v);
  db.setLastCounterId(c.id);
  input.value = "";
  await renderDrawerList();
  toast(`Creato: ${c.name}`);
  notifyDataChanged();
});
document.getElementById("drawer-new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("drawer-add").click();
});

bus.addEventListener("data-changed", () => {
  VIEWS[currentView].render(VIEWS[currentView].el);
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

async function main() {
  await handleShortcut();
  show("dashboard");

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (err) {
      console.warn("SW registration failed:", err);
    }
  }
}

main();
