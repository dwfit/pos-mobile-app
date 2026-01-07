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
};

export type ReceiptPrintArgs = BuildReceiptArgs;
export type KitchenPrintArgs = BuildKitchenArgs;

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
      (d) =>
        d.typeLabel === "Cashier" &&
        matchesOrderType(d, orderType)
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
    const isKitchenType =
      d.typeLabel === "Kitchen" || d.typeLabel === "Kitchen Sticky Printer";
    if (!isKitchenType) return false;
    return matchesOrderType(d, orderType);
  });
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
 * Kitchen ticket – ALL kitchen printers that match order type.
 */
export async function printKitchenTicket(args: KitchenPrintArgs) {
  try {
    const printers = await loadPrinters();
    const kitchenPrinters = chooseKitchenPrinters(printers, args.orderType);

    if (!kitchenPrinters.length) {
      console.log("⚠️ No kitchen printers configured in pos_devices");
      return;
    }

    const text = buildKitchenTicketText(args);

    for (const p of kitchenPrinters) {
      await sendToPrinter(p, text);
    }
  } catch (e) {
    console.log("printKitchenTicket error", e);
  }
}
