// src/screens/CategoryScreen.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  TextInput,
  Image,
  Alert,
  Modal,
} from "react-native";
import { get, post } from "../lib/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialIcons } from "@expo/vector-icons";
//sound for new orders
import { Audio } from "expo-av";
//WebSocket client
import { io, Socket } from "socket.io-client";
//SQLite helpers
import { getLocalCategories } from "../database/menu";
import {
  saveOrdersToSQLite as saveOrdersLocal,
  LocalOrder,
} from "../database/ordersLocal";
import { syncMenu } from "../sync/menuSync";
//Tier Pricing
import { getTierPricingForIds } from "../services/tierPricing";
import { loadPriceTiersWithSync } from "../sync/priceTierSync";
import { usePriceTierStore, type PriceTier } from "../store/priceTierStore";
import { useOrderTypeStore } from "../store/orderTypeStore";
//Tier TIll Close
import { closeLocalTill, getLocalTillSession, } from "../database/clockLocal";
import { generateTillCloseReport } from "../reports/tillCloseReport";
import {
  printTillCloseReport,
  type TillCloseReport,
  printKitchenTicket,
  printReceiptForOrder,
} from "../printing/printerService";
import { useAuthStore } from "../store/authStore";
import ModernDialog from "../components/ModernDialog";



type Category = {
  id: string;
  name: string;
  imageUrl?: string;
  isActive?: boolean;
};

type CartModifier = {
  groupId: string;
  groupName: string;
  itemId: string; // maps to modifierItemId in backend
  itemName: string;
  price: number; // per item
  originalPrice?: number; // ✅ for tier restore
};

type CartItem = {
  productId: string;
  productName: string;
  sizeId: string | null;
  sizeName: string | null;
  price: number; // base product/size price (per item, incl. VAT)
  originalPrice?: number; // ✅ for tier restore
  qty: number;
  modifiers?: CartModifier[];
};

type PaymentMethod = {
  id: string;
  code: string | null;
  name: string;
};

type PaymentEntry = {
  methodId: string;
  methodName: string;
  amount: number;
};

type CustomerSummary = {
  id: string;
  name: string;
  phone?: string | null;
};

type AppliedDiscount = {
  kind: "AMOUNT" | "PERCENT";
  value: number;
  source?: "OPEN" | "PREDEFINED" | null;
  id?: string | null;
  name?: string | null;
  label?: string | null;
};

type DiscountConfig = {
  id: string;
  name: string;
  mode: 'AMOUNT' | 'PERCENT';
  value: number;
  scope?: 'ORDER' | 'ITEM';
  branchIds?: string[];
  categoryIds?: string[];
  productIds?: string[];
  productSizeIds?: string[];
  orderTypes?: string[];
  applyAllBranches?: boolean;
};

const PURPLE = "#6d28d9";
const BLACK = "#000000";
const DISCOUNT_STORAGE_KEY = "pos_applied_discount";

// ============= WebSocket helpers =============
const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "http://192.168.100.245:4000";

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });

    socket.on("connect", () => {
      console.log("🔌 CategoryScreen WS connected:", socket?.id);
    });
    socket.on("disconnect", (reason) => {
      console.log("⚠️ CategoryScreen WS disconnected:", reason);
    });
    socket.on("connect_error", (err) => {
      console.log("❌ CategoryScreen WS connect_error:", err?.message);
    });
  }
  return socket;
}

type OrdersChangedPayload = {
  orderId?: string;
  branchId?: string;
  channel?: string;
  status?: string;
  action?: "created" | "updated";
};

function subscribeOrdersChanged(
  handler: (payload: OrdersChangedPayload) => void
) {
  const s = getSocket();
  const listener = (payload: any) => {
    console.log("🛰 CategoryScreen WS orders:changed", payload);
    handler(payload || {});
  };
  s.on("orders:changed", listener);

  return () => {
    s.off("orders:changed", listener);
  };
}



/* =========================Brand ID helper========================= */

async function getEffectiveBrandId(): Promise<string | null> {
  try {
    const info = await getDeviceInfo();
    if (info.brandId) return String(info.brandId);
  } catch { }

  try {
    const cfg = await get("/pos/config");
    const bid = (cfg as any)?.brandId;
    if (bid) return String(bid);
  } catch (e) {
    console.log("getEffectiveBrandId: /pos/config failed", e);
  }

  return null;
}

/* =========================DeviceInfo helper========================= */
async function getDeviceInfo(): Promise<{
  branchId: string | null;
  brandId: string | null;
  deviceId: string | null;
}> {
  try {
    const raw = await AsyncStorage.getItem("deviceInfo");
    if (!raw) return { branchId: null, brandId: null, deviceId: null };
    const dev = JSON.parse(raw);

    const branchId = dev.branchId ?? null;
    const brandId = dev.brandId ?? dev.brand?.id ?? null;
    const deviceId = dev.id ?? dev.deviceId ?? null;

    return { branchId, brandId, deviceId };
  } catch (e) {
    console.log("getDeviceInfo parse error (CategoryScreen)", e);
    return { branchId: null, brandId: null, deviceId: null };
  }
}

async function registerPosDeviceOnSocket() {
  try {
    const { branchId, deviceId } = await getDeviceInfo();

    if (!branchId || !deviceId) {
      console.log("WS register (CategoryScreen): missing branchId/deviceId", {
        branchId,
        deviceId,
      });
      return;
    }

    const s = getSocket();
    s.emit("pos:register", { deviceId, branchId });
    console.log("📡 CategoryScreen pos:register sent", { deviceId, branchId });
  } catch (e) {
    console.log("registerPosDeviceOnSocket (CategoryScreen) error", e);
  }
}

// ============= shared helpers =============
function normalizeImageUrl(url?: string | null) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;

  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return `http:${u}`;

  const base = API_BASE.replace(/\/+$/, "");
  const path = u.startsWith("/") ? u : `/${u}`;
  return `${base}${path}`;
}

async function playAlertSound() {
  try {
    const { sound } = await Audio.Sound.createAsync(
      require("../assets/new-order.mp3")
    );
    await sound.playAsync();
  } catch (err) {
    console.log("SOUND ERROR (CategoryScreen)", err);
  }
}

function normalizePrice(raw: any): number {
  if (typeof raw === "number") return raw;
  if (raw == null) return 0;
  const n = parseFloat(String(raw));
  return Number.isNaN(n) ? 0 : n;
}

const PRICE_TIERS_CACHE_KEY = "pos_price_tiers_v1";

async function loadCachedPriceTiers(): Promise<PriceTier[]> {
  try {
    const raw = await AsyncStorage.getItem(PRICE_TIERS_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((t: any) => ({
      id: String(t.id),
      name: String(t.name),
      code: t.code ?? null,
      type: t.type ?? null,
      isActive: t.isActive !== false,
    })) as PriceTier[];
  } catch (e) {
    console.log("LOAD PRICE TIERS CACHE ERR", e);
    return [];
  }
}

async function saveCachedPriceTiers(list: PriceTier[]): Promise<void> {
  try {
    const payload = list.map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code ?? null,
      type: t.type ?? null,
      isActive: t.isActive !== false,
    }));
    await AsyncStorage.setItem(PRICE_TIERS_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.log("SAVE PRICE TIERS CACHE ERR", e);
  }
}

async function refreshPriceTiersFromServer(): Promise<PriceTier[]> {
  try {
    const { branchId, brandId } = await getDeviceInfo();

    const params = new URLSearchParams();
    if (branchId) params.append("branchId", branchId);
    if (brandId) params.append("brandId", brandId);

    const resp = await get(`/pricing/tiers?${params.toString()}`);
    const arr = Array.isArray(resp) ? resp : [];

    console.log("📦 PRICE TIERS API (CategoryScreen):", arr);

    const list: PriceTier[] = arr.map((t: any) => ({
      id: String(t.id),
      name: String(t.name),
      code: t.code ?? null,
      type: t.type ?? null,
      isActive: t.isActive !== false,
    }));

    const activeList = list.filter((t) => t.isActive !== false);
    await saveCachedPriceTiers(activeList);
    return activeList;
  } catch (e) {
    console.log("REFRESH PRICE TIERS ERR", e);
    throw e;
  }
}

function calcLineModifierTotal(mods?: CartModifier[]): number {
  if (!mods || !Array.isArray(mods)) return 0;
  return mods.reduce((sum, m) => sum + normalizePrice(m.price), 0);
}

function calcLineTotal(line: CartItem): number {
  const base = normalizePrice(line.price);
  const mods = calcLineModifierTotal(line.modifiers);
  return (base + mods) * line.qty;
}

function toMoney(value: any): string {
  const n =
    typeof value === "number"
      ? value
      : parseFloat(value != null ? String(value) : "0");
  if (Number.isNaN(n)) return "0.00";
  return n.toFixed(2);
}

// helper to map SQLite rows to Category[]
function mapLocalCategories(rows: any[]): Category[] {
  return (rows || [])
    .filter((c: any) => c.isActive !== 0)
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive === 1,
      imageUrl: c.imageUrl || undefined,
    }));
}

// helper to map API order -> LocalOrder (for SQLite)
function toLocalOrder(o: any): LocalOrder {
  let businessDate: string | null = null;
  if (o.businessDate) businessDate = o.businessDate;
  else if (o.createdAt) {
    const d = new Date(o.createdAt);
    if (!isNaN(d.getTime())) businessDate = d.toISOString().slice(0, 10);
  }

  return {
    id: o.id,
    orderNo: o.orderNo ?? "",
    branchId: o.branchId ?? "",
    businessDate: businessDate ?? "",
    status: o.status ?? "",
    channel: o.channel ?? null,
    netTotal: Number(o.netTotal ?? 0),
  };
}

function normalizeOrderTypeLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const raw = String(label).trim().toLowerCase().replace(/\s+/g, " ");
  if (raw.includes("dine")) return "DINE_IN";
  if (raw.includes("pick") || raw.includes("take")) return "TAKE_AWAY";
  if (raw.includes("drive")) return "DRIVE_THRU";
  if (raw.includes("deliver")) return "DELIVERY";
  const fallback = String(label).trim().toUpperCase().replace(/\s+/g, "_");
  if (fallback === "PICK_UP") return "TAKE_AWAY";
  return fallback;
}

/* =========================
   ✅ Tier pricing helpers
   ========================= */

function collectTierIdsFromCart(items: CartItem[]) {
  const productSizeIds: string[] = [];
  const modifierItemIds: string[] = [];

  for (const it of items) {
    if (it.sizeId) productSizeIds.push(it.sizeId);
    for (const m of it.modifiers || []) modifierItemIds.push(m.itemId);
  }

  return {
    productSizeIds: Array.from(new Set(productSizeIds)),
    modifierItemIds: Array.from(new Set(modifierItemIds)),
  };
}

function applyTierToCartLocal(
  items: CartItem[],
  sizesMap: Record<string, number>,
  modifierItemsMap: Record<string, number>
): CartItem[] {
  return items.map((it) => {
    const next: CartItem = { ...it };

    // Size price override
    if (it.sizeId && sizesMap[it.sizeId] != null) {
      if (next.originalPrice == null) next.originalPrice = it.price;
      next.price = sizesMap[it.sizeId];
    }

    // Modifier overrides
    if (next.modifiers?.length) {
      next.modifiers = next.modifiers.map((m) => {
        const nm: CartModifier = { ...m };
        const mp = modifierItemsMap[m.itemId];
        if (mp != null) {
          if (nm.originalPrice == null) nm.originalPrice = m.price;
          nm.price = mp;
        }
        return nm;
      });
    }

    return next;
  });
}

function clearTierFromCartLocal(items: CartItem[]): CartItem[] {
  return items.map((it) => {
    const next: CartItem = { ...it };
    if (next.originalPrice != null) {
      next.price = next.originalPrice;
      delete next.originalPrice;
    }
    if (next.modifiers?.length) {
      next.modifiers = next.modifiers.map((m) => {
        const nm: CartModifier = { ...m };
        if (nm.originalPrice != null) {
          nm.price = nm.originalPrice;
          delete nm.originalPrice;
        }
        return nm;
      });
    }
    return next;
  });
}

