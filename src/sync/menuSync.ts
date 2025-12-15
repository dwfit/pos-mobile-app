// src/sync/menuSync.ts
import { get } from '../lib/api';
import { getDb, runTransaction } from '../database/db';

type ApiCategory = {
  id: string;
  name: string;
  imageUrl?: string | null;
  isActive?: boolean;
};

type ApiSize = {
  id: string;
  name: string;
  price: number | string | null;
};

type ApiProduct = {
  id: string;
  categoryId: string;
  name: string;
  basePrice?: number | string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  sizes?: ApiSize[];
};

function normalizePrice(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (raw == null) return 0;
  const n = parseFloat(String(raw));
  return Number.isNaN(n) ? 0 : n;
}

export async function syncMenu() {
  console.log('🔄 syncMenu started');

  let cats: ApiCategory[] = [];
  let prods: ApiProduct[] = [];

  // 1) Fetch from API
  try {
    const catsResp = await get('/menu/categories');
    const prodsResp = await get('/menu/products'); // change path if needed

    cats = Array.isArray(catsResp) ? (catsResp as ApiCategory[]) : [];
    prods = Array.isArray(prodsResp) ? (prodsResp as ApiProduct[]) : [];

    console.log(
      `🌐 menu API → ${cats.length} categories, ${prods.length} products`,
    );
  } catch (err) {
    console.log('❌ syncMenu API error:', err);
    // do NOT wipe local cache on API error
    return;
  }

  // No new data → keep existing cache
  if (!cats.length && !prods.length) {
    console.log(
      'ℹ️ syncMenu: API returned no categories & no products, skipping local overwrite',
    );
    return;
  }

  const db = await getDb();

  // 2) Save to SQLite in a manual transaction
  await runTransaction(async (dbTx) => {
    console.log('🧹 syncMenu: clearing old menu tables');

    await dbTx.execAsync('DELETE FROM product_sizes;');
    await dbTx.execAsync('DELETE FROM products;');
    await dbTx.execAsync('DELETE FROM categories;');

    console.log('💾 syncMenu: inserting categories…');

    for (const c of cats) {
      await dbTx.runAsync(
        `
        INSERT OR REPLACE INTO categories
          (id, name, imageUrl, isActive)
        VALUES (?, ?, ?, ?);
      `,
        c.id,
        c.name,
        c.imageUrl ?? null,
        c.isActive ? 1 : 0,
      );
    }

    console.log('💾 syncMenu: inserting products & sizes…');

    for (const p of prods) {
      const price = normalizePrice(
        p.basePrice ??
          (p.sizes && p.sizes.length > 0 ? p.sizes[0].price : 0),
      );

      await dbTx.runAsync(
        `
        INSERT OR REPLACE INTO products
          (id, categoryId, name, price, imageUrl, isActive)
        VALUES (?, ?, ?, ?, ?, ?);
      `,
        p.id,
        p.categoryId,
        p.name,
        price,
        p.imageUrl ?? null,
        p.isActive ? 1 : 0,
      );

      if (p.sizes && p.sizes.length > 0) {
        for (const s of p.sizes) {
          const sPrice = normalizePrice(s.price);
          await dbTx.runAsync(
            `
            INSERT OR REPLACE INTO product_sizes
              (id, productId, name, price)
            VALUES (?, ?, ?, ?);
          `,
            s.id,
            p.id,
            s.name,
            sPrice,
          );
        }
      }
    }
  });

  console.log(
    `✅ syncMenu done → saved ${cats.length} categories, ${prods.length} products to SQLite`,
  );
}
