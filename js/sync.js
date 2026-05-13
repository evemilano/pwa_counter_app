import * as db from "./db.js";
import { bus, notifyDataChanged } from "./app.js";

const CFG_KEY = "contaapp:syncConfig";
const STATE_KEY = "contaapp:syncState";
const DEBOUNCE_MS = 2500;
const MAX_RETRIES = 3;

let debounceTimer = null;
let inFlight = null;
let suppressSchedule = false;

export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || null;
  } catch { return null; }
}

export function setConfig(cfg) {
  if (!cfg) { localStorage.removeItem(CFG_KEY); return; }
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function getState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) || { lastSyncAt: 0, lastError: null };
  } catch { return { lastSyncAt: 0, lastError: null }; }
}

function setState(patch) {
  const cur = getState();
  const next = { ...cur, ...patch };
  localStorage.setItem(STATE_KEY, JSON.stringify(next));
  bus.dispatchEvent(new CustomEvent("sync-status", { detail: next }));
}

function isConfigured() {
  const c = getConfig();
  return !!(c && c.endpoint && c.token);
}

async function request(method, body) {
  const c = getConfig();
  if (!c) throw new Error("Sync non configurato");
  const init = {
    method,
    headers: {
      "X-Auth-Token": c.token,
      "Accept": "application/json",
    },
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(c.endpoint, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json };
}

export async function fetchRemote() {
  const { res, json } = await request("GET");
  if (res.status === 401) throw new Error("Token non valido");
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return json;
}

export async function pushRemote(data, expectedVersion) {
  const { res, json } = await request("PUT", { data, expectedVersion });
  if (res.status === 401) throw new Error("Token non valido");
  if (res.status === 409) return { conflict: true, current: json.current };
  if (!res.ok) throw new Error(`PUT ${res.status}`);
  return { conflict: false, version: json.version, updatedAt: json.updatedAt };
}

function importChanged(r) {
  if (!r) return false;
  return ((r.countersAdded || 0) + (r.countersUpdated || 0) + (r.countersAligned || 0) +
          (r.countersCollapsed || 0) + (r.tapsAdded || 0) + (r.tapsUpdated || 0)) > 0;
}

export async function syncNow({ silent = false } = {}) {
  if (!isConfigured()) {
    if (!silent) setState({ lastError: "Non configurato" });
    return { skipped: true };
  }
  if (inFlight) return inFlight;
  if (!silent) setState({ lastError: null, syncing: true });

  inFlight = (async () => {
    let mergedRemote = false;
    try {
      let remote = await fetchRemote();
      let expectedVersion = remote.version || 0;

      if (remote.data && Array.isArray(remote.data.counters) && Array.isArray(remote.data.taps)) {
        const remotePayload = { app: "contaapp", schemaVersion: db.SCHEMA_VERSION, ...remote.data };
        // dedupByName attivo ad ogni sync: il post-import collapse di importAll
        // è l'unica difesa contro counter alive locali con uid sconosciuto al server.
        const r = await db.importAll(remotePayload, "merge", { dedupByName: true });
        if (importChanged(r)) mergedRemote = true;
      }

      let attempt = 0;
      while (attempt < MAX_RETRIES) {
        const local = await db.exportAll();
        const payload = { counters: local.counters, taps: local.taps, schemaVersion: db.SCHEMA_VERSION };
        const result = await pushRemote(payload, expectedVersion);
        if (!result.conflict) {
          setState({ lastSyncAt: Date.now(), lastError: null, syncing: false });
          if (mergedRemote) {
            suppressSchedule = true;
            try { notifyDataChanged(); } finally { suppressSchedule = false; }
          }
          return { ok: true, version: result.version };
        }
        const cur = result.current || {};
        expectedVersion = cur.version || 0;
        if (cur.data && Array.isArray(cur.data.counters) && Array.isArray(cur.data.taps)) {
          const remotePayload = { app: "contaapp", schemaVersion: db.SCHEMA_VERSION, ...cur.data };
          // Anche nei retry su 409 abilitiamo dedupByName: il remoto è autoritativo
          // per uid ma non per nomi, e senza dedup i duplicati per nome (locali o
          // dentro il payload remoto stesso) sopravviverebbero.
          const r = await db.importAll(remotePayload, "merge", { dedupByName: true });
          if (importChanged(r)) mergedRemote = true;
        }
        attempt++;
      }
      throw new Error("Troppi conflitti, riprova");
    } catch (err) {
      setState({ lastError: err.message || String(err), syncing: false });
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export async function syncForcePush() {
  if (!isConfigured()) return { skipped: true };
  // Attende un eventuale syncNow in corso per evitare race sul versionamento
  while (inFlight) {
    try { await inFlight; } catch {}
  }
  setState({ lastError: null, syncing: true });

  inFlight = (async () => {
    try {
      const remote = await fetchRemote();
      let expectedVersion = remote.version || 0;
      let attempt = 0;
      while (attempt < MAX_RETRIES) {
        const local = await db.exportAll();
        const payload = { counters: local.counters, taps: local.taps, schemaVersion: db.SCHEMA_VERSION };
        const result = await pushRemote(payload, expectedVersion);
        if (!result.conflict) {
          setState({ lastSyncAt: Date.now(), lastError: null, syncing: false });
          return { ok: true, version: result.version };
        }
        expectedVersion = result.current?.version || 0;
        attempt++;
      }
      throw new Error("Force push fallito dopo troppi conflitti");
    } catch (err) {
      setState({ lastError: err.message || String(err), syncing: false });
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function scheduleSync() {
  if (suppressSchedule) return;
  if (!isConfigured()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    syncNow({ silent: true }).catch(() => {});
  }, DEBOUNCE_MS);
}

let initialized = false;
export function init() {
  if (initialized) return;
  initialized = true;
  bus.addEventListener("data-changed", scheduleSync);
  window.addEventListener("online", () => syncNow({ silent: true }).catch(() => {}));
  if (isConfigured()) {
    syncNow({ silent: true }).catch(() => {});
  }
}
