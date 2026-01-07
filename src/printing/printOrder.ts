// src/printing/printOrder.ts
import { buildCashierReceipt, ReceiptOrder } from "./receiptTemplates";
import { sendToPrinter } from "./printerTransport";

export type ConfigDevicePrinter = {
  id: string;
  code: string;
  name: string;
  type: string;   // "PRINTER" or similar
  status?: string;
  ipAddress?: string | null;
  printer?: {
    model?: string | null;
    category?: string | null;           // "Cashier", "Kitchen"
    enabledOrderTypes?: string[] | any; // ["DINE_IN","PICK_UP"]
  } | null;
};

/**
 * Given all devices + an order, return devices that should receive this ticket.
 */
export function getPrintersForOrderType(
  devices: ConfigDevicePrinter[],
  orderType: string
): ConfigDevicePrinter[] {
  return devices.filter((d) => {
    if (!d.printer) return false;
    if (!d.ipAddress) return false;

    const enabled = Array.isArray(d.printer.enabledOrderTypes)
      ? d.printer.enabledOrderTypes
      : [];

    if (!enabled.length) return false;
    return enabled.includes(orderType);
  });
}

/**
 * Main function: print order to all relevant printers.
 */
export async function printOrderToPrinters(opts: {
  order: ReceiptOrder;
  devices: ConfigDevicePrinter[];
}) {
  const { order, devices } = opts;

  const targetPrinters = getPrintersForOrderType(devices, order.orderType);

  if (!targetPrinters.length) {
    console.log(
      "🖨 No printers configured for order type:",
      order.orderType
    );
    return;
  }

  for (const printer of targetPrinters) {
    if (!printer.ipAddress) continue;

    // TODO: choose template based on category
    // For now, only cashier style
    const bytes = buildCashierReceipt(order);

    try {
      await sendToPrinter(
        { ip: printer.ipAddress, port: 9100 },
        bytes
      );
      console.log(
        `✅ Printed order ${order.orderNo} to printer ${printer.name} (${printer.ipAddress})`
      );
    } catch (err) {
      console.log(
        `❌ Failed to print to ${printer.name} (${printer.ipAddress}):`,
        err
      );
    }
  }
}
