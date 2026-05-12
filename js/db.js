import Dexie from "https://esm.sh/dexie@4.0.10";

export const SCHEMA_VERSION = 2;
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

export function pickColor(existingCount) {
  return PALETTE[existingCount % PALETTE.length];
}

export async function listCounters() {
  return db.counters.orderBy("createdAt").toArray();
}

export async function getCounter(id) {
  return db.counters.get(id);
}

export async function addCounter(name, color, dailyTarget = 0) {
  const count = await db.counters.count();
  const c = {
    name: name.trim(),
    color: color || pickColor(count),
    dailyTarget: Number(dailyTarget) || 0,
    createdAt: Date.now(),
  };
  c.id = await db.counters.add(c);
  return c;
}

export async function updateCounter(id, patch) {
  await db.counters.update(id, patch);
}

export async function renameCounter(id, newName) {
  await db.counters.update(id, { name: newName.trim() });
}

export async function setDailyTarget(id, value) {
  await db.counters.update(id, { dailyTarget: Number(value) || 0 });
}

export async function deleteCounter(id) {
  await db.transaction("rw", db.counters, db.taps, async () => {
    await db.taps.where("counterId").equals(id).delete();
    await db.counters.delete(id);
  });
}

export async function addTap(counterId, ts = Date.now()) {
  return db.taps.add({ counterId, timestamp: ts });
}

export async function deleteTap(tapId) {
  await db.taps.delete(tapId);
}

export async function removeLatestTap(counterId) {
  const latest = await db.taps
    .where("counterId").equals(counterId)
    .reverse().sortBy("timestamp");
  if (latest.length === 0) return null;
  await db.taps.delete(latest[0].id);
  return latest[0];
}

export async function getLatestTap(counterId) {
  const arr = await db.taps
    .where("counterId").equals(counterId)
    .reverse().sortBy("timestamp");
  return arr[0] || null;
}

export async function countTapsInRange(counterId, from, to) {
  return db.taps
    .where("[counterId+timestamp]")
    .between([counterId, from], [counterId, to], true, false)
    .count();
}

export async function getTapsInRange(counterId, from, to) {
  return db.taps
    .where("[counterId+timestamp]")
    .between([counterId, from], [counterId, to], true, false)
    .toArray();
}

export async function getAllTaps(counterId) {
  return db.taps.where("counterId").equals(counterId).sortBy("timestamp");
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

export async function exportAll() {
  const [counters, taps] = await Promise.all([
    db.counters.toArray(),
    db.taps.toArray(),
  ]);
  return {
    app: "contaapp",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counters,
    taps,
  };
}

export async function importAll(data, mode = "replace") {
  if (!data || data.app !== "contaapp" || !Array.isArray(data.counters) || !Array.isArray(data.taps)) {
    throw new Error("File non valido: non sembra un export di Counter.");
  }
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Versione del file (${data.schemaVersion}) più recente di quella supportata (${SCHEMA_VERSION}).`);
  }

  return db.transaction("rw", db.counters, db.taps, async () => {
    if (mode === "replace") {
      await db.taps.clear();
      await db.counters.clear();
      const idMap = new Map();
      for (const c of data.counters) {
        const newId = await db.counters.add({
          name: c.name,
          color: c.color || pickColor(idMap.size),
          dailyTarget: Number(c.dailyTarget) || 0,
          createdAt: c.createdAt || Date.now(),
        });
        idMap.set(c.id, newId);
      }
      let added = 0;
      for (const t of data.taps) {
        const newCid = idMap.get(t.counterId);
        if (newCid == null) continue;
        await db.taps.add({ counterId: newCid, timestamp: t.timestamp });
        added++;
      }
      return { mode, countersAdded: idMap.size, tapsAdded: added, tapsSkipped: 0 };
    }

    const existing = await db.counters.toArray();
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
    const idMap = new Map();
    let countersAdded = 0;
    for (const c of data.counters) {
      const key = (c.name || "").toLowerCase();
      const found = byName.get(key);
      if (found) {
        idMap.set(c.id, found.id);
      } else {
        const newId = await db.counters.add({
          name: c.name,
          color: c.color || pickColor(existing.length + countersAdded),
          dailyTarget: Number(c.dailyTarget) || 0,
          createdAt: c.createdAt || Date.now(),
        });
        idMap.set(c.id, newId);
        countersAdded++;
      }
    }

    let tapsAdded = 0, tapsSkipped = 0;
    for (const t of data.taps) {
      const newCid = idMap.get(t.counterId);
      if (newCid == null) { tapsSkipped++; continue; }
      const dup = await db.taps
        .where("[counterId+timestamp]")
        .equals([newCid, t.timestamp])
        .count();
      if (dup > 0) { tapsSkipped++; continue; }
      await db.taps.add({ counterId: newCid, timestamp: t.timestamp });
      tapsAdded++;
    }
    return { mode, countersAdded, tapsAdded, tapsSkipped };
  });
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
