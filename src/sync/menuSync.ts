// src/sync/menuSync.ts
import { get } from "../lib/api";
import { getDb, runTransaction } from "../database/db";

/* ============================== Types ============================== */

export type SyncMenuOpts = {
  brandId: string;
  includeInactive?: boolean; // default true
  forceFull?: boolean; // default true
  since?: string; // used only when forceFull=false
};

type ApiCategory = {
  id: string;
  name: string;
  imageUrl?: string | null;
  isActive?: boolean | null;
  sort?: number | null;
  updatedAt?: string | null;
};

type ApiProduct = {
  id: string;
  categoryId: string | null;
  sku?: string | null;
  name: string;
  imageUrl?: string | null;
  basePrice?: number | string | null;
  taxRate?: number | string | null;
  taxId?: string | number | null;
  isActive?: boolean | null;
  updatedAt?: string | null;
};

type ApiSize = {
  id: string;
  productId: string;
  name: string;
  price: number | string | null;
  code?: string | null;
};

/* ============================== Helpers ============================== */

function normalizePrice(raw: any): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return 0;
  const n = parseFloat(String(raw));
  return Number.isNaN(n) ? 0 : n;
}

// ✅ IMPORTANT FIX: default active unless explicitly false
function toSqliteBoolActive(v: any): number {
  return v === false ? 0 : 1;
}

function isoOr1970(v?: string) {
  const s = String(v || "").trim();
  if (!s) return "1970-01-01T00:00:00.000Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "1970-01-01T00:00:00.000Z" : d.toISOString();
}

/* ============================== Sync ============================== */

export async function syncMenu(opts: SyncMenuOpts) {
  const brandId = String(opts?.brandId || "").trim();
  if (!brandId) {
    console.log("❌ syncMenu: brandId is required");
    return;
  }

  const includeInactive =
    typeof opts.includeInactive === "boolean" ? opts.includeInactive : true;

  const forceFull =
    typeof opts.forceFull === "boolean" ? opts.forceFull : true;

  const since =
    !forceFull && opts.since ? isoOr1970(opts.since) : "1970-01-01T00:00:00.000Z";

  console.log("🔄 syncMenu started", {
    brandId,
    includeInactive,
    forceFull,
    since,
  });

  /* ------------------ 1) Fetch from API ------------------ */

  let categories: ApiCategory[] = [];
  let products: ApiProduct[] = [];
  let sizes: ApiSize[] = [];

  try {
    const qs =
      `?brandId=${encodeURIComponent(brandId)}` +
      `&includeInactive=${includeInactive ? "true" : "false"}` +
      `&forceFull=${forceFull ? "true" : "false"}` +
      `&since=${encodeURIComponent(since)}`;

    const resp = await get(`/pos/sync/menu${qs}`);

    categories = Array.isArray(resp?.categories) ? resp.categories : [];
    products = Array.isArray(resp?.products) ? resp.products : [];
    sizes = Array.isArray(resp?.sizes) ? resp.sizes : [];

    console.log(
      `🌐 pos/sync/menu → ${categories.length} categories, ${products.length} products, ${sizes.length} sizes`
    );
  } catch (err) {
    console.log("❌ syncMenu API error:", err);
    // ✅ do NOT wipe local cache on API error
    return;
  }

  // ✅ No new data → keep existing cache
  if (!categories.length && !products.length && !sizes.length) {
    console.log(
      "ℹ️ syncMenu: API returned no categories/products/sizes, skipping local overwrite"
    );
    return;
  }

  /* ------------------ 2) Save to SQLite ------------------ */

  const db = await getDb();

  await runTransaction(async (dbTx) => {
    if (forceFull) {
      console.log("🧹 syncMenu: clearing old menu tables (forceFull=true)");
      await dbTx.execAsync("DELETE FROM product_sizes;");
      await dbTx.execAsync("DELETE FROM products;");
      await dbTx.execAsync("DELETE FROM categories;");
    } else {
      console.log("➕ syncMenu: incremental upsert (forceFull=false)");
      // no deletes; upsert only
    }

    console.log("💾 syncMenu: inserting categories…");
    for (const c of categories) {
      await dbTx.runAsync(
        `
        INSERT OR REPLACE INTO categories
          (id, name, imageUrl, isActive)
        VALUES (?, ?, ?, ?);
        `,
        c.id,
        c.name,
        c.imageUrl ?? null,
        toSqliteBoolActive(c.isActive) // ✅ FIX (default = 1)
      );
    }

    console.log("💾 syncMenu: inserting products…");
    for (const p of products) {
      const price = normalizePrice(p.basePrice ?? 0);

      await dbTx.runAsync(
        `
        INSERT OR REPLACE INTO products
          (id, categoryId, name, price, imageUrl, isActive)
        VALUES (?, ?, ?, ?, ?, ?);
        `,
        p.id,
        p.categoryId ?? null,
        p.name,
        price,
        p.imageUrl ?? null,
        toSqliteBoolActive(p.isActive)
      );
    }

    console.log("💾 syncMenu: inserting sizes…");
    for (const s of sizes) {
      const sPrice = normalizePrice(s.price);

      await dbTx.runAsync(
        `
        INSERT OR REPLACE INTO product_sizes
          (id, productId, name, price)
        VALUES (?, ?, ?, ?);
        `,
        s.id,
        s.productId,
        s.name,
        sPrice
      );
    }
  });

  /* ------------------ 3) Debug counts (VERY IMPORTANT) ------------------ */

  try {
    const db2 = await getDb();

    // NOTE: use getFirstAsync if your wrapper supports it; otherwise replace with your own helper
    const totalCats = await (db2 as any).getFirstAsync?.(
      "SELECT COUNT(*) as c FROM categories;"
    );
    const activeCats = await (db2 as any).getFirstAsync?.(
      "SELECT COUNT(*) as c FROM categories WHERE isActive = 1;"
    );

    console.log("✅ SQLite categories counts:", {
      total: totalCats?.c ?? "(no getFirstAsync)",
      active: activeCats?.c ?? "(no getFirstAsync)",
    });
  } catch (e) {
    console.log("ℹ️ SQLite count debug skipped:", e);
  }

  console.log(
    `✅ syncMenu done → saved ${categories.length} categories, ${products.length} products, ${sizes.length} sizes`
  );
}
