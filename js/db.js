import Dexie from "https://esm.sh/dexie@4.0.10";

export const SCHEMA_VERSION = 3;
const PALETTE = ["#e85454", "#f59e0b", "#10b981", "#06b6d4", "#6366f1", "#a855f7", "#ec4899", "#84cc16"];

export const db = new Dexie("contaapp");
db.version(1).stores({
  counters: "++id, name, createdAt",
  taps: "++id, counterId, timestamp, [counterId+timestamp]",
});
db.version(2).stores({
  counters: "++id, name, createdAt",
  taps: "++id, counterId, timestamp, [counterId+timestamp]",
}).upgrade(async (tx) => {
  await tx.table("counters").toCollection().modify((c) => {
    if (c.dailyTarget === undefined) c.dailyTarget = 0;
  });
});
db.version(3).stores({
  counters: "++id, uid, name, createdAt, updatedAt",
  taps: "++id, uid, counterId, timestamp, updatedAt, [counterId+timestamp]",
}).upgrade(async (tx) => {
  await tx.table("counters").toCollection().modify((c) => {
    if (!c.uid) c.uid = crypto.randomUUID();
    if (c.updatedAt == null) c.updatedAt = c.createdAt || Date.now();
    if (c.deletedAt === undefined) c.deletedAt = null;
  });
  await tx.table("taps").toCollection().modify((t) => {
    if (!t.uid) t.uid = crypto.randomUUID();
    if (t.updatedAt == null) t.updatedAt = t.timestamp || Date.now();
    if (t.deletedAt === undefined) t.deletedAt = null;
  });
});

function newUid() {
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "u-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function alive(r) {
  return !!r && !r.deletedAt;
}

export function pickColor(existingCount) {
  return PALETTE[existingCount % PALETTE.length];
}

export async function listCounters() {
  const all = await db.counters.orderBy("createdAt").toArray();
  return all.filter(alive);
}

export async function getCounter(id) {
  const c = await db.counters.get(id);
  return alive(c) ? c : undefined;
}

