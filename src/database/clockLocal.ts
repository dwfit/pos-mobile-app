// src/database/clockLocal.ts
import { execSql, queryAll } from "./db";
import { getDb } from "./db";

/**
 * Simple local ID generator that does NOT use crypto or uuid.
 * Good enough for offline client-side IDs.
 */
function makeLocalId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

export type LocalShiftRow = {
  id: string;
  userId: string | null;
  branchId: string;
  brandId: string | null;
  deviceId: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  status: "OPEN" | "CLOSED";
  synced: number; // 0/1
  serverId: string | null;
  createdAt: string;
};

export type LocalTillRow = {
  id: string;
  shiftLocalId: string;
  branchId: string;
  brandId: string | null;
  deviceId: string | null;
  openingCash: number;
  closingCash: number | null;
  openedAt: string;
  closedAt: string | null;
  status: "OPEN" | "CLOSED";
  synced: number; // 0/1
  serverId: string | null;
  createdAt: string;
};

/* ------------------ SHIFTS ------------------ */

/**
 * Create a local shift row for offline clock-in.
 * You can pass either a real userId or just the userName for now.
 */
export async function createLocalShift(params: {
  userId?: string | null; // optional; you can pass userName here temporarily
  branchId: string;
  brandId?: string | null;
  deviceId?: string | null;
}): Promise<string> {
  const id = makeLocalId();
  const now = new Date().toISOString();

  await execSql(
    `
      INSERT INTO local_shifts
        (id, userId, branchId, brandId, deviceId,
         clockInAt, clockOutAt, status, synced, serverId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'OPEN', 0, NULL, ?);
    `,
    [
      id,
      params.userId || null,
      params.branchId,
      params.brandId || null,
      params.deviceId || null,
      now,
      now,
    ]
  );

  return id;
}

/**
 * Close a local shift (clock-out).
 * If you later add sync status updates, you can extend this.
 */
export async function closeLocalShift(
  localShiftId: string | undefined | null
): Promise<void> {
  if (!localShiftId) return;
  const now = new Date().toISOString();

  await execSql(
    `
      UPDATE local_shifts
      SET status = 'CLOSED',
          clockOutAt = ?
      WHERE id = ?;
    `,
    [now, localShiftId]
  );
}

/* ------------------ TILL SESSIONS ------------------ */

export async function createLocalTill(params: {
  shiftLocalId?: string | null; // optional for now
  branchId: string | null;
  brandId?: string | null;
  deviceId?: string | null;
  openingCash: number;
}): Promise<string> {
  const id = makeLocalId();
  const now = new Date().toISOString();

  if (!params.branchId) {
    throw new Error("Missing branchId for local till");
  }

  await execSql(
    `
      INSERT INTO local_till_sessions
        (id, shiftLocalId, branchId, brandId, deviceId,
         openingCash, closingCash, openedAt, closedAt,
         status, synced, serverId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL,
              'OPEN', 0, NULL, ?);
    `,
    [
      id,
      params.shiftLocalId || null,
      params.branchId,
      params.brandId || null,
      params.deviceId || null,
      params.openingCash,
      now,
      now,
    ]
  );

  return id;
}

export async function closeLocalTill(
  localTillId: string | undefined | null,
  closingCash?: number
): Promise<void> {
  if (!localTillId) return;
  const now = new Date().toISOString();

  await execSql(
    `
      UPDATE local_till_sessions
      SET status = 'CLOSED',
          closedAt = ?,
          closingCash = COALESCE(?, closingCash)
      WHERE id = ?;
    `,
    [now, closingCash ?? null, localTillId]
  );
}

/**
 * ✅ NEW: Load a till session (needed for report generation)
 */
export async function getLocalTillSession(
  localTillId: string
): Promise<LocalTillRow> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT * FROM local_till_sessions WHERE id = ? LIMIT 1;`,
    [localTillId]
  );

  if (!row) throw new Error("Till session not found");
  return row as LocalTillRow;
}

// alias if you like
export const getTillSessionById = getLocalTillSession;

/* -------- OPTIONAL: helpers for sync layer -------- */

export async function getPendingShifts(): Promise<LocalShiftRow[]> {
  return queryAll<LocalShiftRow>(
    `SELECT * FROM local_shifts WHERE synced = 0 ORDER BY createdAt ASC;`
  );
}

export async function getPendingTills(): Promise<LocalTillRow[]> {
  return queryAll<LocalTillRow>(
    `SELECT * FROM local_till_sessions WHERE synced = 0 ORDER BY createdAt ASC;`
  );
}

export async function markShiftSynced(
  localId: string,
  serverId: string
): Promise<void> {
  await execSql(
    `
      UPDATE local_shifts
      SET synced = 1,
          serverId = ?
      WHERE id = ?;
    `,
    [serverId, localId]
  );
}

export async function markTillSynced(
  localId: string,
  serverId: string
): Promise<void> {
  await execSql(
    `
      UPDATE local_till_sessions
      SET synced = 1,
          serverId = ?
      WHERE id = ?;
    `,
    [serverId, localId]
  );
}
