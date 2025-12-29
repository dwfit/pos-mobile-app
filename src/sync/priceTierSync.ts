// src/sync/priceTierSync.ts
import { get } from "../lib/api";
import {
  ensurePriceTierTable,
  getPriceTiersFromLocal,
  getPriceTiersLastUpdated,
  upsertPriceTiers,
  deletePriceTiersByIds,
  LocalPriceTier,
} from "../database/priceTiersLocal";

export type PriceTier = {
  id: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
  branchId?: string | null;
  brandId?: string | null;
  updatedAt?: string | null;
};

// Shape you return from backend – example:
type PriceTierSyncResponse = {
  tiers: PriceTier[];
  deletedIds?: string[];
};

type LoadOptions = {
  branchId?: string;
  brandId?: string;
};

/**
 * Offline-first load:
 * 1) load from SQLite
 * 2) try to sync with server and update SQLite
 * 3) return latest list (server if success, local if fail)
 */
export async function loadPriceTiersWithSync(
  opts: LoadOptions
): Promise<{ tiers: LocalPriceTier[] }> {
  await ensurePriceTierTable();

  const localBefore = await getPriceTiersFromLocal(opts);

  let resultTiers = localBefore;

  // Get last updated to use as "since" for incremental sync
  const lastUpdated = await getPriceTiersLastUpdated();

  try {
    const params = new URLSearchParams();
    if (opts.branchId) params.append("branchId", opts.branchId);
    if (opts.brandId) params.append("brandId", opts.brandId);
    if (lastUpdated) params.append("since", lastUpdated);

    const resp = await get<PriceTierSyncResponse>(
      `/pricing/tiers?${params.toString()}`
    );

    if (resp?.tiers?.length || resp?.deletedIds?.length) {
      // Upsert new/updated tiers
      if (resp.tiers?.length) {
        await upsertPriceTiers(resp.tiers);
      }

      // Remove deleted ones if server returns them
      if (resp.deletedIds?.length) {
        await deletePriceTiersByIds(resp.deletedIds);
      }
    }

    // load again from DB (latest)
    resultTiers = await getPriceTiersFromLocal(opts);
  } catch (err) {
    console.log("❌ loadPriceTiersWithSync: server sync failed, using local only", err);
    // keep resultTiers = localBefore
  }

  return { tiers: resultTiers };
}