export async function addCounter(name, color, dailyTarget = 0) {
  const aliveCounters = await listCounters();
  const now = Date.now();
  const c = {
    uid: newUid(),
    name: name.trim(),
    color: color || pickColor(aliveCounters.length),
    dailyTarget: Number(dailyTarget) || 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  c.id = await db.counters.add(c);
  return c;
}

export async function updateCounter(id, patch) {
  await db.counters.update(id, { ...patch, updatedAt: Date.now() });
}

export async function renameCounter(id, newName) {
  await db.counters.update(id, { name: newName.trim(), updatedAt: Date.now() });
}

export async function setDailyTarget(id, value) {
  await db.counters.update(id, { dailyTarget: Number(value) || 0, updatedAt: Date.now() });
}

export async function deleteCounter(id) {
  const now = Date.now();
  await db.transaction("rw", db.counters, db.taps, async () => {
    const taps = await db.taps.where("counterId").equals(id).toArray();
    for (const t of taps) {
      if (!t.deletedAt) {
        await db.taps.update(t.id, { deletedAt: now, updatedAt: now });
      }
    }
    await db.counters.update(id, { deletedAt: now, updatedAt: now });
  });
}

export async function addTap(counterId, ts = Date.now()) {
  const now = Date.now();
  return db.taps.add({
    uid: newUid(),
    counterId,
    timestamp: ts,
    updatedAt: now,
    deletedAt: null,
  });
}

export async function deleteTap(tapId) {
  const now = Date.now();
  await db.taps.update(tapId, { deletedAt: now, updatedAt: now });
}

export async function updateTapTimestamp(tapId, newTimestamp) {
  await db.taps.update(tapId, { timestamp: Number(newTimestamp), updatedAt: Date.now() });
}

export async function mergeCounters(canonicalId, duplicateIds) {
  if (canonicalId == null) throw new Error("Nessun contatore canonico");
  let tapsMoved = 0;
  let mergedCount = 0;
  await db.transaction("rw", db.counters, db.taps, async () => {
    const canonical = await db.counters.get(canonicalId);
    if (!alive(canonical)) throw new Error("Contatore canonico non valido");
    // updatedAt "futuristico": deve battere qualsiasi updatedAt esistente nel sistema
    // (incluso il server) per evitare che LWW resusciti i tombstone.
    const [allCounters, allTaps] = await Promise.all([db.counters.toArray(), db.taps.toArray()]);
    const maxUpdated = Math.max(
      Date.now(),
      ...allCounters.map((c) => Number(c.updatedAt) || 0),
      ...allTaps.map((t) => Number(t.updatedAt) || 0),
    );
    const now = maxUpdated + 1;
    for (const dupId of duplicateIds) {
      if (dupId === canonicalId) continue;
      const dup = await db.counters.get(dupId);
      if (!dup) continue;
      const taps = await db.taps.where("counterId").equals(dupId).toArray();
      for (const t of taps) {
        if (!t.deletedAt) {
          await db.taps.update(t.id, { counterId: canonicalId, updatedAt: now });
          tapsMoved++;
        }
      }
      if (!dup.deletedAt) {
        await db.counters.update(dupId, { deletedAt: now, updatedAt: now });
      }
      mergedCount++;
    }
    if (mergedCount > 0) {
      await db.counters.update(canonicalId, { updatedAt: now });
    }
  });
  return { mergedCount, tapsMoved };
}

export async function removeLatestTap(counterId) {
  const all = await db.taps.where("counterId").equals(counterId).toArray();
  const live = all.filter(alive).sort((a, b) => b.timestamp - a.timestamp);
  if (live.length === 0) return null;
  const latest = live[0];
  const now = Date.now();
  await db.taps.update(latest.id, { deletedAt: now, updatedAt: now });
  return latest;
}

export async function getLatestTap(counterId) {
  const all = await db.taps.where("counterId").equals(counterId).toArray();
  const live = all.filter(alive).sort((a, b) => b.timestamp - a.timestamp);
  return live[0] || null;
}

export async function countTapsInRange(counterId, from, to) {
  const arr = await db.taps
    .where("[counterId+timestamp]")
    .between([counterId, from], [counterId, to], true, false)
    .toArray();
  return arr.filter(alive).length;
}

export async function getTapsInRange(counterId, from, to) {
  const arr = await db.taps
    .where("[counterId+timestamp]")
    .between([counterId, from], [counterId, to], true, false)
    .toArray();
  return arr.filter(alive);
}

export async function getAllTaps(counterId) {
  const arr = await db.taps.where("counterId").equals(counterId).sortBy("timestamp");
  return arr.filter(alive);
}

const LAST_KEY = "contaapp:lastCounterId";
export function getLastCounterId() {
  const v = localStorage.getItem(LAST_KEY);
  return v ? Number(v) : null;
}
export function setLastCounterId(id) {
  if (id == null) localStorage.removeItem(LAST_KEY);
  else localStorage.setItem(LAST_KEY, String(id));
}

async function getLastCounterUid() {
  const id = getLastCounterId();
  if (id == null) return null;
  const c = await db.counters.get(id);
  return c?.uid || null;
}

async function setLastCounterByUid(uid) {
  if (!uid) return;
  const all = await db.counters.toArray();
  const found = all.find((c) => c.uid === uid && !c.deletedAt);
  if (found) setLastCounterId(found.id);
}

const SYNC_CFG_KEY = "contaapp:syncConfig";

export async function exportAll({ includeSyncCredentials = true } = {}) {
  const [counters, taps] = await Promise.all([
    db.counters.toArray(),
    db.taps.toArray(),
  ]);

  const counterIdToUid = new Map(counters.map((c) => [c.id, c.uid]));

  const exportedTaps = taps
    .map((t) => ({
      uid: t.uid,
      counterUid: counterIdToUid.get(t.counterId) || null,
      timestamp: t.timestamp,
      updatedAt: t.updatedAt || t.timestamp,
      deletedAt: t.deletedAt ?? null,
    }))
    .filter((t) => t.counterUid != null);

  const exportedCounters = counters.map((c) => ({
    uid: c.uid,
    name: c.name,
    color: c.color,
    dailyTarget: Number(c.dailyTarget) || 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt || c.createdAt,
    deletedAt: c.deletedAt ?? null,
  }));

  const settings = {};
  const lastUid = await getLastCounterUid();
  if (lastUid) settings.lastCounterUid = lastUid;
  if (includeSyncCredentials) {
    try {
      const raw = localStorage.getItem(SYNC_CFG_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && cfg.endpoint && cfg.token) {
          settings.sync = { endpoint: cfg.endpoint, token: cfg.token };
        }
      }
    } catch {}
  }

  const payload = {
    app: "contaapp",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counters: exportedCounters,
    taps: exportedTaps,
  };
  if (Object.keys(settings).length > 0) payload.settings = settings;
  return payload;
}

