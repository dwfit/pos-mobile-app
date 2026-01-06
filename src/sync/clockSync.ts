// src/sync/clockSync.ts
import { getDb } from "../database/db";
import { post } from "../lib/api";
import {
  markShiftSynced,
  markTillSynced,
  cleanupOldClockData,
} from "../database/clockLocal";

export async function syncClockAndTill() {
  const db = getDb();

  // small helper to run SELECT
  function select<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      db.transaction((tx) => {
        tx.executeSql(
          sql,
          params,
          (_t, { rows }) => resolve(rows._array as any),
          (_t, err) => {
            reject(err);
            return false;
          }
        );
      });
    });
  }

  // 1) sync shifts
  const pendingShifts = await select(
    `SELECT * FROM local_shifts WHERE synced = 0 ORDER BY createdAt ASC`
  );

  for (const s of pendingShifts) {
    try {
      // if no serverId -> create or ensure exists
      if (!s.serverId && s.status === "OPEN") {
        const res: any = await post("/pos/clock-in", {
          branchId: s.branchId,
          brandId: s.brandId,
          deviceId: s.deviceId,
          clientId: s.id, // optional for idempotency on backend
          clockInAt: s.clockInAt,
        });
        await markShiftSynced(s.id, res.shiftId || res.id);
      }

      // if CLOSED and has serverId, ensure backend closed
      if (s.status === "CLOSED") {
        await post("/pos/clock-out", {
          branchId: s.branchId,
          brandId: s.brandId,
          deviceId: s.deviceId,
          clientId: s.id,
          clockOutAt: s.clockOutAt,
        });

        // mark synced if not already
        if (!s.serverId) {
          // if backend returns id, you can store here; for now just mark synced
          await markShiftSynced(s.id, s.serverId || "");
        }
      }
    } catch (e) {
      console.log("syncClockAndTill shift error", e);
      // don't throw, continue with next; will retry next time
    }
  }

  // 2) sync tills
  const pendingTills = await select(
    `SELECT * FROM local_till_sessions WHERE synced = 0 ORDER BY createdAt ASC`
  );

  for (const t of pendingTills) {
    try {
      if (!t.serverId && t.status === "OPEN") {
        const res: any = await post("/pos/till/open", {
          branchId: t.branchId,
          brandId: t.brandId,
          deviceId: t.deviceId,
          openingCash: t.openingCash,
          clientId: t.id,
          openedAt: t.openedAt,
        });
        await markTillSynced(t.id, res.tillSessionId || res.id);
      }

      if (t.status === "CLOSED") {
        await post("/pos/till/close", {
          tillSessionId: t.serverId || undefined,
          branchId: t.branchId,
          brandId: t.brandId,
          deviceId: t.deviceId,
          closingCash: t.closingCash || 0,
          clientId: t.id,
          closedAt: t.closedAt,
        });

        if (!t.serverId) {
          await markTillSynced(t.id, t.serverId || "");
        }
      }
    } catch (e) {
      console.log("syncClockAndTill till error", e);
    }
  }

  // 3) after successful run, cleanup old synced rows ( > 1 day )
  await cleanupOldClockData();
}
