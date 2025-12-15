// src/database/ordersLocal.ts
import { getDb } from './db';

export type LocalOrder = {
  id: string;
  orderNo: string;
  branchId: string;
  businessDate: string; // e.g. "2025-11-24"
  status: string;
  channel: string | null;
  netTotal: number;
};

export async function saveOrdersToSQLite(orders: LocalOrder[]) {
  try {
    const db = await getDb();

    // 🔹 clear existing cached orders
    await db.execAsync('DELETE FROM orders_local;');

    // 🔹 re-insert all orders (same INSERT OR REPLACE as before)
    for (const o of orders) {
      await db.runAsync(
        `
        INSERT OR REPLACE INTO orders_local
          (id, orderNo, branchId, businessDate, status, channel, netTotal)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
        o.id,
        o.orderNo,
        o.branchId,
        o.businessDate,
        o.status,
        o.channel ?? null,
        o.netTotal,
      );
    }

    console.log('✅ saveOrdersToSQLite stored', orders.length, 'orders');
  } catch (err) {
    console.log('ORDERS ERR (saveOrdersToSQLite)', err);
    throw err;
  }
}

export async function loadOrdersFromSQLite(): Promise<LocalOrder[]> {
  try {
    const db = await getDb();

    const rows = await db.getAllAsync<LocalOrder>(
      `
      SELECT id, orderNo, branchId, businessDate, status, channel, netTotal
      FROM orders_local
      ORDER BY businessDate DESC, orderNo DESC
      LIMIT 200
      `,
    );

    console.log('📦 loadOrdersFromSQLite →', rows.length, 'rows');
    return rows;
  } catch (err) {
    console.log('ORDERS ERR (loadOrdersFromSQLite)', err);
    return [];
  }
}