export default function CategoryScreen({
  navigation,
  route,
  cart,
  setCart,
  online,
  tillOpen,
  setTillOpen,
  activeOrderId,
  setActiveOrderId,
}: any) {



  const { branchName, userName } = route?.params || {};
  const [categories, setCategories] = useState<Category[]>([]);
  const [filtered, setFiltered] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string | null>(null);

  const [dlg, setDlg] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    tone?: "success" | "error" | "info";
    primaryText?: string;
    secondaryText?: string;
    onPrimary?: (() => void) | null;
    onSecondary?: (() => void) | null;
  }>({
    visible: false,
    title: "",
    message: "",
    tone: "info",
    primaryText: "OK",
    secondaryText: undefined,
    onPrimary: null,
    onSecondary: null,
  });

  function showDialog(opts: Partial<typeof dlg>) {
    setDlg((p) => ({
      ...p,
      visible: true,
      title: opts.title ?? p.title,
      message: opts.message ?? p.message,
      tone: opts.tone ?? "info",
      primaryText: opts.primaryText ?? "OK",
      secondaryText: opts.secondaryText,
      onPrimary: opts.onPrimary ?? null,
      onSecondary: opts.onSecondary ?? null,
    }));
  }

  function hideDialog() {
    setDlg((p) => ({ ...p, visible: false }));
  }

  // 🔁 Load brand name for printing headers
  useEffect(() => {
    (async () => {
      try {
        const rawBrand = await AsyncStorage.getItem("pos_brand");
        if (rawBrand) {
          const b = JSON.parse(rawBrand);
          setBrandName(b?.name ?? null);
          return;
        }

        const rawDev = await AsyncStorage.getItem("deviceInfo");
        if (rawDev) {
          const d = JSON.parse(rawDev);
          setBrandName(d?.brandName ?? d?.brand?.name ?? null);
        }
      } catch (e) {
        console.log("brand load error (CategoryScreen)", e);
      }
    })();
  }, []);

  const [vatRate, setVatRate] = useState<number>(15);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const orderType = useOrderTypeStore((s) => s.orderType);
  const setOrderType = useOrderTypeStore((s) => s.setOrderType);
  const [voidLoading, setVoidLoading] = useState(false);
  const [ordersBadge, setOrdersBadge] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [discountValue, setDiscountValue] = useState<string>("0");
  const [appliedDiscount, setAppliedDiscount] = useState<AppliedDiscount | null>(null);
  const [showCustomAmount, setShowCustomAmount] = useState(false);
  const [customAmountInput, setCustomAmountInput] = useState("");
  const [customerModalVisible, setCustomerModalVisible] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerList, setCustomerList] = useState<CustomerSummary[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSummary | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [orderTypeModalVisible, setOrderTypeModalVisible] = useState(false);
  const readOnlyCart = false;
  const [discountModeModalVisible, setDiscountModeModalVisible] = useState(false);
  const [discountInputModalVisible, setDiscountInputModalVisible] = useState(false);
  const [discountPresetModalVisible, setDiscountPresetModalVisible] = useState(false);
  const [discountInputMode, setDiscountInputMode] = useState<"AMOUNT" | "PERCENT" | null>(null);
  const [discountInputValue, setDiscountInputValue] = useState("");
  const [discountConfigs, setDiscountConfigs] = useState<DiscountConfig[]>([]);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const refreshAuth = useAuthStore((s) => s.refresh);

  // 🔐 Permission helpers (must use component state)



  const canUseAnyDiscount = canUseOpenDiscount || canUsePredefinedDiscount;
  //for Home sub-menu
  const [homeMenuVisible, setHomeMenuVisible] = useState(false);
  // ===== close-till flow =====
  const [confirmCloseVisible, setConfirmCloseVisible] = useState(false);
  const [closeAmountVisible, setCloseAmountVisible] = useState(false);
  const [printPromptVisible, setPrintPromptVisible] = useState(false);
  const [tillCloseAmount, setTillCloseAmount] = useState("");
  const [lastReport, setLastReport] = useState<TillCloseReport | null>(null);
  //  permission flag for access in POS
  const canUseOpenDiscount =
    hasPermission("pos.discounts.open.apply") ||
    hasPermission("pos.discount.open.apply") ||
    hasPermission("APPLY_OPEN_DISCOUNTS");
  const canUsePredefinedDiscount =
    hasPermission("pos.discounts.predefined.apply") ||
    hasPermission("pos.discount.predefined.apply") ||
    hasPermission("APPLY_PREDEFINED_DISCOUNTS");

  const canKitchenReprint = hasPermission("pos.kitchen.reprint");
  const canAccessDevices =
    hasPermission("pos.devices.manage") ||
    hasPermission("ACCESS_DEVICES_MANAGEMENT");
  const canAccessDrawer =
    hasPermission("pos.drawer.operations") ||
    hasPermission("DRAWER_OPERATIONS");
  const canAccessReports =
    hasPermission("pos.reports.view") ||
    hasPermission("pos.reports.access") ||
    hasPermission("ACCESS_REPORTS");

  const MENU_ITEMS = [
    {
      label: tillOpen ? "Till Close" : "Open Till",
      icon: tillOpen ? "lock-open" : "lock",
      onPress: () => {
        setHomeMenuVisible(false);
        navigation.navigate("ClockIn", { branchName, userName });
      },
    },
    { label: "Drawer Operations", icon: "inbox" },
    { label: "House Account Payment", icon: "account-balance-wallet" },
    { label: "E-Invoice (ZATCA)", icon: "receipt" },
    { label: "Reports", icon: "bar-chart" },

    // 🔐 DEVICES (permission protected)
    ...(canAccessDevices
      ? [{
        label: "Devices",
        icon: "devices",
        onPress: () => {
          setHomeMenuVisible(false);

          // 🔐 EXTRA SECURITY GUARD
          if (!canAccessDevices) {
            showDialog({
              tone: "error",
              title: "Access denied",
              message: "You don't have permission to access device management.",
            });
            return;
          }

          navigation.navigate("Devices");
        },
      },]
      : []),

    { label: "Exit", icon: "logout", danger: true },
  ];


  const [syncProgressVisible, setSyncProgressVisible] = useState(false);
  const [syncStep, setSyncStep] = useState(0);
  const [syncStatusText, setSyncStatusText] = useState("Preparing…");

  function setSyncStepUI(step: number, text: string) {
    setSyncStep(step);
    setSyncStatusText(text);
  }


  /* =========================
     ✅ Price Tier UI state
     ========================= */
  const [tierModalVisible, setTierModalVisible] = useState(false);
  const [tiers, setTiers] = useState<PriceTier[]>([]);
  const [tierLoading, setTierLoading] = useState(false);

  const activeTier = usePriceTierStore((s) => s.activeTier);
  const setActiveTier = usePriceTierStore((s) => s.setActiveTier);
  const hydrateTier = usePriceTierStore((s) => s.hydrate);

  const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];

  async function loadAppliedDiscountFromStorage() {
    try {
      const raw = await AsyncStorage.getItem(DISCOUNT_STORAGE_KEY);
      if (!raw) {
        setAppliedDiscount(null);
        setDiscountValue("0");
        return;
      }

      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.kind === "AMOUNT" || parsed.kind === "PERCENT") &&
        typeof parsed.value === "number"
      ) {
        setAppliedDiscount(parsed as AppliedDiscount);
        setDiscountValue(String(parsed.value));
      } else {
        setAppliedDiscount(null);
        setDiscountValue("0");
      }
    } catch (e) {
      console.log("LOAD DISCOUNT ERR (CategoryScreen)", e);
      setAppliedDiscount(null);
      setDiscountValue("0");
    }
  }

  useEffect(() => {
    hydrateTier().catch(() => { });
  }, [hydrateTier]);

  useEffect(() => {
    async function apply() {
      const items: CartItem[] = Array.isArray(cart) ? cart : [];
      if (!items.length) return;

      // No active tier → restore originals
      if (!activeTier) {
        const restored = clearTierFromCartLocal(items);
        const changed =
          restored.length !== items.length ||
          restored.some((n, i) => n.price !== items[i].price);
        if (changed) setCart(restored);
        return;
      }

      const { productSizeIds, modifierItemIds } =
        collectTierIdsFromCart(items);

      if (
        productSizeIds.length === 0 &&
        modifierItemIds.length === 0
      ) {
        return;
      }

      const pricing = await getTierPricingForIds({
        tierId: activeTier.id,
        productSizeIds,
        modifierItemIds,
      });

      const next = applyTierToCartLocal(
        items,
        pricing.sizePriceMap,
        pricing.modifierPriceMap
      );

      const changed =
        next.length !== items.length ||
        next.some((n, i) => n.price !== items[i].price);

      if (changed) {
        setCart(next);
      }
    }

    apply();
  }, [activeTier, cart]);


  useEffect(() => {
    loadAppliedDiscountFromStorage();
  }, []);

  useEffect(() => {
    const unsubscribe =
      navigation?.addListener?.("focus", () => {
        loadAppliedDiscountFromStorage();
      }) || undefined;

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [navigation]);


  /* ------------------------ sync orders cache ------------------------ */
  async function syncOrdersCache() {
    try {
      let currentBranchId = branchId;

      if (!currentBranchId) {
        const info = await getDeviceInfo();
        if (info.branchId) {
          currentBranchId = info.branchId;
          setBranchId(info.branchId);
        }
        if (info.brandId) setBrandId(info.brandId);
        if (info.deviceId) setDeviceId(info.deviceId);
      }

      if (!online) {
        console.log("syncOrdersCache: offline, skipping API fetch");
        return;
      }

      let qs = "?take=200";
      if (currentBranchId) qs += `&branchId=${currentBranchId}`;
      const data = await get("/orders" + qs);
      const arr = Array.isArray(data) ? data : [];

      console.log(
        "🌐 CategoryScreen syncOrdersCache: fetched orders:",
        arr.length
      );
      const locals: LocalOrder[] = arr.map(toLocalOrder);
      await saveOrdersLocal(locals);
    } catch (e) {
      console.log("syncOrdersCache error (CategoryScreen)", e);
    }
  }

  /* ------------------------ Discount ------------------------ */
  // Load POS user permissions (for discount permissions)
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem("pos_user");
        if (!raw) {
          setUserPermissions([]);
          return;
        }
        const u = JSON.parse(raw);
        const perms: string[] = Array.isArray(u?.permissions) ? u.permissions : [];
        setUserPermissions(perms);

        console.log("✅ Loaded permissions:", perms.length); // debug
      } catch (e) {
        console.log("pos_user permissions load error (CategoryScreen)", e);
        setUserPermissions([]);
      }
    })();
  }, []);


  useEffect(() => {
    (async () => {
      try {
        if (appliedDiscount) {
          await AsyncStorage.setItem(
            DISCOUNT_STORAGE_KEY,
            JSON.stringify(appliedDiscount)
          );
        } else {
          await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
        }
      } catch (e) {
        console.log("SAVE DISCOUNT ERR (CategoryScreen)", e);
      }
    })();
  }, [appliedDiscount]);


  /* ------------------------ LOAD CATEGORIES (SQLite-first + background sync) ------------------------ */
  useEffect(() => {
    let mounted = true;

    async function loadCategories() {
      setLoading(true);
      setError(null);

      try {
        try {
          const info = await getDeviceInfo();
          if (info.branchId && !branchId) setBranchId(info.branchId);
          if (info.brandId && !brandId) setBrandId(info.brandId);
          if (info.deviceId && !deviceId) setDeviceId(info.deviceId);
        } catch (e) {
          console.log("READ deviceInfo ERR (CategoryScreen)", e);
        }

        try {
          const local = await getLocalCategories();
          if (!mounted) return;
          const mapped = mapLocalCategories(local);
          setCategories(mapped);
          setFiltered(mapped);
          console.log("📥 Categories from SQLite:", mapped.length);
        } catch (e) {
          console.log("CATEGORIES (SQLite) ERR", e);
          if (mounted) setError("Failed to load categories");
        } finally {
          if (mounted) setLoading(false);
        }

        if (!online) {
          console.log("Offline → using only SQLite categories");
          return;
        }

        setSyncing(true);
        try {
          const bid = await getEffectiveBrandId();
          if (!bid) {
            console.log(
              "❌ CategoryScreen: missing brandId, skip syncMenu"
            );
            return;
          }

          await syncMenu({
            brandId: bid,
            forceFull: true,
            includeInactive: true,
          });

          if (!mounted) return;
          const fresh = await getLocalCategories();
          const mappedFresh = mapLocalCategories(fresh);
          setCategories(mappedFresh);
          setFiltered(mappedFresh);
          console.log("🌐 Categories after syncMenu:", mappedFresh.length);
        } catch (e) {
          console.log("syncMenu error (CategoryScreen):", e);
        } finally {
          if (mounted) setSyncing(false);
        }
      } catch (e: any) {
        console.log("CATEGORIES load ERR (CategoryScreen)", e);
        if (mounted) {
          setError("Failed to load categories");
          setLoading(false);
          setSyncing(false);
        }
      }
    }

    loadCategories();
    return () => {
      mounted = false;
    };
  }, [online]);

  /* ------------------------ 30-min AUTO SCHEDULER (sync from server) ------------------------ */
  useEffect(() => {
    if (!online) return;

    const intervalMs = 30 * 60 * 1000;
    console.log("⏰ CategoryScreen auto-sync scheduler started (30 min)");

    const id = setInterval(async () => {
      try {
        console.log("⏰ CategoryScreen auto syncMenu tick");
        const bid = await getEffectiveBrandId();
        if (!bid) return;

        await syncMenu({
          brandId: bid,
          forceFull: true,
          includeInactive: true,
        });

        const fresh = await getLocalCategories();
        const mappedFresh = mapLocalCategories(fresh);
        setCategories(mappedFresh);
        setFiltered(mappedFresh);
        console.log(
          "🌐 Categories auto-scheduler updated from server:",
          mappedFresh.length
        );

        await syncOrdersCache();
      } catch (e) {
        console.log("AUTO syncMenu ERR (CategoryScreen)", e);
      }
    }, intervalMs);

    return () => {
      clearInterval(id);
      console.log("⏹ CategoryScreen auto-sync scheduler cleared");
    };
  }, [online, branchId]);

  /* ------------------------ Discount ------------------------ */
  // Determine which discounts can be used on this order
  function isDiscountEligibleForCart(discount: DiscountConfig, cartItems: CartItem[]): boolean {
    const productIds = discount.productIds || [];
    const categoryIds = discount.categoryIds || [];
    const productSizeIds = discount.productSizeIds || [];
    const allowedOrderTypes = (discount.orderTypes || [])
      .map((v) => normalizeOrderTypeLabel(String(v)))
      .filter((v): v is string => !!v);

    // order type check
    if (allowedOrderTypes.length > 0) {
      const current = normalizeOrderTypeLabel(orderType);
      if (!current || !allowedOrderTypes.includes(current)) return false;
    }

    // branch check
    if (branchId) {
      const branchIds = discount.branchIds || [];
      if (!discount.applyAllBranches && branchIds.length > 0) {
        const match = branchIds.includes(branchId);
        if (!match) return false;
      }
    }

    const hasAssignments =
      productIds.length > 0 ||
      categoryIds.length > 0 ||
      productSizeIds.length > 0;

    // If discount has no assignments, treat as generic ORDER-level discount
    if (!hasAssignments) {
      return cartItems.length > 0;
    }

    // CategoryScreen doesn't know full product catalog, so we only check
    // productId / sizeId directly from cart
    if (!cartItems.length) return false;

    const cartProductIds = new Set(cartItems.map((c) => c.productId));
    const cartSizeIds = new Set(
      cartItems.map((c) => c.sizeId).filter((id): id is string => !!id)
    );

    const productMatch =
      productIds.length > 0 &&
      productIds.some((pid) => cartProductIds.has(pid));

    const sizeMatch =
      productSizeIds.length > 0 &&
      productSizeIds.some((sid) => cartSizeIds.has(sid));

    // NOTE: we cannot safely compute categoryMatch here, since we don't
    // have product.categoryId in CategoryScreen. If you really need it,
    // we can add a small SQLite lookup later.
    return productMatch || sizeMatch || (!productMatch && !sizeMatch && cartItems.length > 0);
  }

  const applicableDiscounts: DiscountConfig[] = React.useMemo(() => {
    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    return discountConfigs.filter((d) => isDiscountEligibleForCart(d, items));
  }, [discountConfigs, cart, orderType, branchId]);

  function openDiscountMenu() {
    if (readOnlyCart) return;

    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    if (!items.length) {
      showDialog({
        tone: "info",
        title: "Empty cart",
        message: "Add items to the order before discount.",
      });
      return;
    }

    if (!canUseAnyDiscount) {
      showDialog({
        tone: "error",
        title: "No permission",
        message: "You are not allowed to apply discounts.",
      });

      return;
    }

    setDiscountModeModalVisible(true);
  }

  function openDiscountInput(mode: "AMOUNT" | "PERCENT") {
    if (readOnlyCart) return;

    if (!canUseOpenDiscount) {
      showDialog({
        tone: "error",
        title: "No permission",
        message: "You are not allowed to apply open/manual discounts.",
      });

      return;
    }

    setDiscountModeModalVisible(false);
    setDiscountInputMode(mode);
    setDiscountInputValue("");
    setDiscountInputModalVisible(true);
  }

  function applyDiscountInput() {
    if (readOnlyCart) return;
    if (!discountInputMode) return;

    const raw = parseFloat(discountInputValue || "0");
    if (!raw || raw <= 0) {
      showDialog({
        tone: "error",
        title: "Invalid value",
        message: "Please enter a positive value.",
      });

      return;
    }

    setAppliedDiscount({
      kind: discountInputMode,
      value: raw,
      source: "OPEN",
      label:
        discountInputMode === "PERCENT"
          ? `${raw}%`
          : `${toMoney(raw)} SAR`,
    });

    setDiscountInputModalVisible(false);
  }

  function openPredefinedDiscount() {
    if (readOnlyCart) return;

    if (!canUsePredefinedDiscount) {
      showDialog({
        tone: "error",
        title: "No permission",
        message: "You are not allowed to apply predefined discounts.",
      });

      return;
    }

    setDiscountModeModalVisible(false);

    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    if (!items.length) {
      showDialog({
        tone: "info",
        title: "Empty cart",
        message: "Add items to the order before discount.",
      });

      return;
    }

    if (!applicableDiscounts.length) {
      showDialog({
        tone: "info",
        title: "No discounts",
        message: "No predefined discounts are applicable for this branch/cart.",
      });

      return;
    }

    setDiscountPresetModalVisible(true);
  }

  function applyPredefinedDiscount(cfg: DiscountConfig) {
    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    if (!isDiscountEligibleForCart(cfg, items)) {
      showDialog({
        tone: "info",
        title: "Not applicable",
        message: "This discount is not allowed for current items or order type.",
      });
      return;
    }

    setAppliedDiscount({
      kind: cfg.mode,
      value: cfg.value,
      source: "PREDEFINED",
      name: cfg.name,
      id: cfg.id,
      label:
        cfg.mode === "PERCENT"
          ? `${cfg.value}%`
          : `${toMoney(cfg.value)} SAR`,
    });

    setDiscountPresetModalVisible(false);
  }

  function clearDiscount() {
    setAppliedDiscount(null);
  }

  /* ------------------------ MANUAL SYNC BUTTON HANDLER ------------------------ */
  async function handleSyncPress() {
    if (!online) {
      showDialog({
        tone: "error",
        title: "Offline",
        message: "Cannot sync while offline. Please check your internet connection.",
      });
      return;
    }

    if (syncing) return;

    const TOTAL_STEPS = 6;

    try {
      setSyncing(true);
      setSyncProgressVisible(true);
      setSyncStepUI(0, "Preparing sync…");

      console.log("🔘 FULL MANUAL SYNC STARTED");

      setSyncStepUI(1, "Checking device & brand…");
      const bid = await getEffectiveBrandId();
      if (!bid) {
        showDialog({
          tone: "error",
          title: "Missing brand",
          message: "brandId is missing. Please re-activate device.",
        });
        return;
      }

      /* MENU */
      setSyncStepUI(2, "Syncing menu (categories/products)…");
      await syncMenu({
        brandId: bid,
        forceFull: true,
        includeInactive: true,
      });

      setSyncStepUI(3, "Refreshing categories…");
      const freshCats = await getLocalCategories();
      const mappedCats = mapLocalCategories(freshCats);
      setCategories(mappedCats);
      setFiltered(mappedCats);

      /* PRICE TIERS */
      setSyncStepUI(4, "Syncing price tiers…");
      try {
        const freshTiers = await refreshPriceTiersFromServer();
        setTiers(freshTiers);
      } catch (e) {
        console.log("Tier sync failed", e);
      }

      /* DISCOUNTS */
      setSyncStepUI(4, "Syncing discounts…");
      try {
        const list = await get("/discounts");
        if (Array.isArray(list)) setDiscountConfigs(list);
      } catch (e) {
        console.log("Discount sync failed", e);
      }

      /* POS CONFIG */
      setSyncStepUI(5, "Syncing POS config (VAT & payments)…");
      try {
        const cfg = await get("/pos/config");
        if (cfg?.vatRate) setVatRate(cfg.vatRate);

        if (Array.isArray(cfg?.paymentMethods)) {
          setPaymentMethods(
            cfg.paymentMethods.map((m: any) => ({
              id: String(m.id),
              name: String(m.name),
              code: m.code ?? null,
            }))
          );
        }
      } catch (e) {
        console.log("Config sync failed", e);
      }

      /* USERS */
      setSyncStepUI(5, "Syncing users & roles…");
      try {
        const { branchId } = await getDeviceInfo();
        if (branchId) {
          const res = await post("/auth/sync-users", { branchId });
          console.log("Users synced:", res?.length || 0);
        }
      } catch (e) {
        console.log("Users sync failed", e);
      }

      /* ORDERS */
      setSyncStepUI(6, "Syncing orders cache…");
      await syncOrdersCache();

      setSyncStepUI(TOTAL_STEPS, "Finishing…");
      showDialog({ tone: "success", title: "Sync complete", message: "All data synced successfully ✅" });
      console.log("✅ FULL SYNC COMPLETED");
    } catch (e) {
      console.log("MANUAL FULL SYNC ERROR", e);
      showDialog({
        tone: "error",
        title: "Sync error",
        message: "Failed to sync data.",
      });
    } finally {
      setSyncing(false);
      setSyncProgressVisible(false);
      setSyncStep(0);
      setSyncStatusText("Preparing…");
    }
  }
  /* ------------------------ LOAD POS CONFIG (VAT + Payment Methods) ------------------------ */
  useEffect(() => {
    let mounted = true;

    async function loadConfig() {
      try {
        const cfg = await get("/pos/config");
        console.log("📦 POS CONFIG (CategoryScreen):", cfg);
        if (!mounted) return;

        const vat = (cfg as any)?.vatRate;
        if (typeof vat === "number") setVatRate(vat);

        const methods = (cfg as any)?.paymentMethods;
        if (Array.isArray(methods)) {
          setPaymentMethods(
            methods.map((m: any) => ({
              id: String(m.id),
              code: m.code ?? null,
              name: String(m.name),
            }))
          );
        }
      } catch (err) {
        console.log("POS CONFIG ERR (CategoryScreen):", err);
      }
    }

    loadConfig();
    return () => {
      mounted = false;
    };
  }, []);

  /* ------------------------ LOAD PRICE TIERS (on mount) ------------------------ */
  useEffect(() => {
    let mounted = true;

    (async () => {
      // 1) local cache first
      const cached = await loadCachedPriceTiers();
      if (mounted && cached.length) {
        console.log("📥 PRICE TIERS from cache:", cached.length);
        setTiers(cached);
      }

      // 2) if online, refresh from API
      if (!online) return;

      try {
        setTierLoading(true);
        const fresh = await refreshPriceTiersFromServer();
        if (mounted) {
          console.log("🌐 PRICE TIERS from server:", fresh.length);
          setTiers(fresh);
        }
      } catch (e) {
        // if server fails, we still have cache (or empty)
        console.log("load price tiers error", e);
      } finally {
        if (mounted) setTierLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [online]);


  /* ------------------------ LOAD PRICE TIERS (offline-first from SQLite + server check) ------------------------ */
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setTierLoading(true);
        try {
          const info = await getDeviceInfo();
          if (info.branchId && !branchId) setBranchId(info.branchId);
          if (info.brandId && !brandId) setBrandId(info.brandId);
        } catch (e) {
          console.log("READ deviceInfo ERR (Tier load)", e);
        }

        const { tiers } = await loadPriceTiersWithSync({
          branchId: branchId ?? undefined,
          brandId: brandId ?? undefined,
        });

        if (!mounted) return;

        const list: PriceTier[] = (tiers || [])
          .filter((t: any) => t.isActive !== 0)
          .map((t: any) => ({
            id: t.id,
            name: t.name,
            code: t.code ?? null,
            type: (t as any).type ?? null, // optional: type if you store it
          }));

        setTiers(list);
        if (list.length > 0 && activeTier?.id && !list.some((t) => t.id === activeTier.id)) {
          await setActiveTier(null);
          setCart((prev: CartItem[]) =>
            clearTierFromCartLocal(Array.isArray(prev) ? prev : [])
          );
        }
      } catch (e) {
        console.log("load price tiers error", e);
      } finally {
        if (mounted) setTierLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [online, branchId, brandId, activeTier?.id, setActiveTier, setCart]);

  /* ------------------------ POLL BADGE FROM STORAGE ------------------------ */
  useEffect(() => {
    let mounted = true;
    let timer: any;

    async function loadBadge() {
      try {
        const raw = await AsyncStorage.getItem("newOrdersCount");
        if (!mounted) return;
        const n = raw ? Number(raw) || 0 : 0;
        setOrdersBadge(n);
      } catch (e) {
        console.log("LOAD BADGE ERR (CategoryScreen)", e);
      }
    }

    loadBadge();
    timer = setInterval(loadBadge, 3000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  /* ------------------------ WEBSOCKET: LIVE ORDER UPDATES ------------------------ */
  useEffect(() => {
    if (!online) {
      console.log("CategoryScreen WS disabled because offline");
      return;
    }

    let unsubscribe: (() => void) | undefined;

    (async () => {
      await registerPosDeviceOnSocket();

      unsubscribe = subscribeOrdersChanged(async (payload) => {
        try {
          if (payload.branchId && branchId && payload.branchId !== branchId)
            return;

          const ch = String(payload.channel || "").toUpperCase();
          const st = String(payload.status || "").toUpperCase();
          const isNew = payload.action === "created";

          if (ch === "CALLCENTER" && st === "PENDING" && isNew) {
            setOrdersBadge((prev) => {
              const next = prev + 1;
              AsyncStorage.setItem(
                "newOrdersCount",
                String(next)
              ).catch(() => {
                console.log("BADGE SAVE ERR (CategoryScreen)");
              });
              return next;
            });

            await playAlertSound();
          }

          await syncOrdersCache();
        } catch (e) {
          console.log(
            "WS orders:changed handler error (CategoryScreen)",
            e
          );
        }
      });
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [online, branchId]);

  // filter categories by search text
  useEffect(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      setFiltered(categories);
      return;
    }
    setFiltered(
      categories.filter((c) => c.name.toLowerCase().includes(q))
    );
  }, [search, categories]);

  function onCategoryPress(cat: Category) {
    navigation?.navigate?.("Products", {
      categoryId: cat.id,
      categoryName: cat.name,
      branchName,
      userName,
      goBack: () => {
        navigation?.navigate?.("Category", { branchName, userName });
      },
    });
  }

  /* ------------------------ CART TOTALS + PAYMENT CALC ------------------------ */

  const rawCartTotal: number = cartItems.reduce(
    (sum, it) => sum + calcLineTotal(it),
    0
  );

  let discountAmount = 0;
  if (appliedDiscount && rawCartTotal > 0) {
    if (appliedDiscount.kind === "AMOUNT") {
      discountAmount = Math.min(rawCartTotal, appliedDiscount.value);
    } else if (appliedDiscount.kind === "PERCENT") {
      discountAmount = Math.min(
        rawCartTotal,
        (rawCartTotal * appliedDiscount.value) / 100
      );
    }
  }

  const cartTotal = rawCartTotal - discountAmount;

  const vatFraction = vatRate > 0 ? vatRate / 100 : 0;
  const subtotalEx =
    cartTotal > 0 && vatFraction > 0
      ? cartTotal / (1 + vatFraction)
      : cartTotal;
  const vatAmount = cartTotal - subtotalEx;

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const remainingRaw = cartTotal - totalPaid;
  const remaining = remainingRaw > 0 ? remainingRaw : 0;
  const changeAmount = totalPaid > cartTotal ? totalPaid - cartTotal : 0;

  const groupedPayments = payments.reduce((acc, p) => {
    if (!acc[p.methodId]) acc[p.methodId] = { methodName: p.methodName, amount: 0 };
    acc[p.methodId].amount += p.amount;
    return acc;
  }, {} as Record<string, { methodName: string; amount: number }>);

  const groupedPaymentsArray = Object.values(groupedPayments);
  const quickAmounts = [remaining, 50, 100].filter((x) => x > 0.01);

  /* ------------------------ Global Till shift  HELPERS ------------------------ */
  async function handleOpenOrCloseTill() {
    try {
      if (!tillOpen) {
        // OPEN TILL (keep your current logic)
        const res: any = await post("/pos/till/open", { openingCash: 0 });

        await AsyncStorage.multiSet([
          ["pos_till_opened", "1"],
          ["pos_till_session_id", String(res?.tillSessionId || "")],
        ]);

        setTillOpen(true);
        showDialog({
          tone: "success",
          title: "Till opened",
          message: "Till opened successfully.",
        });
        setHomeMenuVisible(false);
        return;
      }

      //  CLOSE TILL -> open popup flow
      setHomeMenuVisible(false);
      setConfirmCloseVisible(true);
    } catch (e: any) {
      console.log("handleOpenOrCloseTill error", e);
      showDialog({
        tone: "error",
        title: "Error",
        message: e?.message || "Till operation failed.",
      });
      setHomeMenuVisible(false);
    }
  }
  /* ------------------------ CUSTOMER HELPERS ------------------------ */
  async function fetchCustomers(term: string) {
    try {
      setCustomerLoading(true);
      const qs = term
        ? `/pos/customers?search=${encodeURIComponent(term)}`
        : "/pos/customers";
      const data = await get(qs);
      const arr = Array.isArray(data) ? data : [];
      setCustomerList(
        arr.map((c: any) => ({
          id: String(c.id),
          name: String(c.name),
          phone: c.phone ?? null,
        }))
      );
    } catch (err) {
      console.log("LOAD CUSTOMERS ERROR (CategoryScreen)", err);
      showDialog({ tone: "error", title: "Error", message: "Failed to load customers." });
    } finally {
      setCustomerLoading(false);
    }
  }

  function openCustomerModal() {
    if (readOnlyCart) return;
    setCustomerSearch("");
    setNewCustomerName("");
    setNewCustomerPhone("");
    setCustomerList([]);
    setCustomerModalVisible(true);
    fetchCustomers("");
  }

  function handleSelectCustomer(c: CustomerSummary) {
    setSelectedCustomer(c);
    setCustomerModalVisible(false);
  }

  async function handleCreateCustomer() {
    const name = newCustomerName.trim();
    const phone = newCustomerPhone.trim();

    if (!name || !phone) {
      showDialog({
        tone: "error",
        title: "Missing data",
        message: "Name and phone are required.",
      });
      return;
    }

    try {
      setSavingCustomer(true);
      const created = await post("/pos/customers", { name, phone });

      const c: CustomerSummary = {
        id: String((created as any).id),
        name: String((created as any).name),
        phone: (created as any).phone ?? null,
      };

      setSelectedCustomer(c);
      setCustomerModalVisible(false);
    } catch (err: any) {
      console.log("CREATE CUSTOMER ERROR (CategoryScreen)", err);
      const msg = String(err?.message || err);
      if (msg.includes("Customer already exists")) {
        showDialog({
          tone: "info",
          title: "Customer already exists",
          message: "A customer with this phone already exists.",
        });
      } else {
        showDialog({
          tone: "error",
          title: "Error",
          message: "Failed to create customer.",
        });
      }
    } finally {
      setSavingCustomer(false);
    }
  }

  /* ------------------------ CART QTY CHANGE ------------------------ */
  function onChangeQtyInCart(index: number, delta: number) {
    if (readOnlyCart) return;
    setCart((prev: CartItem[]) => {
      const items = [...prev];
      const item = items[index];
      if (!item) return items;
      const newQty = item.qty + delta;
      if (newQty <= 0) items.splice(index, 1);
      else items[index] = { ...item, qty: newQty };
      return items;
    });
  }

  /* =========================
     ✅ PRICE TIER: button handler
     ========================= */

  async function openTierModal() {
    if (readOnlyCart) return;

    setTierModalVisible(true);
    if (online) { // 🔄 refresh from server when modal opens (if online)
      try {
        setTierLoading(true);
        const fresh = await refreshPriceTiersFromServer();
        setTiers(fresh);
      } catch (e) {
        console.log("refresh tiers error", e);
      } finally {
        setTierLoading(false);
      }
    }
  }

  async function applyTier(tier: PriceTier | null) {
    try {
      setActiveTier( // 1) save selected tier in store (incl. code for header display)
        tier
          ? {
            id: tier.id,
            name: tier.name,
            code: tier.code ?? null,
          }
          : null
      );
      if (!tier) { // 2) clear tier => restore original prices
        setCart((prev: CartItem[]) =>
          clearTierFromCartLocal(Array.isArray(prev) ? prev : [])
        );
        setTierModalVisible(false);
        return;
      }
      const items = Array.isArray(cartItems) ? cartItems : []; // 3) apply tier pricing only for IDs in cart
      const { productSizeIds, modifierItemIds } = collectTierIdsFromCart(items);

      if (!productSizeIds.length && !modifierItemIds.length) {
        setTierModalVisible(false);
        return;
      }

      const resp = await getTierPricingForIds({
        tierId: tier.id,
        productSizeIds,
        modifierItemIds,
      });
      setCart((prev: CartItem[]) => { // 4) update cart prices locally
        const arr = Array.isArray(prev) ? prev : [];
        return applyTierToCartLocal(
          arr,
          resp?.sizesMap || {},
          resp?.modifierItemsMap || {}
        );
      });

      setTierModalVisible(false);
    } catch (e: any) {
      console.log("applyTier error", e);
      showDialog({
        tone: "error",
        title: "Tier pricing",
        message: e?.message || "Failed to apply tier pricing",
      });
    }
  }

  /* ------------------------ PAYMENT FLOW ------------------------ */

  function openPaymentModal() {
    if (cartTotal <= 0) return;

    setSelectedPaymentMethodId(null);
    setShowCustomAmount(false);
    setCustomAmountInput("");
    setPaymentModalVisible(true);
  }

  const selectedMethod = paymentMethods.find(
    (m) => m.id === selectedPaymentMethodId
  );
  const selectedPaymentName = selectedMethod?.name || "";

  function addPayment(amount: number) {
    if (!selectedMethod) return;
    if (amount <= 0) return;

    setPayments((prev) => [
      ...prev,
      {
        methodId: selectedMethod.id,
        methodName: selectedMethod.name,
        amount,
      },
    ]);
  }

  function completePayment(amount: number) {
    if (!selectedMethod) return;

    const effectiveRemaining = remaining;

    addPayment(amount);
    setPaymentModalVisible(false);
    setSelectedPaymentMethodId(null);
    setShowCustomAmount(false);
    setCustomAmountInput("");

    if (amount > effectiveRemaining) {
      const change = amount - effectiveRemaining;
      if (change > 0.01)
        showDialog({
          tone: "info",
          title: "Change",
          message: `Return to customer: ${toMoney(change)}`,
        });
    }
  }

  function clearPayments() {
    if (!payments.length) return;
    showDialog({
      tone: "info",
      title: "Clear payments",
      message: "Remove all added payments?",
      primaryText: "Clear",
      secondaryText: "Cancel",
      onPrimary: () => setPayments([]),
    });
  }

  async function handlePay() {
    if (paying) return;
    if (cartTotal <= 0) return;
    if (remaining > 0.01) return;
    if (!payments.length) return;

    try {
      setPaying(true);

      let finalBrandId = brandId;
      let finalBranchId = branchId;
      let finalDeviceId = deviceId;

      if (!finalBrandId || !finalBranchId || !finalDeviceId) {
        const info = await getDeviceInfo();
        if (!finalBrandId && info.brandId) {
          finalBrandId = info.brandId;
          setBrandId(info.brandId);
        }
        if (!finalBranchId && info.branchId) {
          finalBranchId = info.branchId;
          setBranchId(info.branchId);
        }
        if (!finalDeviceId && info.deviceId) {
          finalDeviceId = info.deviceId;
          setDeviceId(info.deviceId);
        }
      }

      if (!finalDeviceId) {
        showDialog({
          tone: "error",
          title: "Device not activated",
          message: "deviceId is missing. Please re-activate this POS device.",
        });
        return;
      }

      const basePayload: any = {
        deviceId: finalDeviceId,
        branchId: finalBranchId || undefined,
        brandId: finalBrandId || undefined,
        brandName: brandName || "",   // from route/store/storage
        branchName: branchName || "", // from route/store/storage
        vatRate,
        subtotalEx,
        vatAmount,
        total: cartTotal,
        orderType,
        priceTierId: activeTier?.id ?? null,
        items: cartItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          sizeId: i.sizeId,
          sizeName: i.sizeName,
          qty: i.qty,
          unitPrice: i.price,
          modifiers:
            i.modifiers && i.modifiers.length > 0
              ? i.modifiers.map((m) => ({
                modifierItemId: m.itemId,
                price: m.price,
                qty: 1,
              }))
              : [],
        })),

        payments,
      };


      if (selectedCustomer?.id)
        basePayload.customerId = String(selectedCustomer.id);

      if (appliedDiscount && discountAmount > 0) {
        basePayload.discountAmount = discountAmount;
        basePayload.discount = {
          kind: appliedDiscount.kind,
          value: appliedDiscount.value,
          amount: discountAmount,
          source: appliedDiscount.source ?? null,
          name:
            appliedDiscount.name ||
            appliedDiscount.label ||
            null,
          configId: appliedDiscount.id ?? null,
          scope: "ORDER",
        };
      } else {
        basePayload.discountAmount = 0;
        basePayload.discount = null;
      }

      if (activeOrderId) {
        const resp = await post(`/orders/${activeOrderId}/close`, basePayload);
        console.log("✅ ORDER CLOSED (CategoryScreen)", resp);
      } else {
        const payload: any = {
          branchName,
          userName,
          status: "CLOSED",
          ...basePayload,
        };
        const resp = await post("/pos/orders", payload);
        console.log("✅ ORDER CREATED & CLOSED (CategoryScreen)", resp);
      }

      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);

      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue("0");

      await syncOrdersCache();
    } catch (err) {
      console.log("PAY ERROR (CategoryScreen)", err);
    } finally {
      setPaying(false);
    }
  }

  /* ------------------------ NEW ORDER (park cart as ACTIVE) ------------------------ */
  async function handleNewOrder() {
    const items = cartItems;

    if (activeOrderId) {
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);

      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue("0");

      return;
    }

    if (!items.length) {
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);

      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue("0");

      return;
    }

    try {
      let finalBrandId = brandId;
      let finalBranchId = branchId;
      let finalDeviceId = deviceId;

      if (!finalBrandId || !finalBranchId || !finalDeviceId) {
        const info = await getDeviceInfo();
        if (!finalBrandId && info.brandId) {
          finalBrandId = info.brandId;
          setBrandId(info.brandId);
        }
        if (!finalBranchId && info.branchId) {
          finalBranchId = info.branchId;
          setBranchId(info.branchId);
        }
        if (!finalDeviceId && info.deviceId) {
          finalDeviceId = info.deviceId;
          setDeviceId(info.deviceId);
        }
      }

      if (!finalDeviceId) {
        showDialog({
          tone: "error",
          title: "Device not activated",
          message: "deviceId is missing. Please re-activate this POS device.",
        });
        return;
      }

      const payload: any = {
        deviceId: finalDeviceId,
        branchId: finalBranchId || undefined,
        brandId: finalBrandId || undefined,
        branchName,
        userName,
        orderType,
        vatRate,
        subtotalEx,
        vatAmount,
        total: cartTotal,
        status: "ACTIVE",
        priceTierId: activeTier?.id ?? null, // ✅ tier info
        items: items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          sizeId: i.sizeId,
          sizeName: i.sizeName,
          qty: i.qty,
          unitPrice: i.price,
          modifiers:
            i.modifiers && i.modifiers.length > 0
              ? i.modifiers.map((m) => ({
                modifierItemId: m.itemId,
                price: m.price,
                qty: 1,
              }))
              : [],
        })),
        payments: [],
        ...(selectedCustomer?.id ? { customerId: selectedCustomer.id } : {}),
      };

      if (discountAmount > 0 && appliedDiscount) {
        payload.discountAmount = discountAmount;
        payload.discount = {
          kind: appliedDiscount.kind,
          value: appliedDiscount.value,
          amount: discountAmount,
          source: appliedDiscount.source ?? null,
          name:
            appliedDiscount.name ||
            appliedDiscount.label ||
            null,
          configId: appliedDiscount.id ?? null,
          scope: "ORDER",
        };
      } else {
        payload.discountAmount = 0;
        payload.discount = null;
      }

      const resp = await post("/pos/orders", payload);
      console.log("✅ ACTIVE ORDER CREATED (CategoryScreen)", resp);

      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);

      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue("0");

      await syncOrdersCache();
    } catch (err) {
      console.log("NEW ORDER ERROR (CategoryScreen)", err);
    }
  }

  /* ------------------------ VOID ORDER FROM CATEGORY ------------------------ */
  async function voidOrderNow(items: CartItem[]) {
    try {
      setVoidLoading(true);

      let finalBrandId = brandId;
      let finalBranchId = branchId;
      let finalDeviceId = deviceId;

      if (!finalBrandId || !finalBranchId || !finalDeviceId) {
        const info = await getDeviceInfo();
        if (!finalBrandId && info.brandId) {
          finalBrandId = info.brandId;
          setBrandId(info.brandId);
        }
        if (!finalBranchId && info.branchId) {
          finalBranchId = info.branchId;
          setBranchId(info.branchId);
        }
        if (!finalDeviceId && info.deviceId) {
          finalDeviceId = info.deviceId;
          setDeviceId(info.deviceId);
        }
      }

      if (!finalDeviceId) {
        showDialog({
          tone: "error",
          title: "Device not activated",
          message: "deviceId is missing. Please re-activate this POS device.",
        });
        return;
      }

      const payload: any = {
        deviceId: finalDeviceId,
        branchId: finalBranchId || undefined,
        brandId: finalBrandId || undefined,
        branchName,
        userName,
        status: "VOID",
        orderType,
        vatRate,
        subtotalEx,
        vatAmount,
        total: cartTotal,
        priceTierId: activeTier?.id ?? null,
        items: items.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          sizeId: i.sizeId,
          sizeName: i.sizeName,
          qty: i.qty,
          unitPrice: i.price,
          modifiers:
            i.modifiers && i.modifiers.length > 0
              ? i.modifiers.map((m) => ({
                modifierItemId: m.itemId,
                price: m.price,
                qty: 1,
              }))
              : [],
        })),
        payments: [],
        ...(selectedCustomer?.id ? { customerId: selectedCustomer.id } : {}),
      };

      if (discountAmount > 0 && appliedDiscount) {
        payload.discountAmount = discountAmount;
        payload.discount = {
          kind: appliedDiscount.kind,
          value: appliedDiscount.value,
          amount: discountAmount,
          source: appliedDiscount.source ?? null,
          name: appliedDiscount.name || appliedDiscount.label || null,
          configId: appliedDiscount.id ?? null,
          scope: "ORDER",
        };
      } else {
        payload.discountAmount = 0;
        payload.discount = null;
      }

      await post("/pos/orders", payload);

      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);

      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue("0");

      await syncOrdersCache();
    } catch (err: any) {
      console.log("VOID ORDER ERROR (CategoryScreen)", err);
      showDialog({
        tone: "error",
        title: "Error",
        message: err?.message || "Failed to void this order",
      });
    } finally {
      setVoidLoading(false);
    }
  }

  function handleVoidPress() {
    const items: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!items.length) {
      showDialog({
        tone: "info",
        title: "No items",
        message: "Add items first.",
      });
      return;
    }

    showDialog({
      tone: "error",
      title: "Void order",
      message: "Are you sure you want to void this order?",
      primaryText: "Void",
      secondaryText: "Cancel",
      onPrimary: () => voidOrderNow(items),
    });
  }

  /* ------------------------ KITCHEN + INVOICE PRINT ------------------------ */
  async function handleKitchenPress() {
    console.log("🍳 Kitchen pressed");

    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    if (!items.length) {
      showDialog({
        tone: "info",
        title: "No items",
        message: "Add items first.",
      });
      return;
    }

    const canKitchen = hasPermission("pos.kitchen.reprint");

    if (!canKitchen) {
      showDialog({
        tone: "error",
        title: "Access denied",
        message: "You don't have permission to print kitchen tickets.",
      });
      return;
    }

    try {
      await printKitchenTicket({
        brandName: brandName || null,
        branchName: branchName || null,
        userName: userName || null,
        orderNo: activeOrderId || null,
        orderType: orderType || null,
        businessDate: new Date(),
        tableName: null,
        notes: null,
        cart: items as any,
      } as any);

      showDialog({
        tone: "success",
        title: "Success",
        message: "Kitchen ticket printed.",
      });
    } catch (e: any) {
      console.log("❌ Kitchen print error", e);
      showDialog({
        tone: "error",
        title: "Print failed",
        message: e?.message || "Failed to print.",
      });
    }
  }

  async function handlePrintPress() {
    console.log("🧾 Print pressed");

    const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
    if (!items.length) {
      showDialog({
        tone: "info",
        title: "No items",
        message: "Add items first.",
      });
      return;
    }

    const canPrint =
      hasPermission("pos.print.receipt") || hasPermission("pos.print.check");

    if (!canPrint) {
      showDialog({
        tone: "error",
        title: "Access denied",
        message: "You don't have permission to print.",
      });
      return;
    }

    // Most receipt printers are filtered by enabledOrderTypes → require orderType
    if (!orderType) {
      showDialog({
        tone: "info",
        title: "Order type required",
        message: "Please select order type first.",
      });
      setOrderTypeModalVisible(true);
      return;
    }

    try {
      await printReceiptForOrder({
        brandName: brandName || null,
        branchName: branchName || null,
        userName: userName || null,
        orderNo: activeOrderId || null,
        orderType: orderType || null,
        businessDate: new Date(),

        cart: items as any,
        subtotal: subtotalEx,
        vatAmount,
        total: cartTotal,
        discountAmount,
        payments: [],
      } as any);

      showDialog({
        tone: "success",
        title: "Success",
        message: "Invoice printed.",
      });
    } catch (e: any) {
      console.log("❌ Invoice print error", e);
      showDialog({
        tone: "error",
        title: "Print failed",
        message: e?.message || "Failed to print invoice.",
      });
    }
  }


  const payDisabled =
    paying || cartTotal <= 0 || remaining > 0.01 || payments.length === 0;


  //Close Till

  function handleKeypadPress(key: string) {
    if (key === "C") {
      setTillCloseAmount("");
      return;
    }
    setTillCloseAmount((prev) => (prev || "") + key);
  }

  async function actuallyCloseTill(closingCash: number) {
    try {
      const localTillId = await AsyncStorage.getItem("pos_till_session_id");
      if (!localTillId) throw new Error("Missing till session id");

      // 1) save local till close
      await closeLocalTill(localTillId, closingCash);

      // 2) load session for report
      const session = await getLocalTillSession(localTillId);

      // 3) build report
      const openedAt = String(session.openedAt);
      const closedAt = String(session.closedAt || new Date().toISOString());

      const report = await generateTillCloseReport({
        tillSessionId: localTillId,
        branchId,
        brandId,
        deviceId,
        branchName,
        userName,
        openingCash: Number(session.openingCash || 0),
        closingCash: Number(session.closingCash || closingCash),
        openedAt,
        closedAt,
      });

      setLastReport(report);

      // 4) clear flags
      await AsyncStorage.multiSet([
        ["pos_till_opened", "0"],
        ["pos_till_session_id", ""],
      ]);

      setTillOpen(false);
      setTillCloseAmount("");

      // 5) sync online (if your "online" prop is true)
      if (online) {
        try {
          await post("/pos/till/close", {
            branchId,
            brandId,
            deviceId,
            clientId: localTillId,
            closingCash,
            report,
          });
        } catch (e) {
          console.log("❌ till close sync failed", e);
        }
      }

      // 6) print prompt
      setPrintPromptVisible(true);
    } catch (e: any) {
      showDialog({
        tone: "error",
        title: "Till close failed",
        message: e?.message || "Try again.",
      });
    }
  }

  async function handlePrintTillReport(shouldPrint: boolean) {
    setPrintPromptVisible(false);
    if (!shouldPrint) return;

    try {
      if (!lastReport) {
        showDialog({
          tone: "info",
          title: "No report",
          message: "Till report was not generated.",
        });
        return;
      }
      await printTillCloseReport(lastReport);
      showDialog({
        tone: "success",
        title: "Printed",
        message: "Till report sent to printer.",
      });
    } catch (e: any) {
      showDialog({
        tone: "error",
        title: "Print failed",
        message: e?.message || "Try again",
      });
    }
  }
  /* ------------------------ RENDER ------------------------ */
  return (
    <SafeAreaView style={styles.root}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topSub}>Branch: {branchName || "-"}</Text>
          <Text style={styles.topSub}>User: {userName || "-"}</Text>
          <Text style={styles.topSub}>
            Price Tier:{" "}
            {activeTier
              ? activeTier.code
                ? `${activeTier.name} (${activeTier.code})`
                : activeTier.name
              : "-"}
          </Text>
        </View>
      </View>

      {/* Main two-column layout */}
      <View style={styles.mainRow}>
        {/* LEFT – Order panel */}
        <View style={styles.orderPanel}>
          <View style={styles.orderHeaderRow}>
            <Pressable
              style={[styles.customerButton, readOnlyCart && { opacity: 0.5 }]}
              onPress={openCustomerModal}
              disabled={readOnlyCart}
            >
              <Text style={styles.customerButtonText}>
                {selectedCustomer ? selectedCustomer.name : "Add Customers"}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setOrderTypeModalVisible(true)}
              style={styles.orderTypeTag}
              disabled={readOnlyCart}
            >
              <Text style={styles.orderTypeText}>
                {orderType || "SELECT ORDER TYPE"}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.orderTitle}>Current Order</Text>

          <ScrollView style={styles.orderList}>
            {cartItems.length === 0 ? (
              <Text style={styles.orderEmpty}>
                No items yet. Select a category, then add products.
              </Text>
            ) : (
              cartItems.map((item, idx) => {
                const unitWithMods =
                  normalizePrice(item.price) +
                  calcLineModifierTotal(item.modifiers);
                const mods = item.modifiers || [];

                return (
                  <View key={idx.toString()} style={styles.orderRowFull}>
                    <Pressable
                      style={{ flex: 1 }}
                      onPress={() =>
                        navigation.navigate("Modifiers", {
                          productId: item.productId,
                          productName: item.productName,
                          sizeId: item.sizeId,
                          sizeName: item.sizeName,
                          modifiers: item.modifiers || [],
                        })
                      }
                    >
                      <View style={styles.orderLineTop}>
                        <Text style={styles.orderItemName}>
                          {item.productName}
                        </Text>
                        <Text style={styles.orderItemSize}>
                          {item.sizeName || ""}
                        </Text>
                        <Text style={styles.orderItemPriceRight}>
                          {toMoney(unitWithMods)}
                        </Text>
                      </View>

                      {mods.length > 0 && (
                        <Text
                          style={styles.orderItemModifiers}
                          numberOfLines={2}
                        >
                          {mods.map((m) => m.itemName).join(", ")}
                        </Text>
                      )}
                    </Pressable>

                    <View style={styles.qtyBox}>
                      <Pressable
                        style={styles.qtyTapLeft}
                        onPress={() => onChangeQtyInCart(idx, -1)}
                      >
                        <Text style={styles.qtyText}>-</Text>
                      </Pressable>
                      <View style={styles.qtyMid}>
                        <Text style={styles.qtyValue}>{item.qty}</Text>
                      </View>
                      <Pressable
                        style={styles.qtyTapRight}
                        onPress={() => onChangeQtyInCart(idx, +1)}
                      >
                        <Text style={styles.qtyText}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          {/* SUMMARY + TOTAL BUTTON */}
          <View style={styles.orderFooter}>
            <View style={{ flex: 1 }}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Subtotal (ex-VAT)</Text>
                <Text style={styles.summaryValue}>{toMoney(subtotalEx)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  VAT ({vatRate.toFixed(2)}%)
                </Text>
                <Text style={styles.summaryValue}>{toMoney(vatAmount)}</Text>
              </View>

              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  {appliedDiscount
                    ? `Discount (${appliedDiscount.name ||
                    appliedDiscount.label ||
                    (appliedDiscount.kind === "PERCENT"
                      ? `${appliedDiscount.value}%`
                      : toMoney(appliedDiscount.value))
                    })`
                    : "Discount"}
                </Text>

                <View style={styles.discountInputWrap}>
                  <TextInput
                    style={styles.discountInput}
                    value={
                      discountAmount > 0 ? `-${toMoney(discountAmount)}` : ""
                    }
                    editable={false}
                    pointerEvents="none"
                  />
                </View>
              </View>

              {appliedDiscount && (
                <Pressable
                  onPress={async () => {
                    setAppliedDiscount(null);
                    setDiscountValue("0");
                    await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
                  }}
                >
                  <Text style={styles.removeDiscountText}>
                    Remove discount
                  </Text>
                </Pressable>
              )}

              {groupedPaymentsArray.length > 0 && (
                <View style={styles.paymentsSummaryBox}>
                  {groupedPaymentsArray.map((p) => (
                    <View
                      key={p.methodName}
                      style={styles.paymentSummaryRow}
                    >
                      <Text style={styles.paymentSummaryLabel}>
                        {p.methodName}
                      </Text>
                      <Text style={styles.paymentSummaryValue}>
                        {toMoney(p.amount)}
                      </Text>
                    </View>
                  ))}
                  <View style={styles.paymentSummaryTotalRow}>
                    <Text style={styles.paymentSummaryTotalLabel}>Paid</Text>
                    <Text style={styles.paymentSummaryTotalValue}>
                      {toMoney(totalPaid)}
                    </Text>
                  </View>
                </View>
              )}
            </View>

            <Pressable
              style={styles.totalButton}
              onPress={openPaymentModal}
            >
              <Text style={styles.totalButtonLabel}>TOTAL</Text>
              <Text style={styles.totalButtonValue}>
                {toMoney(cartTotal)}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* RIGHT – Actions + search + categories */}
        <View style={styles.rightPanel}>
          <View style={styles.actionRow}>
            {["Price Tag", "Print", "Kitchen", "Void", "Discount", "Notes", "Tags", "Sync", "More"].map((label) => {
              const isVoid = label === "Void";
              const isSync = label === "Sync";
              const isTier = label === "Price Tag";
              const isDiscount = label === "Discount";
              const isPrint = label === "Print";
              const isKitchen = label === "Kitchen";

              let onPress: () => void | Promise<void> = () =>
                console.log(label.toUpperCase(), "pressed");

              //  IMPORTANT: keep braces
              if (isVoid) {
                onPress = handleVoidPress;
              } else if (isSync) {
                onPress = handleSyncPress;
              } else if (isTier) {
                onPress = openTierModal;
              } else if (isDiscount) {
                onPress = openDiscountMenu;
              } else if (isPrint) {
                onPress = handlePrintPress;
              } else if (isKitchen) {
                onPress = handleKitchenPress;
              }

              const disabled =
                (isVoid && voidLoading) ||
                (isSync && syncing) ||
                (isDiscount && (readOnlyCart || !canUseAnyDiscount)) ||
                (isKitchen && !hasPermission("pos.kitchen.reprint")) ||
                (isPrint &&
                  !(hasPermission("pos.print.receipt") ||
                    hasPermission("pos.print.check")));

              return (
                <Pressable
                  key={label}
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed && { opacity: 0.8 },
                    disabled && { opacity: 0.6 },
                  ]}
                  onPress={onPress}
                  disabled={disabled}
                >
                  <Text style={styles.actionText}>
                    {isVoid && voidLoading ? "VOID…" : isSync && syncing ? "SYNC…" : label.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}


          </View>


          <View style={styles.searchBox}>
            <TextInput
              placeholder="Search categories"
              placeholderTextColor="#9ca3af"
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
            />
          </View>

          {loading && (
            <View style={styles.center}>
              <ActivityIndicator size="large" />
            </View>
          )}

          {!loading && error && (
            <View style={styles.center}>
              <Text style={{ color: "#b91c1c" }}>{error}</Text>
            </View>
          )}

          {!loading && !error && (
            <ScrollView
              contentContainerStyle={styles.grid}
              showsVerticalScrollIndicator={false}
            >
              {filtered.map((cat) => (
                <Pressable
                  key={cat.id}
                  style={({ pressed }) => [
                    styles.categoryTile,
                    pressed && { opacity: 0.85 },
                  ]}
                  onPress={() => onCategoryPress(cat)}
                >
                  <View style={styles.categoryImageWrap}>
                    {(() => {
                      const img = normalizeImageUrl(cat.imageUrl);

                      return img ? (
                        <Image
                          source={{ uri: img }}
                          style={styles.categoryImage}
                          resizeMode="cover"
                          onError={(e) => {
                            console.log(
                              "❌ Category image failed:",
                              img,
                              e?.nativeEvent
                            );
                          }}
                        />
                      ) : (
                        <View style={styles.categoryPlaceholder}>
                          <Text style={styles.categoryPlaceholderText}>
                            IMG
                          </Text>
                        </View>
                      );
                    })()}
                  </View>

                  <Text style={styles.categoryName} numberOfLines={2}>
                    {cat.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>

      {/* PAYMENT FOOTER */}
      <View style={styles.paymentFooter}>
        <View style={{ flex: 1 }}>
          {payments.length > 0 && (
            <Pressable onPress={clearPayments}>
              <Text style={styles.clearPaymentsText}>CLEAR PAYMENTS</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.remainingLabel}>Remaining</Text>
        <Text style={styles.remainingValue}>{toMoney(remaining)}</Text>

        {changeAmount > 0.01 && (
          <>
            <Text style={styles.changeLabel}>Change</Text>
            <Text style={styles.changeValue}>{toMoney(changeAmount)}</Text>
          </>
        )}

        <Pressable
          style={[
            styles.payButton,
            payDisabled && styles.payButtonDisabled,
          ]}
          onPress={handlePay}
          disabled={payDisabled}
        >
          <Text style={styles.payButtonText}>
            {paying ? "PAYING..." : "PAY"}
          </Text>
        </Pressable>
      </View>

      {/* Bottom POS bar */}
      <View style={styles.bottomBar}>
        <Pressable
          style={styles.bottomItem}
          onPress={() => setHomeMenuVisible(true)}
        >
          <Text style={styles.bottomIcon}>🏠</Text>
          <Text style={styles.bottomLabel}>HOME</Text>
        </Pressable>

        <Pressable
          style={[styles.bottomItem]}
          onPress={() => navigation.navigate("Orders")}
        >
          <Text style={[styles.bottomIcon]}>🧾</Text>
          <Text style={[styles.bottomLabel]}>ORDERS</Text>

          {ordersBadge > 0 && (
            <View style={styles.bottomBadge}>
              <Text style={styles.bottomBadgeText}>
                {ordersBadge > 99 ? "99+" : ordersBadge}
              </Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={styles.bottomItem}
          onPress={() => console.log("TABLES pressed")}
        >
          <Text style={styles.bottomIcon}>📋</Text>
          <Text style={styles.bottomLabel}>TABLES</Text>
        </Pressable>

        <Pressable style={styles.bottomItem} onPress={handleNewOrder}>
          <Text style={styles.bottomIcon}>＋</Text>
          <Text style={styles.bottomLabel}>NEW</Text>
        </Pressable>
      </View>

      {/* ✅ PRICE TIER MODAL */}
      <Modal
        visible={tierModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTierModalVisible(false)}
      >
        <View style={styles.tierBackdrop}>
          <View style={styles.tierCard}>
            {/* Header */}
            <View style={styles.tierHeader}>
              <View style={styles.tierTitleWrap}>
                <Text style={styles.tierTitle}>Select price tier</Text>
                <Text style={styles.tierSub}>
                  Choose a tier to apply pricing overrides
                </Text>
              </View>

              <Pressable
                onPress={() => setTierModalVisible(false)}
                style={({ pressed }) => [
                  styles.tierCloseBtn,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text style={styles.tierCloseText}>Close</Text>
              </Pressable>
            </View>

            {/* Body */}
            {tierLoading ? (
              <View
                style={{ paddingVertical: 18, alignItems: "center" }}
              >
                <ActivityIndicator />
                <Text style={styles.tierLoadingText}>
                  Loading tiers…
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.tierList}>
                {/* Default / Remove tier */}
                <Pressable
                  onPress={() => applyTier(null)}
                  style={({ pressed }) => [
                    styles.tierRow,
                    !activeTier && styles.tierRowSelected,
                    pressed && styles.tierRowPressed,
                  ]}
                >
                  <View style={styles.tierRowLeft}>
                    <Text style={styles.tierRowText}>Default pricing</Text>
                    <Text style={styles.tierRowCode}>Remove tier</Text>
                  </View>

                  {!activeTier ? (
                    <View style={styles.tierCheck}>
                      <Text style={styles.tierCheckText}>✓</Text>
                    </View>
                  ) : null}
                </Pressable>

                {/* Tiers */}
                {tiers.map((t) => {
                  const isSelected = activeTier?.id === t.id;

                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => applyTier(t)}
                      style={({ pressed }) => [
                        styles.tierRow,
                        isSelected && styles.tierRowSelected,
                        pressed && styles.tierRowPressed,
                      ]}
                    >
                      <View style={styles.tierRowLeft}>
                        <Text style={styles.tierRowText}>{t.name}</Text>
                        <Text style={styles.tierRowCode}>
                          {(t.code || "").toUpperCase()}
                          {t.type
                            ? ` • ${String(t.type).toUpperCase()}`
                            : ""}
                        </Text>
                      </View>

                      {isSelected ? (
                        <View style={styles.tierCheck}>
                          <Text style={styles.tierCheckText}>✓</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}

                {!tiers.length ? (
                  <Text
                    style={{
                      color: "#6B7280",
                      paddingHorizontal: 16,
                      paddingVertical: 10,
                    }}
                  >
                    No active tiers found.
                  </Text>
                ) : null}
              </ScrollView>
            )}

            {/* Footer */}
            <View style={styles.tierFooter}>
              <Pressable
                onPress={() => setTierModalVisible(false)}
                style={({ pressed }) => [
                  styles.tierBtn,
                  styles.tierBtnGhost,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text
                  style={[
                    styles.tierBtnText,
                    styles.tierBtnTextGhost,
                  ]}
                >
                  Cancel
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setTierModalVisible(false)}
                style={({ pressed }) => [
                  styles.tierBtn,
                  styles.tierBtnPrimary,
                  pressed && { opacity: 0.9 },
                ]}
              >
                <Text
                  style={[
                    styles.tierBtnText,
                    styles.tierBtnTextPrimary,
                  ]}
                >
                  Done
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Order type popup */}
      <Modal
        visible={orderTypeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setOrderTypeModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setOrderTypeModalVisible(false)}
        >
          <View style={styles.orderTypeCard}>
            <Text style={styles.orderTypeTitle}>Order type</Text>

            {["Dine In", "Pick Up", "Delivery", "Drive Thru"].map((t) => (
              <Pressable
                key={t}
                style={({ pressed }) => [
                  styles.orderTypeRow,
                  pressed && { backgroundColor: "#f3f4f6" },
                ]}
                onPress={() => {
                  setOrderType(t);
                  setOrderTypeModalVisible(false);
                }}
              >
                <Text style={styles.orderTypeRowText}>{t}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* PAYMENT MODAL */}
      <Modal
        visible={paymentModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPaymentModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          {!selectedPaymentMethodId ? (
            <View style={styles.paymentCard}>
              <Text style={styles.modalTitle}>PAYMENT METHODS</Text>
              <ScrollView style={{ maxHeight: 320 }}>
                {paymentMethods.map((m) => (
                  <Pressable
                    key={m.id}
                    style={({ pressed }) => [
                      styles.paymentMethodRow,
                      pressed && { opacity: 0.8 },
                    ]}
                    onPress={() => setSelectedPaymentMethodId(m.id)}
                  >
                    <Text style={styles.paymentMethodText}>{m.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>

              <Pressable
                style={[styles.modalClose, { marginTop: 16 }]}
                onPress={() => setPaymentModalVisible(false)}
              >
                <Text style={styles.modalCloseText}>Close</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.amountCard}>
              <View style={styles.amountHeader}>
                <Text style={styles.modalTitle}>{selectedPaymentName}</Text>
                <Text style={styles.amountRemainingText}>
                  Remaining: {toMoney(remaining)}
                </Text>
              </View>

              <View>
                {quickAmounts.map((amt, idx) => (
                  <Pressable
                    key={idx.toString()}
                    style={({ pressed }) => [
                      styles.amountRow,
                      pressed && { opacity: 0.8 },
                    ]}
                    onPress={() => completePayment(amt)}
                  >
                    <Text style={styles.amountText}>{toMoney(amt)}</Text>
                  </Pressable>
                ))}

                <Pressable
                  style={styles.amountRow}
                  onPress={() => setShowCustomAmount(true)}
                >
                  <Text style={styles.amountText}>CUSTOM</Text>
                </Pressable>

                {showCustomAmount && (
                  <View style={styles.customAmountBox}>
                    <Text style={styles.customLabel}>Enter amount</Text>
                    <TextInput
                      style={styles.customInput}
                      value={customAmountInput}
                      onChangeText={setCustomAmountInput}
                      keyboardType="numeric"
                      placeholder="0.00"
                      placeholderTextColor="#9ca3af"
                    />
                    <Pressable
                      style={styles.customApplyButton}
                      onPress={() => {
                        const val = parseFloat(
                          customAmountInput || "0"
                        );
                        if (!val || val <= 0) {
                          showDialog({
                            tone: "error",
                            title: "Invalid amount",
                            message: "Please enter a valid amount.",
                          });
                          return;
                        }
                        completePayment(val);
                      }}
                    >
                      <Text style={styles.customApplyText}>APPLY</Text>
                    </Pressable>
                  </View>
                )}

                <Pressable
                  style={styles.amountCancelRow}
                  onPress={() => {
                    setSelectedPaymentMethodId(null);
                    setShowCustomAmount(false);
                    setCustomAmountInput("");
                    setPaymentModalVisible(false);
                  }}
                >
                  <Text style={styles.amountCancelText}>CANCEL</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {/* CUSTOMERS MODAL */}
      <Modal
        visible={customerModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCustomerModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.customerCard}>
            <Text style={styles.modalTitle}>Select customer</Text>

            <View style={styles.customerSearchRow}>
              <TextInput
                style={styles.customerSearchInput}
                placeholder="Search by name or phone"
                placeholderTextColor="#9ca3af"
                value={customerSearch}
                onChangeText={setCustomerSearch}
              />
              <Pressable
                style={styles.customerSearchButton}
                onPress={() => fetchCustomers(customerSearch)}
              >
                <Text style={styles.customerSearchButtonText}>Search</Text>
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 220 }}>
              {customerLoading && (
                <View style={styles.customerLoadingBox}>
                  <ActivityIndicator />
                </View>
              )}

              {!customerLoading &&
                customerList.map((c) => (
                  <Pressable
                    key={c.id}
                    style={styles.customerRow}
                    onPress={() => handleSelectCustomer(c)}
                  >
                    <Text style={styles.customerName}>{c.name}</Text>
                    {!!c.phone && (
                      <Text style={styles.customerPhone}>{c.phone}</Text>
                    )}
                  </Pressable>
                ))}

              {!customerLoading && customerList.length === 0 && (
                <Text style={styles.customerEmptyText}>
                  No customers found.
                </Text>
              )}
            </ScrollView>

            <View style={styles.customerNewBox}>
              <Text style={styles.customerNewTitle}>Create new</Text>
              <TextInput
                style={styles.customerInput}
                placeholder="Name *"
                placeholderTextColor="#9ca3af"
                value={newCustomerName}
                onChangeText={setNewCustomerName}
              />
              <TextInput
                style={styles.customerInput}
                placeholder="Phone *"
                placeholderTextColor="#9ca3af"
                keyboardType="phone-pad"
                value={newCustomerPhone}
                onChangeText={setNewCustomerPhone}
              />
              <Pressable
                style={[
                  styles.customerSaveButton,
                  savingCustomer && { opacity: 0.7 },
                ]}
                onPress={handleCreateCustomer}
                disabled={savingCustomer}
              >
                <Text style={styles.customerSaveText}>
                  {savingCustomer ? "SAVING…" : "SAVE"}
                </Text>
              </Pressable>
            </View>

            <Pressable
              style={[styles.modalClose, { marginTop: 12 }]}
              onPress={() => setCustomerModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      {/* ------------------------ DISCOUNT MODALS ------------------------ */}
      {/* Discount Mode */}
      <Modal
        visible={discountModeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDiscountModeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.paymentCard}>
            <Text style={styles.modalTitle}>Discount</Text>
            <Text style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
              Choose discount type
            </Text>

            <View style={{ gap: 10 }}>
              <Pressable
                onPress={() => openDiscountInput("AMOUNT")}
                disabled={readOnlyCart || !canUseOpenDiscount}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: canUseOpenDiscount ? "#111827" : "#e5e7eb",
                }}
              >
                <Text
                  style={{
                    color: canUseOpenDiscount ? "#ffffff" : "#9ca3af",
                    fontWeight: "800",
                    fontSize: 13,
                  }}
                >
                  OPEN AMOUNT
                </Text>
              </Pressable>

              <Pressable
                onPress={() => openDiscountInput("PERCENT")}
                disabled={readOnlyCart || !canUseOpenDiscount}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: canUseOpenDiscount ? "#111827" : "#e5e7eb",
                }}
              >
                <Text
                  style={{
                    color: canUseOpenDiscount ? "#ffffff" : "#9ca3af",
                    fontWeight: "800",
                    fontSize: 13,
                  }}
                >
                  OPEN PERCENT
                </Text>
              </Pressable>

              <Pressable
                onPress={openPredefinedDiscount}
                disabled={readOnlyCart || !canUsePredefinedDiscount}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: canUsePredefinedDiscount
                    ? "#111827"
                    : "#e5e7eb",
                }}
              >
                <Text
                  style={{
                    color: canUsePredefinedDiscount ? "#ffffff" : "#9ca3af",
                    fontWeight: "800",
                    fontSize: 13,
                  }}
                >
                  PREDEFINED DISCOUNTS
                </Text>
              </Pressable>
            </View>

            <Pressable
              style={[styles.modalClose, { marginTop: 16 }]}
              onPress={() => setDiscountModeModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Discount Input (open amount/percent) */}
      <Modal
        visible={discountInputModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDiscountInputModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.paymentCard}>
            <Text style={styles.modalTitle}>
              {discountInputMode === "PERCENT"
                ? "Discount Percent"
                : "Discount Amount"}
            </Text>
            <Text style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
              Enter {discountInputMode === "PERCENT" ? "%" : "amount"} value
            </Text>

            <TextInput
              value={discountInputValue}
              onChangeText={setDiscountInputValue}
              keyboardType="numeric"
              editable={!readOnlyCart}
              placeholder={
                discountInputMode === "PERCENT" ? "e.g. 10" : "e.g. 5"
              }
              placeholderTextColor="#9ca3af"
              style={{
                borderWidth: 1,
                borderColor: "#d1d5db",
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                fontSize: 14,
                color: "#111827",
                backgroundColor: "#f9fafb",
              }}
            />

            <Pressable
              onPress={applyDiscountInput}
              disabled={readOnlyCart}
              style={{
                marginTop: 12,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: "#111827",
                alignItems: "center",
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "800" }}>APPLY</Text>
            </Pressable>

            <Pressable
              style={[styles.modalClose, { marginTop: 12 }]}
              onPress={() => setDiscountInputModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Discount Presets */}
      <Modal
        visible={discountPresetModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDiscountPresetModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.paymentCard}>
            <Text style={styles.modalTitle}>Predefined Discounts</Text>
            <Text style={{ fontSize: 13, color: "#6b7280", marginBottom: 10 }}>
              Select an applicable discount
            </Text>

            <ScrollView style={{ maxHeight: 320 }}>
              {applicableDiscounts.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => applyPredefinedDiscount(d)}
                  disabled={readOnlyCart}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "#e5e7eb",
                    backgroundColor: "#ffffff",
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ fontWeight: "900", color: "#111827" }}>
                    {d.name}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: "#6b7280",
                      marginTop: 4,
                    }}
                  >
                    {d.mode === "PERCENT"
                      ? `${d.value}%`
                      : `${toMoney(d.value)}`}
                    {d.scope ? ` • ${d.scope}` : ""}
                  </Text>
                </Pressable>
              ))}

              {applicableDiscounts.length === 0 && (
                <Text style={{ fontSize: 12, color: "#6b7280" }}>
                  No applicable discounts.
                </Text>
              )}
            </ScrollView>

            <Pressable
              style={[styles.modalClose, { marginTop: 12 }]}
              onPress={() => setDiscountPresetModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* HOME POPUP MENU */}
      <Modal
        visible={homeMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setHomeMenuVisible(false)}
      >
        <View style={styles.homeMenuOverlay}>
          {/* tap outside to close */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setHomeMenuVisible(false)}
          />

          <View style={styles.homeMenuCard}>
            {/* 1) OPEN / CLOSE TILL – DYNAMIC */}
            <Pressable style={styles.homeMenuItem} onPress={handleOpenOrCloseTill}>
              <MaterialIcons
                name={tillOpen ? "lock" : "lock-open"}
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
              <Text style={styles.homeMenuItemText}>
                {tillOpen ? "Close Till" : "Open Till"}
              </Text>
            </Pressable>

            {/* Drawer Operations */}
            <Pressable
              style={styles.homeMenuItem}
              onPress={async () => {
                setHomeMenuVisible(false);

                try { await refreshAuth?.(); } catch { }

                const ok =
                  hasPermission("pos.drawer.operations") ||
                  hasPermission("DRAWER_OPERATIONS");

                if (!ok) {
                  showDialog({
                    tone: "error",
                    title: "Access denied",
                    message: "You don't have permission to access drawer operations.",
                  });
                  return;
                }

                navigation.navigate("DrawerOperations");
              }}
            >
              <MaterialIcons name="inbox" size={20} color="#111827" style={{ marginRight: 10 }} />
              <Text style={styles.homeMenuItemText}>Drawer Operations</Text>
            </Pressable>

            {/* 3) House Account */}
            <Pressable style={styles.homeMenuItem} onPress={() => { }}>
              <MaterialIcons
                name="account-balance-wallet"
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
              <Text style={styles.homeMenuItemText}>House Account Payment</Text>
            </Pressable>

            {/* 4) E-Invoice */}
            <Pressable style={styles.homeMenuItem} onPress={() => { }}>
              <MaterialIcons
                name="receipt"
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
              <Text style={styles.homeMenuItemText}>E-Invoice (ZATCA)</Text>
            </Pressable>

            {/* Reports */}
            <Pressable
              style={styles.homeMenuItem}
              onPress={async () => {
                setHomeMenuVisible(false);

                try { await refreshAuth?.(); } catch { }

                const ok =
                  hasPermission("pos.reports.view") ||
                  hasPermission("pos.reports.access") ||
                  hasPermission("ACCESS_REPORTS");

                if (!ok) {
                  showDialog({
                    tone: "error",
                    title: "Access denied",
                    message: "You don't have permission to access reports.",
                  });
                  return;
                }

                navigation.navigate("Reports");
              }}
            >
              <MaterialIcons name="bar-chart" size={20} color="#111827" style={{ marginRight: 10 }} />
              <Text style={styles.homeMenuItemText}>Reports</Text>
            </Pressable>

            {/* 6) Devices */}
            <Pressable
              style={styles.homeMenuItem}
              onPress={async () => {
                setHomeMenuVisible(false);
                try {
                  await refreshAuth();
                } catch { }

                const canAccessDevices =
                  hasPermission("pos.devices.manage") ||
                  hasPermission("ACCESS_DEVICES_MANAGEMENT");

                if (!canAccessDevices) {
                  showDialog({
                    tone: "error",
                    title: "Access denied",
                    message: "You don't have permission to access device management.",
                  });
                  return;
                }

                navigation.navigate("Devices");
              }}
            >
              <MaterialIcons
                name="devices"
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
              <Text style={styles.homeMenuItemText}>Devices</Text>
            </Pressable>

            {/* 7) EXIT — RED */}
            <Pressable
              style={styles.homeMenuItem}
              onPress={() => {
                setHomeMenuVisible(false);
                navigation.navigate("ClockIn");
              }}
            >
              <MaterialIcons
                name="logout"
                size={20}
                color="#DC2626"
                style={{ marginRight: 10 }}
              />

              <Text style={[styles.homeMenuItemText, { color: "#DC2626", fontWeight: "600" }]}>
                Exit
              </Text>
            </Pressable>
          </View>


        </View>
      </Modal>
      {/* 1) Confirm Close Till */}
      <Modal
        visible={confirmCloseVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmCloseVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.tillModalCard}>
            <Text style={styles.tillModalTitle}>Close Till</Text>
            <Text style={styles.tillModalMsg}>Are you sure you want to close till?</Text>

            <View style={styles.tillModalRow}>
              <Pressable
                style={[styles.tillBtn, styles.tillBtnSecondary]}
                onPress={() => setConfirmCloseVisible(false)}
              >
                <Text style={styles.tillBtnTextSecondary}>No</Text>
              </Pressable>

              <Pressable
                style={[styles.tillBtn, styles.tillBtnPrimary]}
                onPress={() => {
                  setConfirmCloseVisible(false);
                  setTillCloseAmount("");
                  setCloseAmountVisible(true);
                }}
              >
                <Text style={styles.tillBtnTextPrimary}>Yes</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 2) Enter Till Amount */}
      <Modal
        visible={closeAmountVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCloseAmountVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.tillAmountCard}>
            <Text style={styles.tillModalTitle}>Enter Till Amount</Text>

            <View style={styles.tillAmountDisplay}>
              <Text style={styles.tillAmountText}>{tillCloseAmount || "0.00"}</Text>
            </View>

            {[
              ["1", "2", "3"],
              ["4", "5", "6"],
              ["7", "8", "9"],
              ["C", "0"],
            ].map((row, idx) => (
              <View key={idx} style={styles.tillKeypadRow}>
                {row.map((k) => (
                  <Pressable
                    key={k}
                    style={styles.tillKeypadKey}
                    onPress={() => handleKeypadPress(k)}
                  >
                    <Text style={styles.tillKeypadKeyText}>{k}</Text>
                  </Pressable>
                ))}
              </View>
            ))}

            <Pressable
              style={styles.tillDoneBtn}
              onPress={() => {
                if (!tillCloseAmount) return showDialog({
                  tone: "info",
                  title: "Enter till amount",
                  message: "Please enter the till amount.",
                });
                const val = Number(tillCloseAmount);
                if (Number.isNaN(val)) return showDialog({
                  tone: "error",
                  title: "Invalid amount",
                  message: "Please enter a valid amount.",
                });
                setCloseAmountVisible(false);
                actuallyCloseTill(val);
              }}
            >
              <Text style={styles.tillDoneText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* 3) Print prompt */}
      <Modal
        visible={printPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPrintPromptVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.tillModalCard}>
            <Text style={styles.tillModalTitle}>Till Closed Successfully!</Text>
            <Text style={styles.tillModalMsg}>
              Would you like to print the till report?
            </Text>

            <View style={styles.tillModalRow}>
              <Pressable
                style={[styles.tillBtn, styles.tillBtnPrimary]}
                onPress={() => handlePrintTillReport(true)}
              >
                <Text style={styles.tillBtnTextPrimary}>Yes</Text>
              </Pressable>

              <Pressable
                style={[styles.tillBtn, styles.tillBtnSecondary]}
                onPress={() => handlePrintTillReport(false)}
              >
                <Text style={styles.tillBtnTextSecondary}>No</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={syncProgressVisible} transparent animationType="fade">
        <View style={styles.syncOverlay}>
          <View style={styles.syncCard}>
            <View style={styles.syncHeaderRow}>
              <Text style={styles.syncTitle}>Syncing…</Text>
              <Text style={styles.syncStepText}>{syncStep}/5</Text>
            </View>

            <View style={{ marginTop: 10 }}>
              <ActivityIndicator size="large" />
              <Text style={styles.syncStatus}>{syncStatusText}</Text>
            </View>

            <View style={styles.syncHintBox}>
              <Text style={styles.syncHint}>
                Please don’t close the app while syncing.
              </Text>
            </View>
          </View>
        </View>
      </Modal>
      <ModernDialog
        visible={dlg.visible}
        tone={dlg.tone}
        title={dlg.title}
        message={dlg.message}
        primaryText={dlg.primaryText}
        secondaryText={dlg.secondaryText}
        onPrimary={() => {
          const fn = dlg.onPrimary;
          hideDialog();
          fn?.();
        }}
        onSecondary={() => {
          const fn = dlg.onSecondary;
          hideDialog();
          fn?.();
        }}
        onClose={hideDialog}
      />


    </SafeAreaView>
  );
}

/* ------------------------ STYLES ------------------------ */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f3f4f6" },

  topBar: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  topSub: { fontSize: 12, color: "#6b7280" },

  mainRow: { flex: 1, flexDirection: "row" },

  orderPanel: {
    width: "30%",
    backgroundColor: "#ffffff",
    borderRightWidth: 1,
    borderRightColor: "#e5e7eb",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  orderHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  customerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#111827",
  },
  customerButtonText: { fontSize: 12, fontWeight: "600", color: "#111827" },
  orderTypeTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#111827",
  },
  orderTypeText: { fontSize: 12, fontWeight: "600", color: "#111827" },

  orderTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8, color: "#111827" },
  orderList: { flex: 1 },
  orderEmpty: { fontSize: 12, color: "#9ca3af" },

  orderRowFull: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  orderLineTop: { flexDirection: "row", alignItems: "center" },
  orderItemName: { fontSize: 13, fontWeight: "600", color: "#111827", flex: 1 },
  orderItemSize: {
    fontSize: 12,
    color: "#6b7280",
    marginHorizontal: 8,
    minWidth: 50,
    textAlign: "right",
  },
  orderItemPriceRight: {
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
    minWidth: 50,
    textAlign: "right",
  },
  orderItemModifiers: { fontSize: 11, color: "#6b7280", marginTop: 2 },

  qtyBox: {
    flexDirection: "row",
    marginLeft: 8,
    borderRadius: 999,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  qtyTapLeft: {
    paddingHorizontal: 8,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f9fafb",
  },
  qtyTapRight: {
    paddingHorizontal: 8,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f9fafb",
  },
  qtyMid: { paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  qtyText: { fontSize: 14, fontWeight: "700", color: "#111827" },
  qtyValue: { fontSize: 13, fontWeight: "600", color: "#111827" },

  orderFooter: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    flexDirection: "row",
    alignItems: "center",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 2,
    alignItems: "center",
  },
  summaryLabel: { fontSize: 12, color: "#6b7280" },
  summaryValue: { fontSize: 12, fontWeight: "600", color: "#111827" },

  discountInputWrap: { width: 80, height: 28, justifyContent: "center", alignItems: "flex-end" },
  discountInput: {
    borderWidth: 0,
    backgroundColor: "transparent",
    height: 35,
    paddingHorizontal: 4,
    textAlign: "right",
    color: "#000",
    fontSize: 11,
    fontWeight: "500",
  },

  paymentsSummaryBox: { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: "#e5e7eb" },
  paymentSummaryRow: { flexDirection: "row", justifyContent: "space-between" },
  paymentSummaryLabel: { fontSize: 11, color: "#6b7280" },
  paymentSummaryValue: { fontSize: 11, fontWeight: "600", color: "#111827" },
  paymentSummaryTotalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  paymentSummaryTotalLabel: { fontSize: 11, color: "#111827", fontWeight: "700" },
  paymentSummaryTotalValue: { fontSize: 11, color: "#111827", fontWeight: "700" },

  totalButton: {
    marginLeft: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: BLACK,
    alignItems: "center",
  },
  totalButtonLabel: { fontSize: 11, color: "#ffffff", fontWeight: "600" },
  totalButtonValue: { fontSize: 14, color: "#ffffff", fontWeight: "700" },

  rightPanel: { flex: 1, paddingHorizontal: 20, paddingVertical: 14 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 },
  actionButton: {
    height: 44,
    minWidth: 80,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: BLACK,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
    marginBottom: 8,
  },
  actionText: { color: "#ffffff", fontSize: 11, fontWeight: "600" },

  searchBox: {
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#ffffff",
    paddingHorizontal: 12,
    justifyContent: "center",
    marginBottom: 12,
  },
  searchInput: { fontSize: 13, color: "#111827" },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  grid: { paddingBottom: 24, flexDirection: "row", flexWrap: "wrap" },
  categoryTile: {
    width: "22%",
    height: 140,
    marginRight: 12,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    overflow: "hidden",
  },

  categoryImageWrap: {
    height: 90,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    padding: 8,
  },

  categoryImage: {
    width: "100%",
    height: "100%",
    resizeMode: "contain",
  },

  categoryPlaceholder: {
    width: "70%",
    height: "70%",
    backgroundColor: "#f3f4f6",
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },

  categoryPlaceholderText: {
    color: "#6b7280",
    fontSize: 12,
    fontWeight: "600",
  },

  categoryName: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
    color: "#111827",
  },

  paymentFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  remainingLabel: { fontSize: 12, color: "#6b7280", marginRight: 8 },
  remainingValue: { fontSize: 14, fontWeight: "700", color: "#111827", marginRight: 12 },
  changeLabel: { fontSize: 12, color: "#6b7280", marginRight: 8 },
  changeValue: { fontSize: 14, fontWeight: "700", color: "#16a34a", marginRight: 12 },
  clearPaymentsText: { fontSize: 11, color: "#b91c1c", fontWeight: "600" },
  payButton: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: "#16a34a" },
  payButtonDisabled: { backgroundColor: "#9ca3af" },
  payButtonText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },

  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  bottomItem: { flexDirection: "row", alignItems: "center" },
  bottomIcon: { fontSize: 18, marginRight: 6 },
  bottomLabel: { fontSize: 12, fontWeight: "600", color: "#111827" },
  bottomBadge: {
    backgroundColor: "red",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 6,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomBadgeText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4, color: "#111827" },
  modalClose: {
    marginTop: 12,
    alignSelf: "flex-end",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#111827",
  },
  modalCloseText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },

  orderTypeCard: {
    width: 320,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  orderTypeRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
  },
  orderTypeRowText: { fontSize: 15, color: "#111827" },
  orderTypeTitle: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    color: "#111827",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },

  paymentCard: { width: "30%", maxHeight: "80%", backgroundColor: "#ffffff", borderRadius: 14, padding: 16 },
  paymentMethodRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  paymentMethodText: { fontSize: 14, color: "#111827" },

  amountCard: { width: "30%", maxHeight: "80%", backgroundColor: "#ffffff", borderRadius: 14, padding: 16 },
  amountHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 },
  amountRemainingText: { fontSize: 12, color: "#6b7280" },
  amountRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  amountText: { fontSize: 12, fontWeight: "700", color: "#111827" },
  amountCancelRow: { marginTop: 10, paddingVertical: 10 },
  amountCancelText: { fontSize: 14, fontWeight: "600", color: "#b91c1c", textAlign: "center" },

  customAmountBox: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#e5e7eb" },
  customLabel: { fontSize: 12, color: "#6b7280", marginBottom: 4 },
  customInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    color: "#111827",
    marginBottom: 8,
  },
  customApplyButton: { alignSelf: "flex-end", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: BLACK },
  customApplyText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },

  customerCard: { width: "35%", maxHeight: "85%", backgroundColor: "#ffffff", borderRadius: 14, padding: 16 },
  customerSearchRow: { flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 8 },
  customerSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: "#111827",
    marginRight: 8,
  },
  customerSearchButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: BLACK },
  customerSearchButtonText: { color: "#ffffff", fontSize: 12, fontWeight: "600" },
  customerLoadingBox: { paddingVertical: 16, alignItems: "center" },
  customerRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#f3f4f6" },
  customerName: { fontSize: 14, fontWeight: "600", color: "#111827" },
  customerPhone: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  customerEmptyText: { fontSize: 12, color: "#6b7280", marginTop: 8 },
  customerNewBox: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#e5e7eb" },
  customerNewTitle: { fontSize: 13, fontWeight: "600", color: "#111827", marginBottom: 4 },
  customerInput: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: "#111827",
    marginBottom: 6,
  },
  customerSaveButton: { alignSelf: "flex-end", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: BLACK },
  customerSaveText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
  removeDiscountText: { marginTop: 4, fontSize: 12, color: "#b91c1c", textAlign: "right" },


  tierBackdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  tierCard: {
    width: "34%",
    minWidth: 340,
    maxWidth: 460,
    maxHeight: "78%",
    backgroundColor: "#fff",
    borderRadius: 18,
    overflow: "hidden"
  },
  tierHeader: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#EEF2F7",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tierTitleWrap: { flex: 1, paddingRight: 10 },
  tierTitle: { fontSize: 16, fontWeight: "800", color: "#111827" },
  tierSub: { marginTop: 4, fontSize: 12, color: "#6B7280" },
  tierCloseBtn: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: "#F3F4F6",
    alignItems: "center",
    justifyContent: "center",
  },
  tierCloseText: { fontSize: 12, fontWeight: "700", color: "#111827" },
  tierList: { paddingVertical: 10 },
  tierRow: {
    marginHorizontal: 12,
    marginVertical: 6,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#EEF2F7",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tierRowPressed: { opacity: 0.9, transform: [{ scale: 0.995 }] },
  tierRowLeft: { flex: 1, paddingRight: 10 },
  tierRowText: { fontSize: 14, color: "#111827", fontWeight: "800" },
  tierRowCode: { marginTop: 2, fontSize: 12, color: "#6B7280" },
  tierRowSelected: {
    borderColor: "#111827",
    backgroundColor: "#F9FAFB",
  },
  tierCheck: {
    height: 26,
    minWidth: 26,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  tierCheckText: { color: "#fff", fontSize: 12, fontWeight: "900" },
  tierFooter: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: "#EEF2F7",
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    gap: 10,
  },
  tierBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tierBtnGhost: {
    backgroundColor: "#F3F4F6",
  },
  tierBtnPrimary: {
    backgroundColor: "#111827",
  },
  tierBtnText: { fontSize: 13, fontWeight: "900" },
  tierBtnTextGhost: { color: "#111827" },
  tierBtnTextPrimary: { color: "#fff" },

  // Loading line (optional)
  tierLoadingText: { marginHorizontal: 16, marginTop: 10, fontSize: 12, color: "#6B7280" },

  homeMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  homeMenuCard: {
    position: 'absolute',
    left: 25,
    bottom: 10,
    width: 300,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  homeMenuItem: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  homeMenuItemText: {
    fontSize: 14,
    color: '#111827',
  },
  homeMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },

  homeMenuItemText: {
    fontSize: 15,
    color: "#111827",
  },
  tillModalCard: {
    width: 360,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
  },
  tillModalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 8, color: "#111827" },
  tillModalMsg: { fontSize: 14, color: "#4b5563", textAlign: "center", marginBottom: 16 },

  tillModalRow: { flexDirection: "row", width: "100%" },
  tillBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center", marginHorizontal: 6 },
  tillBtnPrimary: { backgroundColor: "#000" },
  tillBtnSecondary: { backgroundColor: "#e5e7eb" },
  tillBtnTextPrimary: { color: "#fff", fontWeight: "700" },
  tillBtnTextSecondary: { color: "#111827", fontWeight: "700" },

  tillAmountCard: {
    width: 360,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
  },
  tillAmountDisplay: {
    width: "100%",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    marginBottom: 12,
  },
  tillAmountText: { fontSize: 22, fontWeight: "800", color: "#111827" },
  tillKeypadRow: { flexDirection: "row", width: "100%", marginBottom: 8 },
  tillKeypadKey: {
    flex: 1,
    marginHorizontal: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#e5e7eb",
    alignItems: "center",
  },
  tillKeypadKeyText: { fontSize: 18, fontWeight: "800", color: "#111827" },
  tillDoneBtn: { marginTop: 10, paddingVertical: 10, paddingHorizontal: 18 },
  tillDoneText: { fontSize: 18, fontWeight: "800", color: "#000" },
  syncOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  syncCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 6,
  },
  syncHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  syncTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#111827",
  },
  syncStepText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6b7280",
  },
  syncStatus: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 14,
    fontWeight: "700",
    color: "#111827",
  },
  syncHintBox: {
    marginTop: 14,
    backgroundColor: "#f3f4f6",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  syncHint: {
    textAlign: "center",
    color: "#374151",
    fontSize: 12,
    fontWeight: "600",
  },
});