function normalizeCounter(c) {
  return {
    uid: c.uid || newUid(),
    name: String(c.name ?? "").trim() || "Senza nome",
    color: c.color || pickColor(0),
    dailyTarget: Number(c.dailyTarget) || 0,
    createdAt: Number(c.createdAt) || Date.now(),
    updatedAt: Number(c.updatedAt) || Number(c.createdAt) || Date.now(),
    deletedAt: c.deletedAt ? Number(c.deletedAt) : null,
  };
}

function normalizeTap(t, counterUid) {
  return {
    uid: t.uid || newUid(),
    counterUid,
    timestamp: Number(t.timestamp) || Date.now(),
    updatedAt: Number(t.updatedAt) || Number(t.timestamp) || Date.now(),
    deletedAt: t.deletedAt ? Number(t.deletedAt) : null,
  };
}

function resolveCounterUidForLegacyTap(t, data) {
  if (t.counterUid) return t.counterUid;
  if (t.counterId == null) return null;
  const found = (data.counters || []).find((c) => c.id === t.counterId);
  return found?.uid || null;
}

export async function importAll(data, mode = "merge", options = {}) {
  if (!data || data.app !== "contaapp" || !Array.isArray(data.counters) || !Array.isArray(data.taps)) {
    throw new Error("File non valido: non sembra un export di Counter.");
  }
  if ((data.schemaVersion || 1) > SCHEMA_VERSION) {
    throw new Error(`Versione del file (${data.schemaVersion}) più recente di quella supportata (${SCHEMA_VERSION}).`);
  }

  const dedupByName = mode === "merge" && options.dedupByName === true;

  // Assicura un uid stabile su ogni counter del payload: serve a resolveCounterUidForLegacyTap
  // (usato per taps legacy che referenziano counterId invece di counterUid).
  for (const c of data.counters) {
    if (!c.uid) c.uid = newUid();
  }

  if (mode === "replace") {
    return db.transaction("rw", db.counters, db.taps, async () => {
      await db.taps.clear();
      await db.counters.clear();

      const uidToId = new Map();
      for (const raw of data.counters) {
        const norm = normalizeCounter(raw);
        const id = await db.counters.add(norm);
        uidToId.set(norm.uid, id);
      }

      let tapsAdded = 0, tapsSkipped = 0;
      for (const raw of data.taps) {
        const counterUid = resolveCounterUidForLegacyTap(raw, data);
        const counterId = counterUid ? uidToId.get(counterUid) : null;
        if (counterId == null) { tapsSkipped++; continue; }
        const norm = normalizeTap(raw, counterUid);
        await db.taps.add({
          uid: norm.uid,
          counterId,
          timestamp: norm.timestamp,
          updatedAt: norm.updatedAt,
          deletedAt: norm.deletedAt,
        });
        tapsAdded++;
      }

      await applyImportedSettings(data.settings, uidToId);

      return { mode, countersAdded: uidToId.size, tapsAdded, tapsSkipped };
    });
  }

  return db.transaction("rw", db.counters, db.taps, async () => {
    const localCounters = await db.counters.toArray();
    const byUid = new Map(localCounters.map((c) => [c.uid, c]));

    // Costruisci il piano per il payload remoto: in dedupByName, scegli un canonical
    // per ogni gruppo di counter remoti con stesso nome (case-insensitive, alive),
    // e marca gli altri come tombstone. Il canonical è quello con createdAt minore
    // (record "originale") con tiebreaker sul uid lessicale.
    let nameCanonicalUid = null;
    if (dedupByName) {
      nameCanonicalUid = new Map();
      const remoteAliveByName = new Map();
      for (const r of data.counters) {
        if (r.deletedAt) continue;
        const k = (r.name || "").trim().toLowerCase();
        if (!k) continue;
        if (!remoteAliveByName.has(k)) remoteAliveByName.set(k, []);
        remoteAliveByName.get(k).push(r);
      }
      for (const [k, arr] of remoteAliveByName) {
        arr.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.uid).localeCompare(String(b.uid)));
        nameCanonicalUid.set(k, arr[0].uid);
      }
    }

    // Per la dedup-by-name del primo sync: solo i locali alive il cui uid non è
    // nel payload remoto possono essere candidati a essere "allineati" a un uid remoto.
    let aliveByName = null;
    if (dedupByName) {
      const remoteUids = new Set(data.counters.map((c) => c.uid));
      aliveByName = new Map();
      for (const c of localCounters) {
        if (c.deletedAt) continue;
        if (remoteUids.has(c.uid)) continue;
        const k = (c.name || "").trim().toLowerCase();
        if (!k) continue;
        // Allinea solo al canonical remoto del gruppo, non a uno dei duplicati
        if (!aliveByName.has(k)) aliveByName.set(k, []);
        aliveByName.get(k).push(c);
      }
    }

    // Calcola un timestamp "futuristico" per i tombstone collassati durante dedup,
    // così LWW non li resuscita su altri device.
    let dedupNow = 0;
    if (dedupByName) {
      const localTapsForTs = await db.taps.toArray();
      dedupNow = Math.max(
        Date.now(),
        ...localCounters.map((c) => Number(c.updatedAt) || 0),
        ...localTapsForTs.map((t) => Number(t.updatedAt) || 0),
        ...data.counters.map((c) => Number(c.updatedAt) || 0),
        ...data.taps.map((t) => Number(t.updatedAt) || 0),
      ) + 1;
    }

    let countersAdded = 0, countersUpdated = 0, countersAligned = 0, countersCollapsed = 0;
    for (const raw of data.counters) {
      const norm = normalizeCounter(raw);
      let local = byUid.get(norm.uid);

      // Bug A fix: se questo counter remoto è un duplicato interno al payload
      // (non è il canonical del suo gruppo), forziamo deletedAt così non viene
      // né allineato né aggiunto come alive.
      if (dedupByName && !norm.deletedAt) {
        const k = (norm.name || "").trim().toLowerCase();
        const canonicalUid = k ? nameCanonicalUid.get(k) : null;
        if (canonicalUid && canonicalUid !== norm.uid) {
          norm.deletedAt = dedupNow;
          norm.updatedAt = dedupNow;
          countersCollapsed++;
          console.debug(`[importAll dedupByName] collasso remoto "${norm.name}" uid ${norm.uid} (canonical: ${canonicalUid})`);
        }
      }

      if (!local && dedupByName && !norm.deletedAt) {
        const k = (norm.name || "").trim().toLowerCase();
        const candidates = k ? aliveByName.get(k) : null;
        if (candidates && candidates.length > 0) {
          const aligned = candidates.shift();
          if (candidates.length === 0) aliveByName.delete(k);
          const remoteNewer = norm.updatedAt > (aligned.updatedAt || 0);
          const patch = remoteNewer
            ? { uid: norm.uid, name: norm.name, color: norm.color, dailyTarget: norm.dailyTarget, updatedAt: norm.updatedAt, deletedAt: norm.deletedAt }
            : { uid: norm.uid };
          await db.counters.update(aligned.id, patch);
          const merged = { ...aligned, ...patch };
          byUid.set(norm.uid, merged);
          countersAligned++;
          console.debug(`[importAll dedupByName] allineato "${aligned.name}" uid ${aligned.uid} → ${norm.uid}`);
          continue;
        }
      }

      if (!local) {
        const id = await db.counters.add(norm);
        byUid.set(norm.uid, { ...norm, id });
        countersAdded++;
        console.debug(`[importAll] add counter ${norm.uid} ("${norm.name}") deletedAt=${norm.deletedAt}`);
      } else if (norm.updatedAt > (local.updatedAt || 0)) {
        await db.counters.update(local.id, {
          name: norm.name,
          color: norm.color,
          dailyTarget: norm.dailyTarget,
          updatedAt: norm.updatedAt,
          deletedAt: norm.deletedAt,
        });
        byUid.set(norm.uid, { ...local, ...norm });
        countersUpdated++;
      }
    }

    const counterUidToId = new Map([...byUid.entries()].map(([uid, c]) => [uid, c.id]));

    const localTaps = await db.taps.toArray();
    const tapByUid = new Map(localTaps.map((t) => [t.uid, t]));

    let tapsAdded = 0, tapsUpdated = 0, tapsSkipped = 0;
    for (const raw of data.taps) {
      const counterUid = resolveCounterUidForLegacyTap(raw, data);
      if (!counterUid) { tapsSkipped++; continue; }
      const counterId = counterUidToId.get(counterUid);
      if (counterId == null) { tapsSkipped++; continue; }

      const norm = normalizeTap(raw, counterUid);
      const local = tapByUid.get(norm.uid);
      if (!local) {
        await db.taps.add({
          uid: norm.uid,
          counterId,
          timestamp: norm.timestamp,
          updatedAt: norm.updatedAt,
          deletedAt: norm.deletedAt,
        });
        tapsAdded++;
      } else if (norm.updatedAt > (local.updatedAt || 0)) {
        await db.taps.update(local.id, {
          counterId,
          timestamp: norm.timestamp,
          updatedAt: norm.updatedAt,
          deletedAt: norm.deletedAt,
        });
        tapsUpdated++;
      }
    }

    return { mode, countersAdded, countersUpdated, countersAligned, countersCollapsed, tapsAdded, tapsUpdated, tapsSkipped };
  });
}

async function applyImportedSettings(settings, uidToId) {
  if (!settings) return;
  if (settings.sync && settings.sync.endpoint && settings.sync.token) {
    localStorage.setItem(SYNC_CFG_KEY, JSON.stringify({
      endpoint: settings.sync.endpoint,
      token: settings.sync.token,
    }));
  }
  if (settings.lastCounterUid) {
    const id = uidToId.get(settings.lastCounterUid);
    if (id != null) setLastCounterId(id);
    else await setLastCounterByUid(settings.lastCounterUid);
  }
}

/* ── Date helpers ───────────────────────────────────────────── */

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
export function endOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
export function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay() || 7;
  x.setDate(x.getDate() - day + 1);
  return x.getTime();
}
export function startOfMonth(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(1);
  return x.getTime();
}
export function startOfYear(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setMonth(0, 1);
  return x.getTime();
}
export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
export function addMonths(ts, n) {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}
export function addYears(ts, n) {
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + n);
  return d.getTime();
}
