// src/printing/receiptTemplate.ts

const LINE_WIDTH = 32; // typical 58mm thermal

function padRight(str: string, width: number) {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number) {
  if (str.length >= width) return str.slice(0, width);
  return " ".repeat(width - str.length) + str;
}

function center(str: string, width: number) {
  if (!str) return "";
  if (str.length >= width) return str.slice(0, width);
  const total = width - str.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return " ".repeat(left) + str + " ".repeat(right);
}

function formatAmount(v: number | string | null | undefined) {
  const n = Number(v || 0);
  return n.toFixed(2);
}

type ReceiptCartItem = {
  productName?: string;
  name?: string;
  qty?: number;
  price?: number;
  unitPrice?: number;
  sizeName?: string | null;
  modifiers?: { name?: string; price?: number }[];
};

export type BuildReceiptArgs = {
  brandName?: string | null;
  branchName?: string | null;
  userName?: string | null;
  orderNo?: string | null;
  orderType?: string | null;
  businessDate?: Date | string | null;

  cart: ReceiptCartItem[];

  subtotal: number;
  vatAmount: number;
  total: number;
  discountAmount?: number;
  payments?: { methodName?: string; amount: number }[];
};

/**
 * Cashier receipt (with totals, payments, etc.)
 */
export function buildReceiptText({
  brandName,
  branchName,
  userName,
  orderNo,
  orderType,
  businessDate,
  cart,
  subtotal,
  vatAmount,
  total,
  discountAmount = 0,
  payments = [],
}: BuildReceiptArgs): string {
  const lines: string[] = [];

  // HEADER
  if (brandName) lines.push(center(String(brandName).toUpperCase(), LINE_WIDTH));
  if (branchName) lines.push(center(String(branchName), LINE_WIDTH));
  lines.push(center("Simplified Tax Invoice", LINE_WIDTH));
  lines.push("-".repeat(LINE_WIDTH));

  // META
  if (orderNo) lines.push(`Order: ${orderNo}`);
  if (orderType) lines.push(`Type : ${orderType}`);
  if (userName) lines.push(`Cashier: ${userName}`);
  if (businessDate) {
    const d = typeof businessDate === "string" ? new Date(businessDate) : businessDate;
    const dateStr = isNaN(d.getTime()) ? String(businessDate) : d.toLocaleString();
    lines.push(`Date : ${dateStr}`);
  }
  lines.push("-".repeat(LINE_WIDTH));

  // ITEMS
  lines.push("Items:");
  cart.forEach((item) => {
    const name =
      item.productName ||
      item.name ||
      "Item";

    const qty = Number(item.qty || 0);
    const unit =
      Number(
        item.price ??
          item.unitPrice ??
          0
      );
    const lineTotal = qty * unit;

    // First line: product name (+ size)
    const sizeSuffix = item.sizeName ? ` (${item.sizeName})` : "";
    const fullName = `${name}${sizeSuffix}`;
    lines.push(padRight(fullName, LINE_WIDTH));

    // Second line: "qty x price   total"
    const leftPart = `${qty} x ${formatAmount(unit)}`;
    const rightPart = formatAmount(lineTotal);
    const leftWidth = LINE_WIDTH - rightPart.length - 1;
    lines.push(padRight(leftPart, leftWidth) + " " + rightPart);

    // Modifiers (if any)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((m) => {
        const mName = m.name || "Modifier";
        const mPrice = Number(m.price || 0);
        const text = `  + ${mName}`;
        const right = formatAmount(mPrice);
        const leftW = LINE_WIDTH - right.length - 1;
        lines.push(padRight(text, leftW) + " " + right);
      });
    }

    lines.push(""); // blank line between items
  });

  lines.push("-".repeat(LINE_WIDTH));

  // TOTALS
  lines.push(
    padRight("Subtotal", LINE_WIDTH - formatAmount(subtotal).length - 1) +
      " " +
      formatAmount(subtotal)
  );

  if (discountAmount > 0.001) {
    lines.push(
      padRight("Discount", LINE_WIDTH - formatAmount(-discountAmount).length - 2) +
        " -" +
        formatAmount(discountAmount)
    );
  }

  lines.push(
    padRight("VAT", LINE_WIDTH - formatAmount(vatAmount).length - 1) +
      " " +
      formatAmount(vatAmount)
  );

  lines.push("-".repeat(LINE_WIDTH));

  lines.push(
    padRight("TOTAL", LINE_WIDTH - formatAmount(total).length - 1) +
      " " +
      formatAmount(total)
  );

  // PAYMENTS
  if (payments && payments.length > 0) {
    lines.push("");
    lines.push("Payments:");
    payments.forEach((p) => {
      const label = p.methodName || "Method";
      const amt = formatAmount(p.amount);
      const leftW = LINE_WIDTH - amt.length - 1;
      lines.push(padRight(label, leftW) + " " + amt);
    });
  }

  lines.push("");
  lines.push(center("Thank you for your visit", LINE_WIDTH));
  lines.push("");

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* KITCHEN TICKET TEMPLATE                                            */
/* ------------------------------------------------------------------ */

