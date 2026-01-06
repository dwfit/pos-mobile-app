// src/database/db.ts
import * as SQLite from 'expo-sqlite';

// Keep a single DB instance for the whole app (sync open)
let _db: SQLite.SQLiteDatabase | null = null;

/** Get (or open) the SQLite DB instance (new async API, sync open). */
export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync('pos.db');
    console.log('📦 SQLite DB opened');
  }
  return _db;
}

/** Run a SQL SELECT and return rows as plain array. */
export async function queryAll<T = any>(
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  try {
    const db = getDb();
    // getAllAsync takes params as variadic args
    const rows = await db.getAllAsync<T>(sql, ...params);
    return rows;
  } catch (err) {
    console.log('SQLite queryAll error:', err);
    throw err;
  }
}

/** Run a SQL statement that doesn't need rows (CREATE/INSERT/UPDATE/DELETE). */
export async function execSql(
  sql: string,
  params: any[] = [],
): Promise<void> {
  try {
    const db = getDb();

    // No params → simple exec
    if (!params.length) {
      await db.execAsync(sql);
      return;
    }

    // With params → use prepared statement
    const stmt = await db.prepareAsync(sql);
    try {
      await stmt.executeAsync(params);
    } finally {
      await stmt.finalizeAsync();
    }
  } catch (err) {
    console.log('SQLite execSql error:', err);
    throw err;
  }
}

/** Simple manual transaction helper (BEGIN / COMMIT / ROLLBACK). */
export async function runTransaction(
  fn: (db: SQLite.SQLiteDatabase) => Promise<void>,
): Promise<void> {
  const db = getDb();
  await db.execAsync('BEGIN');
  try {
    await fn(db);
    await db.execAsync('COMMIT');
  } catch (err) {
    await db.execAsync('ROLLBACK');
    throw err;
  }
}

/** Initialise DB and create tables. Call once at app startup. */
export async function initDatabase() {
  try {
    const db = getDb();

    // 1) Base schema (for fresh installs) – one statement at a time
    await execSql('PRAGMA journal_mode = WAL;');

    await execSql(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT,
        imageUrl TEXT,
        isActive INTEGER
      );
    `);

    await execSql(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        categoryId TEXT,
        name TEXT,
        price REAL,
        imageUrl TEXT,
        isActive INTEGER
      );
    `);

    await execSql(`
      CREATE TABLE IF NOT EXISTS product_sizes (
        id TEXT PRIMARY KEY,
        productId TEXT,
        name TEXT,
        price REAL
      );
    `);

    await execSql(`
      CREATE TABLE IF NOT EXISTS modifiers (
        id TEXT PRIMARY KEY,
        productId TEXT,
        name TEXT,
        price REAL
      );
    `);

    await execSql(`
      CREATE TABLE IF NOT EXISTS orders_local (
        id TEXT PRIMARY KEY,
        orderNo TEXT,
        branchId TEXT,
        businessDate TEXT,
        status TEXT,
        channel TEXT,
        netTotal REAL
      );
    `);

    /**
     * 🔹 NEW: local_shifts
     * For offline clock-in / clock-out.
     * synced = 0 (pending), 1 (synced to server)
     * createdAt used later for cleanup (keep last 1 day only).
     */
    await execSql(`
      CREATE TABLE IF NOT EXISTS local_shifts (
        id TEXT PRIMARY KEY,
        userId TEXT,
        branchId TEXT,
        brandId TEXT,
        deviceId TEXT,
        clockInAt TEXT,
        clockOutAt TEXT,
        status TEXT,
        synced INTEGER,
        serverId TEXT,
        createdAt TEXT
      );
    `);

    /**
     * 🔹 NEW: local_till_sessions
     * For offline till open / close.
     */
    await execSql(`
      CREATE TABLE IF NOT EXISTS local_till_sessions (
        id TEXT PRIMARY KEY,
        shiftLocalId TEXT,
        branchId TEXT,
        brandId TEXT,
        deviceId TEXT,
        openingCash REAL,
        closingCash REAL,
        openedAt TEXT,
        closedAt TEXT,
        status TEXT,
        synced INTEGER,
        serverId TEXT,
        createdAt TEXT
      );
    `);

    // 2) Migrations for old installs (check columns first with PRAGMA)

    // ---- categories columns ----
    const catCols = await queryAll<{ name: string }>(
      'PRAGMA table_info(categories);',
    );
    const catHasImageUrl = catCols.some((c) => c.name === 'imageUrl');
    const catHasIsActive = catCols.some((c) => c.name === 'isActive');

    if (!catHasImageUrl) {
      await execSql(`ALTER TABLE categories ADD COLUMN imageUrl TEXT;`);
      console.log('✅ Migration: categories.imageUrl added');
    } else {
      console.log('ℹ️ categories.imageUrl already exists, skipping');
    }

    if (!catHasIsActive) {
      await execSql(`ALTER TABLE categories ADD COLUMN isActive INTEGER;`);
      console.log('✅ Migration: categories.isActive added');
    } else {
      console.log('ℹ️ categories.isActive already exists, skipping');
    }

    // ---- products columns ----
    const prodCols = await queryAll<{ name: string }>(
      'PRAGMA table_info(products);',
    );
    const prodHasPrice = prodCols.some((c) => c.name === 'price');
    const prodHasImageUrl = prodCols.some((c) => c.name === 'imageUrl');
    const prodHasIsActive = prodCols.some((c) => c.name === 'isActive');

    if (!prodHasPrice) {
      await execSql(`ALTER TABLE products ADD COLUMN price REAL;`);
      console.log('✅ Migration: products.price added');
    } else {
      console.log('ℹ️ products.price already exists, skipping');
    }

    if (!prodHasImageUrl) {
      await execSql(`ALTER TABLE products ADD COLUMN imageUrl TEXT;`);
      console.log('✅ Migration: products.imageUrl added');
    } else {
      console.log('ℹ️ products.imageUrl already exists, skipping');
    }

    if (!prodHasIsActive) {
      await execSql(`ALTER TABLE products ADD COLUMN isActive INTEGER;`);
      console.log('✅ Migration: products.isActive added');
    } else {
      console.log('ℹ️ products.isActive already exists, skipping');
    }

    console.log('📦 SQLite tables created / migrated OK');
  } catch (err) {
    console.log('SQLite initDatabase error:', err);
    throw err;
  }
}
