// src/reports/tillCloseReport.ts
import { getDb } from "../database/db";

export type TillCloseReport = {
  tillSessionId: string;
  branchId: string | null;
  brandId: string | null;
  deviceId: string | null;

  branchName: string;
  userName: string;

  openedAt: string;
  closedAt: string;

  openingCash: number;
  closingCash: number;

  totals: {
    ordersCount: number;
    netSales: number;
    taxTotal: number;
    discountTotal: number;
  };

  payments: { methodName: string; total: number }[];

  cash: {
    cashSales: number;
    expectedCash: number;
    variance: number;
  };
};

async function tableExists(table: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;`,
    [table]
  );
  return !!row?.name;
}

async function pickFirstExisting(candidates: string[]): Promise<string | null> {
  for (const t of candidates) {
    if (await tableExists(t)) return t;
  }
  return null;
}

/**
 * Best-effort report generator:
 * - If local order/payment tables exist => sum them
 * - If they don't => return zeros (do NOT fail till close)
 */
export async function generateTillCloseReport(input: {
  tillSessionId: string;
  branchId: string | null;
  brandId: string | null;
  deviceId: string | null;
  branchName: string;
  userName: string;
  openingCash: number;
  closingCash: number;
  openedAt: string;
  closedAt: string;
}): Promise<TillCloseReport> {
  const db = await getDb();

  // ✅ Try common table names (adjust/add your real ones here)
  const ordersTable = await pickFirstExisting([
    "local_orders",
    "orders_local",
    "local_order",
    "orders",
    "pos_orders",
  ]);

  const paymentsTable = await pickFirstExisting([
    "local_payments",
    "payments_local",
    "local_order_payments",
    "order_payments",
    "payments",
  ]);

  let ordersCount = 0;
  let netSales = 0;
  let taxTotal = 0;
  let discountTotal = 0;

  let payments: { methodName: string; total: number }[] = [];

  // ---------------- Orders aggregation ----------------
  if (ordersTable) {
    try {
      // We try a "standard" shape first.
      const rows = await db.getAllAsync<any>(
        `SELECT id, netTotal, taxTotal, discountTotal
         FROM ${ordersTable}
         WHERE (status = 'CLOSED' OR status = 'closed' OR status = 1 OR status = '1')
           AND (createdAt >= ? AND createdAt <= ?)`,
        [input.openedAt, input.closedAt]
      );

      ordersCount = rows.length;
      for (const o of rows) {
        netSales += Number(o?.netTotal ?? 0);
        taxTotal += Number(o?.taxTotal ?? 0);
        discountTotal += Number(o?.discountTotal ?? 0);
      }
    } catch (e) {
      // If schema differs, don't fail till close
      console.log("⚠️ Till report orders query failed", {
        table: ordersTable,
        error: e,
      });
    }
  } else {
    console.log("⚠️ Till report: no local orders table found");
  }

  // ---------------- Payments aggregation ----------------
  if (paymentsTable) {
    try {
      // Standard: methodName + amount + createdAt
      const payRows = await db.getAllAsync<any>(
        `SELECT methodName as methodName, SUM(amount) as total
         FROM ${paymentsTable}
         WHERE (createdAt >= ? AND createdAt <= ?)
         GROUP BY methodName`,
        [input.openedAt, input.closedAt]
      );

      payments = (payRows || []).map((p: any) => ({
        methodName: String(p.methodName || "Unknown"),
        total: Number(p.total || 0),
      }));
    } catch (e) {
      console.log("⚠️ Till report payments query failed", {
        table: paymentsTable,
        error: e,
      });
    }
  } else {
    console.log("⚠️ Till report: no local payments table found");
  }

  const cashSales =
    Number(
      payments.find((p) => p.methodName.toLowerCase() === "cash")?.total || 0
    ) || 0;

  const expectedCash = Number(input.openingCash) + cashSales;
  const variance = Number(input.closingCash) - expectedCash;

  return {
    tillSessionId: input.tillSessionId,
    branchId: input.branchId,
    brandId: input.brandId,
    deviceId: input.deviceId,
    branchName: input.branchName,
    userName: input.userName,
    openedAt: input.openedAt,
    closedAt: input.closedAt,
    openingCash: Number(input.openingCash || 0),
    closingCash: Number(input.closingCash || 0),
    totals: {
      ordersCount,
      netSales,
      taxTotal,
      discountTotal,
    },
    payments,
    cash: { cashSales, expectedCash, variance },
  };
}

// Keep your formatter if you still use it in ClockInScreen
export function formatTillCloseReportText(r: TillCloseReport) {
  const money = (n: any) => Number(n || 0).toFixed(2);
  const lines: string[] = [];
  lines.push("DWF POS");
  lines.push("TILL CLOSE REPORT");
  lines.push("--------------------------------");
  lines.push(`Branch: ${r.branchName}`);
  lines.push(`Cashier: ${r.userName}`);
  lines.push(`Opened: ${r.openedAt}`);
  lines.push(`Closed: ${r.closedAt}`);
  lines.push("--------------------------------");
  lines.push(`Orders: ${r.totals.ordersCount}`);
  lines.push(`Net Sales: ${money(r.totals.netSales)}`);
  lines.push(`Tax: ${money(r.totals.taxTotal)}`);
  lines.push(`Discounts: ${money(r.totals.discountTotal)}`);
  lines.push("--------------------------------");
  lines.push("Payments:");
  if (!r.payments.length) lines.push("  (none)");
  for (const p of r.payments) lines.push(`  ${p.methodName}: ${money(p.total)}`);
  lines.push("--------------------------------");
  lines.push(`Opening Cash: ${money(r.openingCash)}`);
  lines.push(`Cash Sales: ${money(r.cash.cashSales)}`);
  lines.push(`Expected Cash: ${money(r.cash.expectedCash)}`);
  lines.push(`Counted Cash: ${money(r.closingCash)}`);
  lines.push(`Variance: ${money(r.cash.variance)}`);
  lines.push("\n\n");
  return lines.join("\n");
}
