// src/printing/printerService.ts

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  buildReceiptText,
  buildKitchenTicketText,
  BuildReceiptArgs,
  BuildKitchenArgs,
} from "./receiptTemplates";

const STORAGE_KEY = "pos_devices";

export type StoredDevice = {
  id: string;
  kind: string; // "Printer"
  model: string | null;
  typeLabel: string | null; // "Cashier", "Kitchen", "Order info", "Kitchen Sticky Printer"
  name: string;
  ip: string;
  enabledOrderTypes: string[]; // e.g. ["DINE_IN","DELIVERY"]

  // NEW: routing filters (stored as CSV of IDs)
  // category ids from your local menu
  categoryFilter?: string | null;
  // product ids from your local menu
  productFilter?: string | null;
};

export type ReceiptPrintArgs = BuildReceiptArgs;
export type KitchenPrintArgs = BuildKitchenArgs;

/** ✅ NEW: Till report type (keep it flexible) */
export type TillCloseReport = {
  branchName?: string;
  userName?: string;
  openedAt?: string;
  closedAt?: string;
  openingCash?: number;
  closingCash?: number;

  totals?: {
    ordersCount?: number;
    netSales?: number;
    taxTotal?: number;
    discountTotal?: number;
  };

  payments?: { methodName: string; total: number }[];

  cash?: {
    cashSales?: number;
    expectedCash?: number;
    variance?: number;
  };
};

async function loadPrinters(): Promise<StoredDevice[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((d) => d && d.kind === "Printer");
  } catch (e) {
    console.log("loadPrinters error", e);
    return [];
  }
}

// ---------- Helpers to pick printers -----------------

function matchesOrderType(device: StoredDevice, orderType?: string | null) {
  if (!orderType) return true;
  if (!Array.isArray(device.enabledOrderTypes)) return true;
  if (!device.enabledOrderTypes.length) return true;
  return device.enabledOrderTypes.includes(orderType);
}

/**
 * Cashier receipt printer – choose ONE best printer.
 */
function chooseReceiptPrinter(
  printers: StoredDevice[],
  orderType?: string | null
): StoredDevice | null {
  if (!printers.length) return null;

  // Try match by orderType + Cashier type
  if (orderType) {
    const match = printers.find(
      (d) => d.typeLabel === "Cashier" && matchesOrderType(d, orderType)
    );
    if (match) return match;
  }

  // Fallback: any Cashier printer
  const cashier = printers.find((d) => d.typeLabel === "Cashier");
  if (cashier) return cashier;

  // Last fallback: first printer
  return printers[0];
}

/**
 * Kitchen printers – return ALL matching kitchen printers.
 */
function chooseKitchenPrinters(
  printers: StoredDevice[],
  orderType?: string | null
): StoredDevice[] {
  return printers.filter((d) => {
    const label = (d.typeLabel || "").toLowerCase();
    const isKitchenType = label.includes("kitchen"); // Kitchen, Kitchen Sticky Printer, etc.
    if (!isKitchenType) return false;
    return matchesOrderType(d, orderType);
  });
}

// ---------- Filters for kitchen routing -----------------

function parseCsv(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decide if a single cart item should be printed on a given printer.
 * Priority:
 *  1) If printer has productFilter -> only those products
 *  2) Else if printer has categoryFilter -> only those categories
 *  3) Else -> everything
 */
function itemMatchesPrinterFilters(item: any, printer: StoredDevice): boolean {
  const productIds = parseCsv(printer.productFilter);
  const categoryIds = parseCsv(printer.categoryFilter);

  // Product filter has priority
  if (productIds.length) {
    const itemProductId =
      item.productId ?? item.productID ?? item.product_id ?? null;
    if (!itemProductId) return false;
    return productIds.includes(String(itemProductId));
  }

  // Category filter as fallback
  if (categoryIds.length) {
    const itemCategoryId =
      item.categoryId ?? item.categoryID ?? item.category_id ?? null;
    if (!itemCategoryId) return false;
    return categoryIds.includes(String(itemCategoryId));
  }

  // No filters configured => match everything
  return true;
}

// ---------- Transport (stub for now) -----------------

async function sendToPrinter(printer: StoredDevice, rawText: string) {
  // 🔌 REAL PRINTING GOES HERE
  // For now we just log so you can see the ticket content.
  console.log("🖨️ Sending to printer:", {
    name: printer.name,
    ip: printer.ip,
    model: printer.model,
    type: printer.typeLabel,
  });
  console.log("----- PRINT START -----");
  console.log(rawText);
  console.log("----- PRINT END -------");

  // Later: replace with ESC/POS or SDK call, e.g.
  // await EscPosPrinter.printText(printer.ip, rawText);
}

