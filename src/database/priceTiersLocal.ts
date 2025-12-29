// src/database/priceTiersLocal.ts
import { getDb } from "./db";

export type LocalPriceTier = {
  id: string;
  name: string;
  code: string | null;
  isActive: number; // 1 / 0
  branchId: string | null;
  brandId: string | null;
  updatedAt: string | null; // ISO string
};

/* ----------------------- ensure table exists ----------------------- */

export async function ensurePriceTierTable() {
  const db = await getDb();

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS price_tiers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      isActive INTEGER NOT NULL DEFAULT 1,
      branchId TEXT,
      brandId TEXT,
      updatedAt TEXT
    );
  `);
}

/* --------------------------- load local ---------------------------- */

export async function getPriceTiersFromLocal(opts: {
  branchId?: string;
  brandId?: string;
}): Promise<LocalPriceTier[]> {
  const db = await getDb();
  const { branchId, brandId } = opts;

  let where = "";
  const params: any[] = [];

  if (branchId) {
    where += (where ? " AND " : " WHERE ") + "branchId = ?";
    params.push(branchId);
  }
  if (brandId) {
    where += (where ? " AND " : " WHERE ") + "brandId = ?";
    params.push(brandId);
  }

  const rows = await db.getAllAsync<LocalPriceTier>(
    `SELECT * FROM price_tiers${where} ORDER BY name ASC`,
    params
  );

  return rows;
}

/* ---------------------- last updated timestamp --------------------- */

export async function getPriceTiersLastUpdated(): Promise<string | null> {
  const db = await getDb();

  const row = await db.getFirstAsync<{ lastUpdated: string | null }>(
    `SELECT MAX(updatedAt) as lastUpdated FROM price_tiers`,
    []
  );

  return row?.lastUpdated ?? null;
}

/* --------------------------- save / upsert ------------------------- */

type RemotePriceTier = {
  id: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
  branchId?: string | null;
  brandId?: string | null;
  updatedAt?: string | null; // ISO from API
};

export async function upsertPriceTiers(
  tiers: RemotePriceTier[]
): Promise<void> {
  if (!tiers?.length) return;

  const db = await getDb();

  await db.execAsync("BEGIN");

  try {
    for (const t of tiers) {
      await db.runAsync(
        `
        INSERT INTO price_tiers (id, name, code, isActive, branchId, brandId, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          code = excluded.code,
          isActive = excluded.isActive,
          branchId = excluded.branchId,
          brandId = excluded.brandId,
          updatedAt = excluded.updatedAt;
      `,
        [
          t.id,
          t.name,
          t.code ?? null,
          t.isActive === false ? 0 : 1,
          t.branchId ?? null,
          t.brandId ?? null,
          t.updatedAt ?? new Date().toISOString(),
        ]
      );
    }

    await db.execAsync("COMMIT");
  } catch (err) {
    await db.execAsync("ROLLBACK");
    console.error("upsertPriceTiers error:", err);
    throw err;
  }
}

/* ---------------------- handle deleted from API -------------------- */

export async function deletePriceTiersByIds(ids: string[]): Promise<void> {
  if (!ids?.length) return;
  const db = await getDb();

  const placeholders = ids.map(() => "?").join(",");
  await db.runAsync(
    `DELETE FROM price_tiers WHERE id IN (${placeholders})`,
    ids
  );
}