export type BuildKitchenArgs = {
  brandName?: string | null;
  branchName?: string | null;
  userName?: string | null;   // 👈 NEW
  orderNo?: string | null;
  orderType?: string | null;
  businessDate?: Date | string | null;
  tableName?: string | null; 
  notes?: string | null;

  cart: ReceiptCartItem[];
};

/**
 * Kitchen ticket: focus on items, qty, modifiers, no amounts.
 */
export function buildKitchenTicketText({
  brandName,
  branchName,
  userName, 
  orderNo,
  orderType,
  businessDate,
  tableName,
  notes,
  cart,
}: BuildKitchenArgs): string {
  const lines: string[] = [];

  // HEADER (simple but bold for kitchen)
  if (brandName) lines.push(center(String(brandName).toUpperCase(), LINE_WIDTH));
  if (branchName) lines.push(center(String(branchName), LINE_WIDTH));
  lines.push(center("KITCHEN ORDER", LINE_WIDTH));
  lines.push("-".repeat(LINE_WIDTH));

  // META
  if (orderNo) lines.push(`Order: ${orderNo}`);
  if (orderType) lines.push(`Type : ${orderType}`);
  if (userName) lines.push(`User : ${userName}`);

  if (businessDate) {
    const d =
      typeof businessDate === "string"
        ? new Date(businessDate)
        : businessDate;

    if (!isNaN(d.getTime())) {
      const dateStr = d.toLocaleDateString();
      const timeStr = d.toLocaleTimeString();
      lines.push(`Date : ${dateStr}`);             
      lines.push(`Time : ${timeStr}`);            
    } else {
      // if parsing fails, just show whatever was passed
      lines.push(`Date : ${String(businessDate)}`);
    }
  }

  lines.push("-".repeat(LINE_WIDTH));

  // ITEMS (big focus on qty + name)
  cart.forEach((item) => {
    const name =
      item.productName ||
      item.name ||
      "Item";

    const qty = Number(item.qty || 0) || 1;
    const sizeSuffix = item.sizeName ? ` (${item.sizeName})` : "";
    const fullName = `${name}${sizeSuffix}`;

    // First line: "QTY x NAME" (QTY large left)
    const qtyStr = `${qty}x`.padEnd(4, " "); // e.g. "2x  "
    const line = qtyStr + fullName;
    lines.push(padRight(line, LINE_WIDTH));

    // Modifiers (if any)
    if (item.modifiers && item.modifiers.length > 0) {
      item.modifiers.forEach((m) => {
        const mName = m.name || "Modifier";
        const text = `  + ${mName}`;
        lines.push(padRight(text, LINE_WIDTH));
      });
    }

    lines.push(""); // blank line between items
  });

  if (notes && notes.trim().length > 0) {
    lines.push("-".repeat(LINE_WIDTH));
    lines.push("NOTES:");
    lines.push(notes.trim());
  }

  lines.push("");
  return lines.join("\n");
}