// ---------- ✅ Till Report Template -----------------

function money(n: any) {
  const v = Number(n || 0);
  return v.toFixed(2);
}

function buildTillCloseReportText(report: TillCloseReport) {
  const lines: string[] = [];

  lines.push("DWF POS");
  lines.push("TILL CLOSE REPORT");
  lines.push("--------------------------------");

  if (report.branchName) lines.push(`Branch: ${report.branchName}`);
  if (report.userName) lines.push(`Cashier: ${report.userName}`);
  if (report.openedAt) lines.push(`Opened: ${report.openedAt}`);
  if (report.closedAt) lines.push(`Closed: ${report.closedAt}`);

  lines.push("--------------------------------");

  const t = report.totals || {};
  if (t.ordersCount != null) lines.push(`Orders: ${t.ordersCount}`);
  if (t.netSales != null) lines.push(`Net Sales: ${money(t.netSales)}`);
  if (t.taxTotal != null) lines.push(`Tax: ${money(t.taxTotal)}`);
  if (t.discountTotal != null) lines.push(`Discounts: ${money(t.discountTotal)}`);

  lines.push("--------------------------------");
  lines.push("Payments:");

  const pays = Array.isArray(report.payments) ? report.payments : [];
  if (!pays.length) {
    lines.push("  (none)");
  } else {
    for (const p of pays) {
      lines.push(`  ${p.methodName}: ${money(p.total)}`);
    }
  }

  lines.push("--------------------------------");

  if (report.openingCash != null)
    lines.push(`Opening Cash: ${money(report.openingCash)}`);

  const cash = report.cash || {};
  if (cash.cashSales != null) lines.push(`Cash Sales: ${money(cash.cashSales)}`);
  if (cash.expectedCash != null)
    lines.push(`Expected Cash: ${money(cash.expectedCash)}`);

  if (report.closingCash != null)
    lines.push(`Counted Cash: ${money(report.closingCash)}`);

  if (cash.variance != null) lines.push(`Variance: ${money(cash.variance)}`);

  lines.push("\n\n");
  return lines.join("\n");
}

/**
 * ✅ NEW: Print till close report on Cashier printer (same routing as receipt)
 */
export async function printTillCloseReport(report: TillCloseReport) {
  try {
    const printers = await loadPrinters();
    // Till report always goes to Cashier printer, orderType not relevant
    const printer = chooseReceiptPrinter(printers, null);

    if (!printer) {
      console.log("⚠️ No cashier printers configured in pos_devices");
      return;
    }

    const text = buildTillCloseReportText(report);
    await sendToPrinter(printer, text);
  } catch (e) {
    console.log("printTillCloseReport error", e);
  }
}

// ---------- Public APIs --------------------------------

/**
 * Cashier receipt (customer copy) – ONE printer.
 */
export async function printReceiptForOrder(args: ReceiptPrintArgs) {
  try {
    const printers = await loadPrinters();
    const printer = chooseReceiptPrinter(printers, args.orderType);

    if (!printer) {
      console.log("⚠️ No cashier printers configured in pos_devices");
      return;
    }

    const text = buildReceiptText(args);
    await sendToPrinter(printer, text);
  } catch (e) {
    console.log("printReceiptForOrder error", e);
  }
}

/**
 * Kitchen ticket – ALL kitchen printers that match order type + filters.
 */
export async function printKitchenTicket(args: KitchenPrintArgs) {
  try {
    const printers = await loadPrinters();
    const kitchenPrinters = chooseKitchenPrinters(printers, args.orderType);

    if (!kitchenPrinters.length) {
      console.log("⚠️ No kitchen printers configured in pos_devices");
      return;
    }

    const fullCart: any[] = Array.isArray(args.cart) ? args.cart : [];

    for (const p of kitchenPrinters) {
      const filteredCart = fullCart.filter((item) =>
        itemMatchesPrinterFilters(item, p)
      );

      const hasFilters =
        parseCsv(p.productFilter).length || parseCsv(p.categoryFilter).length;

      // If printer has filters but nothing matches, skip it
      if (hasFilters && filteredCart.length === 0) {
        continue;
      }

      const text = buildKitchenTicketText({
        ...args,
        cart: hasFilters ? filteredCart : fullCart,
      });

      await sendToPrinter(p, text);
    }
  } catch (e) {
    console.log("printKitchenTicket error", e);
  }
}
