// src/screens/ProductsScreen.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  StyleSheet,
  SafeAreaView,
  TextInput,
  Image,
  Alert,
} from 'react-native';
import { get, post } from '../lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from '../database/db'; // SQLite + sync
import { syncMenu } from '../sync/menuSync';
import {
  saveOrdersToSQLite as saveOrdersLocal,
  LocalOrder,
} from '../database/ordersLocal';
import { getTierPricingForIds } from '../services/tierPricing';
import { usePriceTierStore, type PriceTier } from '../store/priceTierStore';
import { useOrderTypeStore } from "../store/orderTypeStore";
import { MaterialIcons } from "@expo/vector-icons";
import { printReceiptForOrder, printKitchenTicket } from "../printing/printerService";

type ProductSize = {
  id: string;
  name: string;
  price: number | string | null;
};

type Product = {
  id: string;
  name: string;
  basePrice?: number | string | null;
  imageUrl?: string;
  sizes?: ProductSize[];
  isActive?: boolean;
  categoryId?: string | null;
};

type CartModifier = {
  groupId: string;
  groupName: string;
  itemId: string;
  itemName: string;
  price: number;
  originalPrice?: number;
};

type CartItem = {
  productId: string;
  productName: string;
  sizeId: string | null;
  sizeName: string | null;
  price: number;
  originalPrice?: number;
  qty: number;
  modifiers?: CartModifier[];
  readonly?: boolean;
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

type AppliedDiscount = {
  kind: 'AMOUNT' | 'PERCENT';
  value: number;
  source: 'MANUAL' | 'PREDEFINED';
  name?: string;
  id?: string;
  scope?: 'ORDER' | 'ITEM';
};

const BLACK = '#000000';
const DISCOUNT_STORAGE_KEY = 'pos_applied_discount';
const TIER_STORAGE_KEY = 'pos_price_tier';

/* ------------------------ SHARED HELPERS ------------------------ */
const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || 'http://192.168.100.245:4000';

function normalizeImageUrl(url?: string | null) {
  if (!url) return null;

  const u = String(url).trim();
  if (!u) return null;

  if (u.startsWith('http://') || u.startsWith('https://')) {
    return u;
  }

  const base = API_BASE.replace(/\/+$/, '');
  const path = u.startsWith('/') ? u : `/${u}`;
  return `${base}${path}`;
}

function toMoney(value: any): string {
  const n =
    typeof value === 'number'
      ? value
      : parseFloat(value != null ? String(value) : '0');
  if (Number.isNaN(n)) return '0.00';
  return n.toFixed(2);
}

function normalizePrice(raw: any): number {
  if (typeof raw === 'number') return raw;
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
    console.log("LOAD PRICE TIERS CACHE ERR (ProductsScreen)", e);
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
    console.log("SAVE PRICE TIERS CACHE ERR (ProductsScreen)", e);
  }
}

// ⚠️ assumes you have getDeviceInfo() in this file OR you can import it.
// If it lives in CategoryScreen only, move that helper to a shared util and use it here too.
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
    console.log("getDeviceInfo parse error (ProductsScreen)", e);
    return { branchId: null, brandId: null, deviceId: null };
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

    console.log("📦 PRICE TIERS API (ProductsScreen):", arr);

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
    console.log("REFRESH PRICE TIERS ERR (ProductsScreen)", e);
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

function normalizeOrderTypeLabel(
  label: string | null | undefined,
): string | null {
  if (!label) return null;
  const raw = String(label).trim().toLowerCase().replace(/\s+/g, ' ');
  if (raw.includes('dine')) return 'DINE_IN';
  if (raw.includes('pick') || raw.includes('take')) return 'TAKE_AWAY';
  if (raw.includes('drive')) return 'DRIVE_THRU';
  if (raw.includes('deliver')) return 'DELIVERY';
  if (raw === 'b2b' || raw.includes('corporate')) return 'B2B';
  const fallback = String(label).trim().toUpperCase().replace(/\s+/g, '_');
  if (fallback === 'PICK_UP') return 'TAKE_AWAY';
  return fallback;
}
/* ------------------------ Till Till session ------------------------ */
async function handleOpenOrCloseTill() {
  try {
    if (!tillOpen) {
      // OPEN TILL
      const res: any = await post("/pos/till/open", { openingCash: 0 }); // or show a modal to enter amount

      await AsyncStorage.multiSet([
        ["pos_till_opened", "1"],
        ["pos_till_session_id", String(res?.tillSessionId || "")],
      ]);

      setTillOpen(true);
      Alert.alert("Till opened", "Till opened successfully.");
    } else {
      // CLOSE TILL
      const tillId = await AsyncStorage.getItem("pos_till_session_id");
      const res: any = await post("/pos/till/close", {
        tillSessionId: tillId || undefined,
        closingCash: 0, // later you can ask the cashier
      });

      await AsyncStorage.multiSet([
        ["pos_till_opened", "0"],
        ["pos_till_session_id", ""],
      ]);

      setTillOpen(false);
      Alert.alert("Till closed", "Till closed successfully.");
    }
  } catch (e: any) {
    console.log("handleOpenOrCloseTill error", e);
    Alert.alert("Error", e?.message || "Till operation failed.");
  } finally {
    setHomeMenuVisible(false);
  }
}



/* ------------------------ Tier pricing helpers (shared across screens) ------------------------ */
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
  modifierItemsMap: Record<string, number>,
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

/* ------------------------ LocalOrder helper (for SQLite cache) ------------------------ */
function toLocalOrder(o: any): LocalOrder {
  let businessDate: string | null = null;
  if (o.businessDate) {
    businessDate = o.businessDate;
  } else if (o.createdAt) {
    const d = new Date(o.createdAt);
    if (!isNaN(d.getTime())) {
      businessDate = d.toISOString().slice(0, 10);
    }
  }

  return {
    id: o.id,
    orderNo: o.orderNo ?? '',
    branchId: o.branchId ?? '',
    businessDate: businessDate ?? '',
    status: o.status ?? '',
    channel: o.channel ?? null,
    netTotal: Number(o.netTotal ?? 0),
  };
}

/* ------------------------ SQLITE HELPERS ------------------------ */
async function loadProductsFromSQLite(
  categoryId?: string | null,
): Promise<Product[]> {
  const db = await getDb();
  let baseProducts: any[] = [];

  if (categoryId) {
    baseProducts = await db.getAllAsync<any>(
      `
      SELECT
        id,
        name,
        price AS basePrice,
        imageUrl,
        isActive,
        categoryId
      FROM products
      WHERE categoryId = ? AND isActive = 1
      ORDER BY name ASC
      `,
      categoryId,
    );
  } else {
    baseProducts = await db.getAllAsync<any>(
      `
      SELECT
        id,
        name,
        price AS basePrice,
        imageUrl,
        isActive,
        categoryId
      FROM products
      WHERE isActive = 1
      ORDER BY name ASC
      `,
    );
  }

  if (!baseProducts.length) return [];

  const productIds = baseProducts.map((p: any) => p.id);
  if (!productIds.length) return [];

  const placeholders = productIds.map(() => '?').join(',');
  const sizeRows = await db.getAllAsync<any>(
    `
    SELECT id, productId, name, price
    FROM product_sizes
    WHERE productId IN (${placeholders})
    `,
    ...productIds,
  );

  const sizesByProduct: Record<string, ProductSize[]> = {};
  (sizeRows || []).forEach((s) => {
    if (!sizesByProduct[s.productId]) {
      sizesByProduct[s.productId] = [];
    }
    sizesByProduct[s.productId].push({
      id: s.id,
      name: s.name,
      price: s.price,
    });
  });

  const mapped: Product[] = baseProducts.map((p: any) => ({
    id: p.id,
    name: p.name,
    basePrice: p.basePrice,
    imageUrl: p.imageUrl || undefined,
    isActive: p.isActive === 1 || p.isActive === true,
    sizes: sizesByProduct[p.id] || [],
    categoryId: p.categoryId ?? null,
  }));

  return mapped;
}

/* Small helper: best-effort brandId from state / storage */
async function getEffectiveBrandId(current: string | null): Promise<string | null> {
  if (current) return current;
  try {
    const rawDev = await AsyncStorage.getItem('deviceInfo');
    if (!rawDev) return null;
    const d = JSON.parse(rawDev);
    const bid = d?.brandId ?? d?.brand?.id ?? null;
    return bid ? String(bid) : null;
  } catch (e) {
    console.log('getEffectiveBrandId error (ProductsScreen)', e);
    return null;
  }
}

/* ------------------------ COMPONENT ------------------------ */
export default function ProductsScreen({
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

  const isOnline = online ?? true;

  const { categoryId, branchName, userName, goBack, reopenFromCallcenter } =
    route.params || {};

  const readOnlyCart: boolean = !!reopenFromCallcenter;

  const [brandName, setBrandName] = useState<string | null>(null);
  const [brandCode, setBrandCode] = useState<string | null>(null);

  // ✅ REQUIRED FOR ORDERS (Prisma requires brandId + deviceId)
  const [brandId, setBrandId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const [products, setProducts] = useState<Product[]>([]);
  const [filtered, setFiltered] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sizeModalVisible, setSizeModalVisible] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const orderType = useOrderTypeStore((s) => s.orderType);
  const setOrderType = useOrderTypeStore((s) => s.setOrderType);
  const [orderTypeModalVisible, setOrderTypeModalVisible] = useState(false);

  // Payment
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [vatRate, setVatRate] = useState<number>(15);
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paying, setPaying] = useState(false);
  const [voidLoading, setVoidLoading] = useState(false);

  const [selectedPaymentMethodId, setSelectedPaymentMethodId] =
    useState<string | null>(null);
  const [showCustomAmount, setShowCustomAmount] = useState(false);
  const [customAmountInput, setCustomAmountInput] = useState('');

  // Orders badge
  const [ordersBadge, setOrdersBadge] = useState(0);

  // Discounts
  const [discountConfigs, setDiscountConfigs] = useState<DiscountConfig[]>([]);
  const [appliedDiscount, setAppliedDiscount] =
    useState<AppliedDiscount | null>(null);
  const [discountModeModalVisible, setDiscountModeModalVisible] =
    useState(false);
  const [discountInputModalVisible, setDiscountInputModalVisible] =
    useState(false);
  const [discountPresetModalVisible, setDiscountPresetModalVisible] =
    useState(false);
  const [discountInputMode, setDiscountInputMode] = useState<
    'AMOUNT' | 'PERCENT' | null
  >(null);
  const [discountInputValue, setDiscountInputValue] = useState('');

  // Branch
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | null>(null);

  // Customers
  const [customerModalVisible, setCustomerModalVisible] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerList, setCustomerList] = useState<CustomerSummary[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerSummary | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Permissions
  const [userPermissions, setUserPermissions] = useState<string[]>([]);

  // Price Tiers (shared with CategoryScreen via Zustand)
  const [tierModalVisible, setTierModalVisible] = useState(false);
  const [tierLoading, setTierLoading] = useState(false);
  const [tiers, setTiers] = useState<PriceTier[]>([]);

  const activeTier = usePriceTierStore((s) => s.activeTier);
  const setActiveTier = usePriceTierStore((s) => s.setActiveTier);
  const hydrateTier = usePriceTierStore((s) => s.hydrate);
  //for Home sub-menu
  const [homeMenuVisible, setHomeMenuVisible] = useState(false);
  // Handy alias for cart
  const cartItems: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];

  // ✅ Hydrate shared tier store (so tier from CategoryScreen is visible here)
  useEffect(() => {
    hydrateTier().catch(() => { });
  }, [hydrateTier]);

  useEffect(() => {
    async function apply() {
      const items: CartItem[] = Array.isArray(cart) ? cart : [];
      if (!items.length) return;

      // If no active tier → restore original prices
      if (!activeTier) {
        const restored = clearTierFromCartLocal(items);
        // avoid useless setCart if nothing changed
        const changed =
          restored.length !== items.length ||
          restored.some((n, i) => n.price !== items[i].price);
        if (changed) setCart(restored);
        return;
      }

      // Collect ids from current cart
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

      // 🔁 prevent infinite loop: only set when prices really changed
      const changed =
        next.length !== items.length ||
        next.some((n, i) => n.price !== items[i].price);

      if (changed) {
        setCart(next);
      }
    }

    apply();
  }, [activeTier, cart]);

  /* ------------------------ LOAD DEVICE INFO (brandId/deviceId/branchId) ------------------------ */

  useEffect(() => {
    (async () => {
      try {
        const rawDev = await AsyncStorage.getItem('deviceInfo');
        if (!rawDev) return;

        const d = JSON.parse(rawDev);

        const devId = String(d?.deviceId ?? d?.id ?? '').trim();
        const bId = String(d?.brandId ?? d?.brand?.id ?? '').trim();
        const brId = String(d?.branchId ?? d?.branch?.id ?? '').trim();

        if (devId) setDeviceId(devId);
        if (bId) setBrandId(bId);
        if (brId) setBranchId(brId);
      } catch (e) {
        console.log('deviceInfo load error (ProductsScreen)', e);
      }
    })();
  }, []);

  /* ------------------------ BRAND (optional top bar display) ------------------------ */
  useEffect(() => {
    (async () => {
      try {
        const rawBrand = await AsyncStorage.getItem('pos_brand');
        if (rawBrand) {
          const b = JSON.parse(rawBrand);
          setBrandName(b?.name ?? null);
          setBrandCode(b?.code ?? null);

          if (b?.id) setBrandId(String(b.id));
          return;
        }

        const rawDev = await AsyncStorage.getItem('deviceInfo');
        if (rawDev) {
          const d = JSON.parse(rawDev);
          setBrandName(d?.brandName ?? d?.brand?.name ?? null);
          setBrandCode(d?.brandCode ?? d?.brand?.code ?? null);

          if (d?.brandId) setBrandId(String(d.brandId));
          else if (d?.brand?.id) setBrandId(String(d.brand.id));
        }
      } catch (e) {
        console.log('brand load error', e);
      }
    })();
  }, []);

  // 🔁 Restore applied discount when ProductsScreen mounts
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DISCOUNT_STORAGE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed.kind === 'AMOUNT' || parsed.kind === 'PERCENT') &&
          typeof parsed.value === 'number'
        ) {
          setAppliedDiscount(parsed as AppliedDiscount);
        }
      } catch (e) {
        console.log('LOAD DISCOUNT ERR (ProductsScreen)', e);
      }
    })();
  }, []);

  // 🔁 Restore active price tier (if store didn't already)
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(TIER_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) {
          setActiveTier(parsed);
        }
      } catch (e) {
        console.log('LOAD TIER ERR (ProductsScreen)', e);
      }
    })();
  }, [setActiveTier]);

  // 💾 Keep discount persisted while navigating between screens
  useEffect(() => {
    (async () => {
      try {
        if (appliedDiscount) {
          await AsyncStorage.setItem(
            DISCOUNT_STORAGE_KEY,
            JSON.stringify(appliedDiscount),
          );
        } else {
          await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
        }
      } catch (e) {
        console.log('SAVE DISCOUNT ERR (ProductsScreen)', e);
      }
    })();
  }, [appliedDiscount]);

  // 💾 Keep tier persisted (so both screens share same tier)
  useEffect(() => {
    (async () => {
      try {
        if (activeTier) {
          await AsyncStorage.setItem(TIER_STORAGE_KEY, JSON.stringify(activeTier));
        } else {
          await AsyncStorage.removeItem(TIER_STORAGE_KEY);
        }
      } catch (e) {
        console.log('SAVE TIER ERR (ProductsScreen)', e);
      }
    })();
  }, [activeTier]);

  /* ------------------------ POS USER PERMISSIONS ------------------------ */
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('pos_user');
        if (!raw) {
          setUserPermissions([]);
          return;
        }
        const u = JSON.parse(raw);
        const perms: string[] = Array.isArray(u?.permissions)
          ? u.permissions
          : [];
        setUserPermissions(perms);
      } catch (e) {
        console.log('pos_user permissions load error', e);
        setUserPermissions([]);
      }
    })();
  }, []);

  const hasPermission = (code: string) =>
    Array.isArray(userPermissions) && userPermissions.includes(code);

  const canUseOpenDiscount =
    hasPermission('pos.discounts.open.apply') ||
    hasPermission('pos.discount.open.apply') ||
    hasPermission('APPLY_OPEN_DISCOUNTS');

  const canUsePredefinedDiscount =
    hasPermission('pos.discounts.predefined.apply') ||
    hasPermission('pos.discount.predefined.apply') ||
    hasPermission('APPLY_PREDEFINED_DISCOUNTS');

  const canUseAnyDiscount = canUseOpenDiscount || canUsePredefinedDiscount;

  /* ------------------------ LOAD PRODUCTS ------------------------ */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        let prods: Product[] = [];
        try {
          prods = await loadProductsFromSQLite(categoryId);
        } catch (e) {
          console.log('PRODUCTS (SQLite) ERR', e);
        }

        if (!cancelled) {
          setProducts(prods || []);
          setFiltered(prods || []);
          setLoading(false);
        }

        if (!online) {
          return;
        }

        try {
          await syncMenu();
          if (cancelled) return;

          let fresh = await loadProductsFromSQLite(categoryId);

          if (!fresh || fresh.length === 0) {
            try {
              const apiAll = await get('/menu/products');
              const apiArray = Array.isArray(apiAll) ? apiAll : [];

              fresh = apiArray
                .filter((p: any) => {
                  const active = p.isActive !== false;
                  if (!active) return false;
                  if (categoryId) return p.categoryId === categoryId;
                  return true;
                })
                .map((p: any) => ({
                  id: p.id,
                  name: p.name,
                  basePrice: p.basePrice ?? p.price ?? null,
                  imageUrl: p.imageUrl || undefined,
                  isActive: p.isActive !== false,
                  sizes:
                    Array.isArray(p.sizes) && p.sizes.length > 0
                      ? p.sizes.map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        price: s.price,
                      }))
                      : [],
                  categoryId: p.categoryId ?? null,
                }));
            } catch (err) {
              console.log('PRODUCTS API fallback error:', err);
            }
          }

          if (!cancelled) {
            setProducts(fresh || []);
            setFiltered(fresh || []);
          }
        } catch (err) {
          console.log('syncMenu error (ProductsScreen):', err);
        }
      } catch (e: any) {
        console.log('PRODUCTS load ERR (ProductsScreen)', e);
        if (!cancelled) {
          setError('Failed to load products');
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [categoryId, online]);

  /* ------------------------ AUTO SYNC (MENU) ------------------------ */
  useEffect(() => {
    if (!online) return;

    const intervalMs = 30 * 60 * 1000;
    let cancelled = false;

    const id = setInterval(async () => {
      try {
        await syncMenu();
        if (cancelled) return;
        const fresh = await loadProductsFromSQLite(categoryId);
        if (!cancelled) {
          setProducts(fresh || []);
          setFiltered(fresh || []);
        }
      } catch (e) {
        console.log('AUTO syncMenu ERR (ProductsScreen)', e);
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [online, categoryId]);

    /* ------------------------ POS CONFIG (VAT, payments, discounts) ------------------------ */
useEffect(() => {
  let mounted = true;

  async function loadConfig() {
    try {
      const cfg: any = await get("/pos/config");
      console.log("📦 POS CONFIG (ProductsScreen):", cfg);
      if (!mounted) return;

      // VAT
      const vat = cfg?.vatRate;
      if (typeof vat === "number") {
        setVatRate(vat);
      }

      // PAYMENT METHODS  ➜ same behaviour as CategoryScreen
      const methods = cfg?.paymentMethods;
      if (Array.isArray(methods)) {
        setPaymentMethods(
          methods.map((m: any) => ({
            id: String(m.id),
            code: m.code ?? null,
            name: String(m.name),
          }))
        );
      }

      // DISCOUNTS (keep your existing mapping logic)
      const rawDiscounts = cfg?.discounts;

      if (Array.isArray(rawDiscounts)) {
        const mapped: DiscountConfig[] = rawDiscounts.map((d: any) => {
          const modeRaw = String(d.mode || d.type || "AMOUNT").toUpperCase();
          const mode: "AMOUNT" | "PERCENT" = modeRaw.includes("PERCENT")
            ? "PERCENT"
            : "AMOUNT";

          const scopeRaw = d.scope || d.applyTo || "ORDER";
          const scope: "ORDER" | "ITEM" =
            String(scopeRaw).toUpperCase() === "ITEM" ? "ITEM" : "ORDER";

          const value = Number(d.value ?? d.amount ?? 0) || 0;

          const branchIds: string[] = Array.isArray(d.branchIds)
            ? d.branchIds.map((x: any) => String(x))
            : [];

          const categoryIds: string[] = Array.isArray(d.categoryIds)
            ? d.categoryIds.map((x: any) => String(x))
            : [];

          const productIds: string[] = Array.isArray(d.productIds)
            ? d.productIds.map((x: any) => String(x))
            : [];

          const productSizeIds: string[] = Array.isArray(d.productSizeIds)
            ? d.productSizeIds.map((x: any) => String(x))
            : [];

          const orderTypesRaw: string[] =
            typeof d.orderTypes === "string"
              ? d.orderTypes
                  .split(",")
                  .map((s: any) => String(s).trim())
                  .filter(Boolean)
              : Array.isArray(d.orderTypes)
              ? d.orderTypes.map((x: any) => String(x))
              : [];

          const orderTypes: string[] = orderTypesRaw
            .map((x) => normalizeOrderTypeLabel(x))
            .filter((x): x is string => !!x);

          const applyAllBranches = !!d.applyAllBranches;

          return {
            id: String(d.id),
            name: String(d.name || d.code || "Discount"),
            mode,
            value,
            scope,
            branchIds,
            categoryIds,
            productIds,
            productSizeIds,
            orderTypes,
            applyAllBranches,
          };
        });

        setDiscountConfigs(mapped);
      } else {
        setDiscountConfigs([]);
      }
    } catch (err) {
      console.log("POS CONFIG ERR (ProductsScreen):", err);
    }
  }

  loadConfig();
  return () => {
    mounted = false;
  };
}, []);

  
  /* ------------------------ SYNC PriceTier ------------------------ */
  useEffect(() => {
    let mounted = true;

    (async () => {
      // 1) local cache first
      const cached = await loadCachedPriceTiers();
      if (mounted && cached.length) {
        console.log("📥 PRICE TIERS from cache (ProductsScreen):", cached.length);
        setTiers(cached);
      }

      // 2) if online, refresh from API
      if (!online) return;

      try {
        setTierLoading(true);
        const fresh = await refreshPriceTiersFromServer();
        if (mounted) {
          console.log("🌐 PRICE TIERS from server (ProductsScreen):", fresh.length);
          setTiers(fresh);
        }
      } catch (e) {
        console.log("load price tiers error (ProductsScreen)", e);
      } finally {
        if (mounted) setTierLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [categoryId, isOnline]);


  /* ------------------------ SYNC ORDERS CACHE (for OrdersScreen offline) ------------------------ */
  async function syncOrdersCache() {
    try {
      let currentBranchId = branchId;

      if (!currentBranchId) {
        const raw = await AsyncStorage.getItem('deviceInfo');
        if (raw) {
          const dev = JSON.parse(raw);
          if (dev.branchId) {
            currentBranchId = dev.branchId;
            setBranchId(dev.branchId);
          }
        }
      }

      if (!online) return;

      let qs = '?take=200';
      if (currentBranchId) qs += `&branchId=${currentBranchId}`;
      const data = await get('/orders' + qs);
      const arr = Array.isArray(data) ? data : [];

      const locals: LocalOrder[] = arr.map(toLocalOrder);
      await saveOrdersLocal(locals);
    } catch (e) {
      console.log('syncOrdersCache error (ProductsScreen)', e);
    }
  }

  /* ------------------------ ORDERS BADGE (poll from AsyncStorage) ------------------------ */
  useEffect(() => {
    let mounted = true;
    let timer: any;

    async function loadBadge() {
      try {
        const raw = await AsyncStorage.getItem('newOrdersCount');
        if (!mounted) return;

        let n = 0;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'number') n = parsed;
            else if (
              parsed &&
              typeof parsed === 'object' &&
              typeof parsed.count === 'number'
            )
              n = parsed.count;
            else n = Number(raw) || 0;
          } catch {
            n = Number(raw) || 0;
          }
        }
        setOrdersBadge(n);
      } catch (e) {
        console.log('LOAD BADGE ERR (ProductsScreen)', e);
      }
    }

    loadBadge();
    timer = setInterval(loadBadge, 3000);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  /* ------------------------ SEARCH FILTER ------------------------ */
  useEffect(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      setFiltered(products);
      return;
    }
    setFiltered(products.filter((p) => p.name.toLowerCase().includes(q)));
  }, [search, products]);

  /* ------------------------ DISCOUNT ELIGIBILITY ------------------------ */
  function isDiscountEligibleForCart(
    discount: DiscountConfig,
    cartItems: CartItem[],
  ): boolean {
    const productIds = discount.productIds || [];
    const categoryIds = discount.categoryIds || [];
    const productSizeIds = discount.productSizeIds || [];
    const allowedOrderTypes = (discount.orderTypes || [])
      .map((v) => normalizeOrderTypeLabel(String(v)))
      .filter((v): v is string => !!v);

    if (allowedOrderTypes.length > 0) {
      const current = normalizeOrderTypeLabel(orderType);
      if (!current || !allowedOrderTypes.includes(current)) return false;
    }

    if (activeBranchId) {
      const branchIds = discount.branchIds || [];
      if (!discount.applyAllBranches && branchIds.length > 0) {
        const match = branchIds.includes(activeBranchId);
        if (!match) return false;
      }
    }

    const hasAssignments =
      productIds.length > 0 ||
      categoryIds.length > 0 ||
      productSizeIds.length > 0;

    if (!hasAssignments) return false;
    if (!cartItems.length) return false;

    const cartProductIds = new Set(cartItems.map((c) => c.productId));
    const cartSizeIds = new Set(
      cartItems.map((c) => c.sizeId).filter((id): id is string => !!id),
    );

    const productById = new Map<string, Product>();
    products.forEach((p) => productById.set(p.id, p));

    const cartCategoryIds = new Set<string>();
    cartItems.forEach((c) => {
      const p = productById.get(c.productId);
      if (p?.categoryId) cartCategoryIds.add(p.categoryId);
    });

    const productMatch =
      productIds.length > 0 &&
      productIds.some((pid) => cartProductIds.has(pid));
    const categoryMatch =
      categoryIds.length > 0 &&
      Array.from(cartCategoryIds).some((cid) => categoryIds.includes(cid));
    const sizeMatch =
      productSizeIds.length > 0 &&
      productSizeIds.some((sid) => cartSizeIds.has(sid));

    return productMatch || categoryMatch || sizeMatch;
  }

  const applicableDiscounts: DiscountConfig[] = useMemo(() => {
    return discountConfigs.filter((d) =>
      isDiscountEligibleForCart(
        d,
        Array.isArray(cart) ? (cart as CartItem[]) : [],
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discountConfigs, cart, orderType, activeBranchId, products]);

  /* ------------------------ CART HELPERS ------------------------ */
  function ensureOrderType() {
    if (!orderType) setOrderTypeModalVisible(true);
  }

  function getEffectiveUnitPrice(p: Product | undefined, sizeId: string | null) {
    if (!p) return 0;
    if (sizeId) {
      const s = p.sizes?.find((sz) => sz.id === sizeId);
      return normalizePrice(s?.price ?? p.basePrice ?? 0);
    }
    return normalizePrice(p.basePrice ?? 0);
  }

  function addToCart(product: Product, size: ProductSize | null) {
    if (readOnlyCart) return;

    const unitPrice = getEffectiveUnitPrice(
      product,
      size ? size.id : null,
    );
    if (!unitPrice) return;

    setCart((prev: CartItem[]) => {
      const sizeId = size ? size.id : null;
      const idx = prev.findIndex(
        (it) => it.productId === product.id && it.sizeId === sizeId,
      );
      if (idx !== -1) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1, price: unitPrice };
        return copy;
      }
      return [
        ...prev,
        {
          productId: product.id,
          productName: product.name,
          sizeId,
          sizeName: size ? size.name : null,
          price: unitPrice,
          qty: 1,
          modifiers: [],
        },
      ];
    });

    ensureOrderType();
  }

  function repriceCartWithProducts(nextProducts: Product[]) {
    setCart((prev: CartItem[]) =>
      prev.map((item) => {
        const p = nextProducts.find((pp) => pp.id === item.productId);
        const newUnit = getEffectiveUnitPrice(p, item.sizeId);
        return { ...item, price: newUnit };
      }),
    );
  }

  function changeCartQty(
    productId: string,
    sizeId: string | null,
    delta: number,
  ) {
    if (readOnlyCart) return;
    setCart((prev: CartItem[]) => {
      const items = [...prev];
      const idx = items.findIndex(
        (it) => it.productId === productId && it.sizeId === sizeId,
      );
      if (idx === -1) return items;

      const newQty = items[idx].qty + delta;
      if (newQty <= 0) items.splice(idx, 1);
      else items[idx] = { ...items[idx], qty: newQty };
      return items;
    });
  }

  function getCartQty(productId: string, sizeId: string | null) {
    const item: CartItem | undefined = (cart as CartItem[]).find(
      (it) => it.productId === productId && it.sizeId === sizeId,
    );
    return item?.qty ?? 0;
  }

  function onChangeQtyInCart(index: number, delta: number) {
    if (readOnlyCart) return;
    setCart((prev: CartItem[]) => {
      const items = [...prev];
      const item = items[index];
      const newQty = item.qty + delta;
      if (newQty <= 0) items.splice(index, 1);
      else items[index] = { ...item, qty: newQty };
      return items;
    });
  }

  function handleBack() {
    if (typeof goBack === 'function') {
      goBack();
      return;
    }
    if (navigation && typeof navigation.goBack === 'function') {
      navigation.goBack();
      return;
    }
    if (navigation && typeof navigation.navigate === 'function') {
      navigation.navigate('Category', { branchName, userName });
    }
  }

  function selectOrderType(label: string) {
    setOrderType(label);
    setOrderTypeModalVisible(false);
  }

  /* ------------------------ CUSTOMER HELPERS ------------------------ */
  async function fetchCustomers(term: string) {
    try {
      setCustomerLoading(true);
      const qs = term
        ? `/pos/customers?search=${encodeURIComponent(term)}`
        : '/pos/customers';
      const data = await get(qs);
      const arr = Array.isArray(data) ? data : [];
      setCustomerList(
        arr.map((c: any) => ({

          id: String(c.id),
          name: String(c.name),
          phone: c.phone ?? null,
        })),
      );
    } catch (err) {
      console.log('LOAD CUSTOMERS ERROR', err);
      Alert.alert('Error', 'Failed to load customers.');
    } finally {
      setCustomerLoading(false);
    }
  }

  function openCustomerModal() {
    if (readOnlyCart) return;
    setCustomerSearch('');
    setNewCustomerName('');
    setNewCustomerPhone('');
    setCustomerList([]);
    setCustomerModalVisible(true);
    fetchCustomers('');
  }

  function handleSelectCustomer(c: CustomerSummary) {
    setSelectedCustomer(c);
    setCustomerModalVisible(false);
  }

  async function handleCreateCustomer() {
    const name = newCustomerName.trim();
    const phone = newCustomerPhone.trim();

    if (!name || !phone) {
      Alert.alert('Missing data', 'Name and phone are required.');
      return;
    }

    try {
      setSavingCustomer(true);
      const created = await post('/pos/customers', { name, phone });

      const c: CustomerSummary = {
        id: String((created as any).id),
        name: String((created as any).name),
        phone: (created as any).phone ?? null,
      };

      setSelectedCustomer(c);
      setCustomerModalVisible(false);
    } catch (err: any) {
      console.log('CREATE CUSTOMER ERROR', err);
      const msg = String(err?.message || err);
      if (msg.includes('Customer already exists')) {
        Alert.alert(
          'Customer already exists',
          'A customer with this phone already exists.',
        );
      } else {
        Alert.alert('Error', 'Failed to create customer.');
      }
    } finally {
      setSavingCustomer(false);
    }
  }

  /* ------------------------ DISCOUNT UI ------------------------ */
  function openDiscountMenu() {
    if (readOnlyCart) return;

    if (!canUseAnyDiscount) {
      Alert.alert('No permission', 'You are not allowed to apply discounts.');
      return;
    }

    const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!cartItems.length) {
      Alert.alert('Empty cart', 'Add items to the order before discount.');
      return;
    }

    if (!orderType) {
      setOrderTypeModalVisible(true);
      return;
    }

    setDiscountModeModalVisible(true);
  }

  function openDiscountInput(mode: 'AMOUNT' | 'PERCENT') {
    if (!canUseOpenDiscount) {
      Alert.alert(
        'No permission',
        'You are not allowed to apply open/manual discounts.',
      );
      return;
    }

    setDiscountInputMode(mode);
    setDiscountInputValue('');
    setDiscountModeModalVisible(false);
    setDiscountInputModalVisible(true);
  }

  function applyDiscountInput() {
    if (!canUseOpenDiscount) {
      Alert.alert(
        'No permission',
        'You are not allowed to apply open/manual discounts.',
      );
      setDiscountInputModalVisible(false);
      return;
    }

    if (!discountInputMode) return;
    const raw = parseFloat(discountInputValue || '0');
    if (!raw || raw <= 0) {
      Alert.alert('Invalid value', 'Please enter a positive value.');
      return;
    }

    setAppliedDiscount({
      kind: discountInputMode,
      value: raw,
      source: 'MANUAL',
    });
    setDiscountInputModalVisible(false);
  }

  function openPredefinedDiscount() {
    if (readOnlyCart) return;

    if (!canUsePredefinedDiscount) {
      Alert.alert(
        'No permission',
        'You are not allowed to apply predefined discounts.',
      );
      return;
    }

    setDiscountModeModalVisible(false);

    const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!cartItems.length) {
      Alert.alert('Empty cart', 'Add items to the order before discount.');
      return;
    }

    if (!applicableDiscounts.length) {
      Alert.alert(
        'No discounts',
        'No predefined discounts are applicable for this branch/cart.',
      );
      return;
    }

    setDiscountPresetModalVisible(true);
  }

  function applyPredefinedDiscount(cfg: DiscountConfig) {
    const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!isDiscountEligibleForCart(cfg, cartItems)) {
      Alert.alert(
        'Not applicable',
        'This discount is not allowed for current items or order type.',
      );
      return;
    }

    setAppliedDiscount({
      kind: cfg.mode,
      value: cfg.value,
      source: 'PREDEFINED',
      name: cfg.name,
      id: cfg.id,
      scope: cfg.scope,
    });
    setDiscountPresetModalVisible(false);
  }

  function clearDiscount() {
    setAppliedDiscount(null);
  }

  /* ------------------------ TOTALS ------------------------ */
  const grossTotal: number = (cart as CartItem[]).reduce(
    (sum, it) => sum + calcLineTotal(it),
    0,
  );

  let discountAmount = 0;
  if (appliedDiscount && grossTotal > 0) {
    if (appliedDiscount.kind === 'PERCENT') {
      discountAmount = (grossTotal * appliedDiscount.value) / 100;
    } else {
      discountAmount = appliedDiscount.value;
    }
    if (discountAmount > grossTotal) discountAmount = grossTotal;
  }

  const netTotal = grossTotal - discountAmount;

  const vatFraction = vatRate > 0 ? vatRate / 100 : 0;
  const subtotalEx =
    netTotal > 0 && vatFraction > 0 ? netTotal / (1 + vatFraction) : netTotal;
  const vatAmount = netTotal - subtotalEx;

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const remainingRaw = netTotal - totalPaid;
  const remaining = remainingRaw > 0 ? remainingRaw : 0;
  const changeAmount = totalPaid > netTotal ? totalPaid - netTotal : 0;

  /* ------------------------ PAYMENT DERIVED ------------------------ */
  const selectedMethod = paymentMethods.find(
    (m) => m.id === selectedPaymentMethodId,
  );

  const quickAmounts = [remaining, 50, 100].filter((x) => x > 0.01);

  const groupedPayments = payments.reduce(
    (acc, p) => {
      if (!acc[p.methodId])
        acc[p.methodId] = { methodName: p.methodName, amount: 0 };
      acc[p.methodId].amount += p.amount;
      return acc;
    },
    {} as Record<string, { methodName: string; amount: number }>,
  );
  const groupedPaymentsArray = Object.values(groupedPayments);

  /* ------------------------ PAYMENT FLOW ------------------------ */
  function openPaymentModal() {
    if (readOnlyCart) return;
    if (netTotal <= 0) return;

    setSelectedPaymentMethodId(null);
    setShowCustomAmount(false);
    setCustomAmountInput('');
    setPaymentModalVisible(true);
  }

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
    setCustomAmountInput('');

    if (amount > effectiveRemaining) {
      const change = amount - effectiveRemaining;
      if (change > 0.01) {
        Alert.alert('Change', `Return to customer: ${toMoney(change)}`);
      }
    }
  }

  function clearPayments() {
    if (!payments.length) return;
    Alert.alert('Clear payments', 'Remove all added payments?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setPayments([]) },
    ]);
  }

  /* ------------------------ REQUIRED IDS GUARD ------------------------ */
  function ensureBrandAndDevice(): boolean {
    if (!brandId || !deviceId) {
      Alert.alert(
        'Device not activated',
        'Missing brandId/deviceId. Please re-activate this POS device.',
      );
      return false;
    }
    return true;
  }

  async function handlePay() {
    if (readOnlyCart) return;
    if (paying) return;
    if (netTotal <= 0) return;
    if (remaining > 0.01) return;
    if (!payments.length) return;
    if (!ensureBrandAndDevice()) return;
  
    try {
      setPaying(true);
  
      const discountPayload = appliedDiscount
        ? {
            kind: appliedDiscount.kind,
            value: appliedDiscount.value,
            amount: discountAmount,
          }
        : null;
  
      const basePayload: any = {
        brandId,
        deviceId,
  
        vatRate,
        subtotalEx,
        vatAmount,
        total: netTotal,
        discountAmount,
        discount: discountPayload,
        orderType,
        items: (cart as CartItem[]).map((i) => ({
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
  
      if (selectedCustomer?.id) {
        basePayload.customerId = String(selectedCustomer.id);
      }
  
      // 🔹 Capture response / orderNo for printing
      let orderNoForReceipt: string | null = null;
  
      if (activeOrderId) {
        const resp = await post(`/orders/${activeOrderId}/close`, basePayload);
        orderNoForReceipt = resp?.orderNo
          ? String(resp.orderNo)
          : String(activeOrderId);
      } else {
        const payload = {
          branchName,
          userName,
          status: 'CLOSED',
          ...basePayload,
        };
  
        const resp = await post('/pos/orders', payload);
        orderNoForReceipt = resp?.orderNo ? String(resp.orderNo) : null;
      }
  
      // 🔹 Auto-print after successful payment
      try {
        await printReceiptForOrder({
          brandName,
          branchName,
          userName,
          orderNo: orderNoForReceipt,
          orderType: orderType || null,
          businessDate: new Date(),
  
          cart: cart as CartItem[],
          subtotal: subtotalEx,
          vatAmount,
          total: netTotal,
          discountAmount,
          payments: payments.map((p) => ({
            methodName: p.methodName,
            amount: p.amount,
          })),
        });
      } catch (printErr) {
        console.log('⚠️ printReceiptForOrder error (ignored):', printErr);
      }
      //  Auto-print kitchen ticket (for KITCHEN printers)
      try {
        await printKitchenTicket({
          brandName,
          branchName,
          userName,                     
          orderNo: orderNoForReceipt,
          orderType: orderType || null,
          businessDate: new Date(), 
          tableName: null,
          notes: null,
          cart: cart as CartItem[],
        });
      } catch (kErr) {
        console.log("⚠️ printKitchenTicket error (ignored):", kErr);
      }
    
      // 🔁 Reset UI after payment
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId(null);
      setSelectedCustomer(null);
      setAppliedDiscount(null);
  
      await syncOrdersCache();
    } catch (err) {
      console.log('PAY /orders/:id/close ERROR (ProductsScreen)', err);
    } finally {
      setPaying(false);
    }
  }
  
  async function handleNewOrder() {
    if (readOnlyCart) return;
    const cartItems = cart as CartItem[];

    if (activeOrderId) {
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId(null);
      setSelectedCustomer(null);
      setAppliedDiscount(null);
      return;
    }

    if (!cartItems.length) {
      setPayments([]);
      setOrderType(null);
      setActiveOrderId(null);
      setSelectedCustomer(null);
      setAppliedDiscount(null);
      return;
    }

    if (!ensureBrandAndDevice()) return;

    try {
      const discountPayload = appliedDiscount
        ? {
          kind: appliedDiscount.kind,
          value: appliedDiscount.value,
          amount: discountAmount,
          source: appliedDiscount.source,
          name: appliedDiscount.name ?? null,
          configId: appliedDiscount.id ?? null,
          scope: appliedDiscount.scope ?? null,
        }
        : null;

      const payload: any = {
        brandId,
        deviceId,

        branchName,
        userName,
        orderType,
        vatRate,
        subtotalEx,
        vatAmount,
        total: netTotal,
        discountAmount,
        discount: discountPayload,
        status: 'ACTIVE',
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
        payments: [],
      };

      if (selectedCustomer?.id) {
        payload.customerId = String(selectedCustomer.id);
      }

      await post('/pos/orders', payload);

      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId(null);
      setSelectedCustomer(null);
      setAppliedDiscount(null);

      await syncOrdersCache();
    } catch (err) {
      console.log('NEW ORDER ERROR', err);
    }
  }

  function handleVoidPress() {
    if (readOnlyCart) return;
    const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!cartItems.length) return;

    if (!ensureBrandAndDevice()) return;

    Alert.alert('Void order', 'Are you sure you want to void this order?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: async () => {
          try {
            setVoidLoading(true);

            const discountPayload = appliedDiscount
              ? {
                kind: appliedDiscount.kind,
                value: appliedDiscount.value,
                amount: discountAmount,
                source: appliedDiscount.source,
                name: appliedDiscount.name ?? null,
                configId: appliedDiscount.id ?? null,
                scope: appliedDiscount.scope ?? null,
              }
              : null;

            const payload: any = {
              brandId,
              deviceId,

              branchName,
              userName,
              status: 'VOID',
              orderType,
              vatRate,
              subtotalEx,
              vatAmount,
              total: netTotal,
              discountAmount,
              discount: discountPayload,
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
              payments: [],
            };

            if (selectedCustomer?.id) {
              payload.customerId = String(selectedCustomer.id);
            }

            await post('/pos/orders', payload);

            setCart([]);
            setPayments([]);
            setOrderType(null);
            setActiveOrderId(null);
            setSelectedCustomer(null);
            setAppliedDiscount(null);

            await syncOrdersCache();
          } catch (err: any) {
            console.log('VOID ORDER ERROR (ProductsScreen)', err);
            Alert.alert('Error', err?.message || 'Failed to void this order');
          } finally {
            setVoidLoading(false);
          }
        },
      },
    ]);
  }

  const payDisabled =
    paying || netTotal <= 0 || remaining > 0.01 || payments.length === 0;

  type ActionButton = {
    label: string;
    onPress: () => void;
    loading?: boolean;
    visible?: boolean;
  };

  /* ------------------------ PRICE TIER HELPERS (API) ------------------------ */
  async function loadTiers() {
    try {
      setTierLoading(true);

      // Direct API call – same backend that CategoryScreen uses
      const raw = await get('/pricing/tiers');

      const list: PriceTier[] = Array.isArray(raw)
        ? raw
          .filter((t: any) => t && t.isActive !== false)
          .map((t: any) => ({
            id: String(t.id),
            name: String(t.name ?? t.code ?? 'Tier'),
          }))
        : [];

      setTiers(list);
    } catch (e: any) {
      console.log('loadTiers error (ProductsScreen)', e);
      Alert.alert('Error', 'Failed to load price tiers.');
    } finally {
      setTierLoading(false);
    }
  }

  async function applyTier(tier: PriceTier | null) {
    try {
      // 1) update global tier store (shared across screens)
      setActiveTier(tier ? { id: tier.id, name: tier.name } : null);

      // 2) clear tier → restore prices
      if (!tier) {
        setCart((prev: CartItem[]) =>
          clearTierFromCartLocal(Array.isArray(prev) ? prev : []),
        );
        setTierModalVisible(false);
        return;
      }

      // 3) collect IDs from cart
      const items: CartItem[] = Array.isArray(cart) ? (cart as CartItem[]) : [];
      const { productSizeIds, modifierItemIds } = collectTierIdsFromCart(items);

      console.log('applyTier productscreen – ids:', {
        tierId: tier.id,
        productSizeIds,
        modifierItemIds,
        cartLen: items.length,
      });

      if (!productSizeIds.length && !modifierItemIds.length) {
        console.log('applyTier productscreen – no IDs in cart, nothing to apply');
        setTierModalVisible(false);
        return;
      }

      // 4) figure out brandId like in CategoryScreen
      const effectiveBrandId = await getEffectiveBrandId(brandId);

      // 5) call backend with brandId + tier + ids
      const resp = await getTierPricingForIds({
        brandId: effectiveBrandId || undefined,
        tierId: tier.id,
        productSizeIds,
        modifierItemIds,
      });

      console.log('applyTier productscreen – resp:', resp);

      const sizesMap = resp?.sizesMap || {};
      const modifierItemsMap = resp?.modifierItemsMap || {};

      // 6) update cart prices
      setCart((prev: CartItem[]) => {
        const arr = Array.isArray(prev) ? prev : [];
        const next = applyTierToCartLocal(arr, sizesMap, modifierItemsMap);
        console.log('applyTier productscreen – cart after:', next);
        return next;
      });

      setTierModalVisible(false);
    } catch (e) {
      console.log('applyTier error (ProductsScreen)', e);
      Alert.alert('Tier pricing', 'Failed to apply tier pricing');
    }
  }

  async function handlePrintCurrentOrder() {
    try {
      const cartItems = cart as any[];
      if (!Array.isArray(cartItems) || cartItems.length === 0) {
        console.log("No items in cart to print");
        return;
      }
  
      await printReceiptForOrder({
        brandName,
        branchName,
        userName,
        orderNo: null, // if you have last orderNo in state, pass it here
        orderType,
        businessDate: new Date(),
  
        cart: cartItems,
        subtotal: subtotalEx,
        vatAmount,
        total: netTotal,
        discountAmount,
        payments: payments.map((p: any) => ({
          methodName: p.methodName || p.methodLabel || p.name || "Payment",
          amount: Number(p.amount || 0),
        })),
      });
    } catch (e) {
      console.log("handlePrintCurrentOrder error", e);
    }
  }
  

  const actions: ActionButton[] = [
    {
      label: 'Price Tag',
      visible: true,
      onPress: async () => {
        if (readOnlyCart) return;
        setTierModalVisible(true);
        await loadTiers();
      },
    },
    {
      label: 'Print',
      onPress: handlePrintCurrentOrder,   // ✅ use our helper
      visible: true,
    },
    { label: 'Kitchen', onPress: () => console.log('KITCHEN'), visible: true },
    {
      label: 'Void',
      onPress: handleVoidPress,
      loading: voidLoading,
      visible: true,
    },
    { label: 'Discount', onPress: openDiscountMenu, visible: canUseAnyDiscount },
    { label: 'Notes', onPress: () => console.log('NOTES'), visible: true },
    { label: 'Tags', onPress: () => console.log('TAGS'), visible: true },
    { label: 'More', onPress: () => console.log('MORE'), visible: true },
  ];

  const orderTypesList = [
    { label: 'DINE IN', value: 'DINE_IN' },
    { label: 'TAKE AWAY', value: 'TAKE_AWAY' },
    { label: 'DELIVERY', value: 'DELIVERY' },
    { label: 'DRIVE THRU', value: 'DRIVE_THRU' },
  ];

  /* ------------------------ RENDER ------------------------ */
  return (
    <SafeAreaView style={styles.root}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topSub}>
            Brand: {brandName || brandCode || '-'}
          </Text>
          <Text style={styles.topSub}>Branch: {branchName || '-'}</Text>
          <Text style={styles.topSub}>User: {userName || '-'}</Text>
        </View>
      </View>

      {/* Main layout */}
      <View style={styles.mainRow}>
        {/* LEFT – ORDER PANEL */}
        <View style={styles.orderPanel}>
          <View style={styles.orderHeaderRow}>
            <Pressable
              style={[styles.customerButton, readOnlyCart && { opacity: 0.5 }]}
              onPress={openCustomerModal}
              disabled={readOnlyCart}
            >
              <Text style={styles.customerButtonText}>
                {selectedCustomer ? selectedCustomer.name : 'Add Customers'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setOrderTypeModalVisible(true)}
              style={[styles.orderTypeTag, readOnlyCart && { opacity: 0.5 }]}
              disabled={readOnlyCart}
            >
              <Text style={styles.orderTypeText}>
                {orderType || 'SELECT ORDER TYPE'}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.orderTitle}>Current Order</Text>

          <ScrollView style={styles.orderList}>
            {(cart as CartItem[]).map((item, idx) => {
              const unitWithMods =
                normalizePrice(item.price) +
                calcLineModifierTotal(item.modifiers);

              return (
                <View key={idx.toString()} style={styles.orderRow}>
                  <Pressable
                    style={{ flex: 1 }}
                    onPress={() =>
                      navigation.navigate('Modifiers', {
                        productId: item.productId,
                        productName: item.productName,
                        sizeId: item.sizeId,
                        sizeName: item.sizeName,
                        modifiers: item.modifiers || [],
                      })
                    }
                  >
                    <View style={styles.orderLineTop}>
                      <Text style={styles.orderItemName}>{item.productName}</Text>
                      <Text style={styles.orderItemSize}>
                        {item.sizeName || ''}
                      </Text>
                      <Text style={styles.orderItemPriceRight}>
                        {toMoney(unitWithMods)}
                      </Text>
                    </View>

                    {item.modifiers && item.modifiers.length > 0 && (
                      <Text style={styles.orderItemModifiers} numberOfLines={2}>
                        {item.modifiers.map((m) => m.itemName).join(', ')}
                      </Text>
                    )}
                  </Pressable>

                  {readOnlyCart ? (
                    <View style={styles.qtyBoxReadOnly}>
                      <View style={styles.qtyMid}>
                        <Text style={styles.qtyValue}>{item.qty}</Text>
                      </View>
                    </View>
                  ) : (
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
                  )}
                </View>
              );
            })}
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
                  Discount
                  {appliedDiscount?.source === 'PREDEFINED' &&
                    appliedDiscount.name
                    ? ` (${appliedDiscount.name})`
                    : appliedDiscount?.kind === 'PERCENT'
                      ? ` (${appliedDiscount.value.toFixed(2)}%)`
                      : ''}
                </Text>
                <Text style={styles.summaryValue}>
                  -{toMoney(discountAmount)}
                </Text>
              </View>

              {appliedDiscount && (
                <Pressable
                  onPress={() => setAppliedDiscount(null)}
                  style={{ alignSelf: 'flex-end', marginBottom: 2 }}
                >
                  <Text style={styles.discountClearText}>Remove discount</Text>
                </Pressable>
              )}

              {groupedPaymentsArray.length > 0 && (
                <View style={styles.paymentsSummaryBox}>
                  {groupedPaymentsArray.map((p) => (
                    <View key={p.methodName} style={styles.paymentSummaryRow}>
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

            <Pressable style={styles.totalButton} onPress={openPaymentModal}>
              <Text style={styles.totalButtonLabel}>TOTAL</Text>
              <Text style={styles.totalButtonValue}>{toMoney(netTotal)}</Text>
            </Pressable>
          </View>
        </View>

        {/* RIGHT – PRODUCTS PANEL */}
        <View style={styles.productsPanel}>
          <View style={styles.actionRow}>
            {actions
              .filter((a) => a.visible !== false)
              .map((action) => {
                const isVoid = action.label === 'Void';
                const disabled = readOnlyCart || (isVoid && action.loading);
                return (
                  <Pressable
                    key={action.label}
                    style={({ pressed }) => [
                      styles.actionButton,
                      pressed && { opacity: 0.8 },
                      disabled && { opacity: 0.6 },
                    ]}
                    onPress={action.onPress}
                    disabled={!!disabled}
                  >
                    <Text style={styles.actionText}>
                      {isVoid && action.loading
                        ? 'VOID…'
                        : action.label.toUpperCase()}
                    </Text>
                  </Pressable>
                );
              })}
          </View>

          {/* Search */}
          <View style={styles.searchBox}>
            <TextInput
              placeholder="Search products"
              placeholderTextColor="#9ca3af"
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              editable={!readOnlyCart}
            />
          </View>

          {/* Grid */}
          {loading && (
            <View style={styles.productsCenter}>
              <ActivityIndicator size="large" />
            </View>
          )}

          {!loading && error && (
            <View style={styles.productsCenter}>
              <Text style={{ color: '#b91c1c' }}>{error}</Text>
            </View>
          )}

          {!loading && !error && (
            <ScrollView
              contentContainerStyle={styles.productsGrid}
              showsVerticalScrollIndicator={false}
            >
              {/* Back tile */}
              <Pressable
                style={({ pressed }) => [
                  styles.productTile,
                  pressed && { opacity: 0.8 },
                ]}
                onPress={handleBack}
              >
                <View style={styles.productImageWrap}>
                  <Text style={styles.backText}>← BACK</Text>
                </View>
                <Text style={styles.productName} numberOfLines={2}>
                  Back to Categories
                </Text>
              </Pressable>

              {filtered.map((p) => {
                const hasSizes = p.sizes && p.sizes.length > 0;
                const qtyNoSize = getCartQty(p.id, null);

                return (
                  <View key={p.id} style={styles.productTile}>
                    <Pressable
                      style={styles.productPressArea}
                      onPress={() => {
                        if (readOnlyCart) return;
                        if (hasSizes) {
                          setSelectedProduct(p);
                          setSizeModalVisible(true);
                        } else {
                          addToCart(p, null);
                        }
                      }}
                      disabled={readOnlyCart}
                    >
                      <View style={styles.productImageWrap}>
                        {(() => {
                          const img = normalizeImageUrl(p.imageUrl);

                          return img ? (
                            <Image
                              source={{ uri: img }}
                              style={styles.productImage}
                              resizeMode="cover"
                              onError={(e) => {
                                console.log(
                                  '❌ Product image failed:',
                                  img,
                                  e?.nativeEvent,
                                );
                              }}
                            />
                          ) : (
                            <View style={styles.productImagePlaceholder}>
                              <Text style={styles.productPlaceholderText}>
                                IMG
                              </Text>
                            </View>
                          );
                        })()}
                      </View>

                      <Text style={styles.productName} numberOfLines={2}>
                        {p.name}
                      </Text>
                    </Pressable>

                    {!hasSizes && !readOnlyCart && (
                      <View style={styles.productQtyBar}>
                        <Pressable
                          style={styles.qtyTapSmall}
                          onPress={() => changeCartQty(p.id, null, -1)}
                        >
                          <Text style={styles.qtyText}>-</Text>
                        </Pressable>
                        <View style={styles.qtyMidSmall}>
                          <Text style={styles.qtyValue}>{qtyNoSize}</Text>
                        </View>
                        <Pressable
                          style={styles.qtyTapSmall}
                          onPress={() => changeCartQty(p.id, null, +1)}
                        >
                          <Text style={styles.qtyText}>+</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                );
              })}
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
            (readOnlyCart || payDisabled) && styles.payButtonDisabled,
          ]}
          onPress={handlePay}
          disabled={readOnlyCart || payDisabled}
        >
          <Text style={styles.payButtonText}>{paying ? 'PAYING...' : 'PAY'}</Text>
        </Pressable>
      </View>

      {/* Bottom nav bar */}
      <View style={styles.bottomBar}>
        <Pressable
          style={styles.bottomItem}
          onPress={() => setHomeMenuVisible(true)}
        >
          <Text style={styles.bottomIcon}>🏠</Text>
          <Text style={styles.bottomLabel}>HOME</Text>
        </Pressable>

        <Pressable
          style={styles.bottomItem}
          onPress={() => navigation.navigate('Orders')}
        >
          <Text style={styles.bottomIcon}>🧾</Text>
          <Text style={styles.bottomLabel}>ORDERS</Text>

          <View style={styles.bottomBadge}>
            <Text style={styles.bottomBadgeText}>
              {ordersBadge > 99 ? '99+' : ordersBadge}
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={styles.bottomItem}
          onPress={() => console.log('TABLES')}
        >
          <Text style={styles.bottomIcon}>📋</Text>
          <Text style={styles.bottomLabel}>TABLES</Text>
        </Pressable>

        <Pressable
          style={styles.bottomItem}
          onPress={handleNewOrder}
          disabled={readOnlyCart}
        >
          <Text style={styles.bottomIcon}>＋</Text>
          <Text style={styles.bottomLabel}>NEW</Text>
        </Pressable>
      </View>

      {/* ------------------------ SIZE MODAL ------------------------ */}
      <Modal
        visible={sizeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSizeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{selectedProduct?.name}</Text>
            <Text style={styles.modalSub}>Choose size</Text>

            <ScrollView>
              {selectedProduct?.sizes?.map((s) => {
                const qty = getCartQty(selectedProduct.id, s.id);
                return (
                  <View key={s.id} style={styles.sizeRow}>
                    <Pressable
                      style={styles.sizeLeft}
                      onPress={() =>
                        changeCartQty(selectedProduct.id, s.id, -1)
                      }
                      disabled={readOnlyCart}
                    >
                      <Text style={styles.sizeName}>{s.name}</Text>
                      <Text style={styles.sizePriceValue}>{toMoney(s.price)}</Text>
                    </Pressable>
                    <Pressable
                      style={styles.sizeRight}
                      onPress={() => addToCart(selectedProduct as Product, s)}
                      disabled={readOnlyCart}
                    >
                      <Text style={styles.sizeQtyLabel}>QTY</Text>
                      <Text style={styles.sizeQtyValue}>{qty}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>

            <Pressable
              style={styles.modalClose}
              onPress={() => {
                setSizeModalVisible(false);
                setSelectedProduct(null);
              }}
            >
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ------------------------ ORDER TYPE MODAL ------------------------ */}
      <Modal
        visible={orderTypeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setOrderTypeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Order Type</Text>
            <Text style={styles.modalSub}>Select order type</Text>

            <View style={{ gap: 10 }}>
              {orderTypesList.map((t) => {
                const active = orderType === t.value;
                return (
                  <Pressable
                    key={t.value}
                    onPress={() => selectOrderType(t.value)}
                    disabled={readOnlyCart}
                    style={{
                      paddingVertical: 12,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: active ? '#111827' : '#e5e7eb',
                      backgroundColor: active ? '#111827' : '#ffffff',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '700',
                        color: active ? '#ffffff' : '#111827',
                      }}
                    >
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              style={[styles.modalClose, { backgroundColor: '#374151' }]}
              onPress={() => setOrderTypeModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ------------------------ PAYMENT MODAL ------------------------ */}
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
                      pressed && { opacity: 0.85 },
                    ]}
                    onPress={() => {
                      setSelectedPaymentMethodId(m.id);
                      setShowCustomAmount(false);
                      setCustomAmountInput('');
                    }}
                    disabled={readOnlyCart}
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
              <View style={styles.amountHeaderRow}>
                <Text style={styles.amountTitle}>
                  {selectedMethod?.name || 'Payment'}
                </Text>
                <Text style={styles.amountRemaining}>
                  Remaining: {toMoney(remaining)}
                </Text>
              </View>

              {quickAmounts.map((amt, idx) => (
                <Pressable
                  key={`${amt}-${idx}`}
                  style={({ pressed }) => [
                    styles.amountListRow,
                    pressed && styles.amountListRowPressed,
                  ]}
                  onPress={() => completePayment(amt)}
                  disabled={readOnlyCart}
                >
                  <Text style={styles.amountListText}>{toMoney(amt)}</Text>
                </Pressable>
              ))}

              <Pressable
                style={({ pressed }) => [
                  styles.amountListRow,
                  pressed && styles.amountListRowPressed,
                ]}
                onPress={() => setShowCustomAmount(true)}
                disabled={readOnlyCart}
              >
                <Text
                  style={[styles.amountListText, { fontWeight: '700' }]}
                >
                  CUSTOM
                </Text>
              </Pressable>

              {showCustomAmount && (
                <View style={styles.customInlineBox}>
                  <TextInput
                    style={styles.customInlineInput}
                    value={customAmountInput}
                    onChangeText={setCustomAmountInput}
                    keyboardType="numeric"
                    placeholder="0.00"
                    placeholderTextColor="#9ca3af"
                    editable={!readOnlyCart}
                  />
                  <Pressable
                    style={styles.customInlineOk}
                    onPress={() => {
                      const val = parseFloat(customAmountInput || '0');
                      if (!val || val <= 0) return;
                      completePayment(val);
                    }}
                    disabled={readOnlyCart}
                  >
                    <Text style={styles.customInlineOkText}>OK</Text>
                  </Pressable>
                </View>
              )}

              <Pressable
                style={styles.cancelRow}
                onPress={() => {
                  setSelectedPaymentMethodId(null);
                  setShowCustomAmount(false);
                  setCustomAmountInput('');
                }}
              >
                <Text style={styles.cancelText}>CANCEL</Text>
              </Pressable>
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
                <Text style={styles.customerEmptyText}>No customers found.</Text>
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
                  {savingCustomer ? 'SAVING…' : 'SAVE'}
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
          <View style={[styles.modalCard, { width: '35%' }]}>
            <Text style={styles.modalTitle}>Discount</Text>
            <Text style={styles.modalSub}>Choose discount type</Text>

            <View style={{ gap: 10 }}>
              <Pressable
                onPress={() => openDiscountInput('AMOUNT')}
                disabled={readOnlyCart || !canUseOpenDiscount}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: canUseOpenDiscount ? '#111827' : '#9ca3af',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '800' }}>
                  OPEN AMOUNT
                </Text>
              </Pressable>

              <Pressable
                onPress={() => openDiscountInput('PERCENT')}
                disabled={readOnlyCart || !canUseOpenDiscount}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: canUseOpenDiscount ? '#111827' : '#9ca3af',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '800' }}>
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
                    ? '#111827'
                    : '#9ca3af',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '800' }}>
                  PREDEFINED
                </Text>
              </Pressable>

              {appliedDiscount && (
                <Pressable
                  onPress={() => {
                    clearDiscount();
                    setDiscountModeModalVisible(false);
                  }}
                  disabled={readOnlyCart}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    backgroundColor: '#b91c1c',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '800' }}>
                    REMOVE DISCOUNT
                  </Text>
                </Pressable>
              )}
            </View>

            <Pressable
              style={[styles.modalClose, { backgroundColor: '#374151' }]}
              onPress={() => setDiscountModeModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Discount Input */}
      <Modal
        visible={discountInputModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDiscountInputModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { width: '35%' }]}>
            <Text style={styles.modalTitle}>
              {discountInputMode === 'PERCENT'
                ? 'Discount Percent'
                : 'Discount Amount'}
            </Text>
            <Text style={styles.modalSub}>
              Enter {discountInputMode === 'PERCENT' ? '%' : 'amount'} value
            </Text>

            <TextInput
              value={discountInputValue}
              onChangeText={setDiscountInputValue}
              keyboardType="numeric"
              editable={!readOnlyCart}
              placeholder={discountInputMode === 'PERCENT' ? 'e.g. 10' : 'e.g. 5'}
              placeholderTextColor="#9ca3af"
              style={{
                borderWidth: 1,
                borderColor: '#d1d5db',
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                fontSize: 14,
                color: '#111827',
                backgroundColor: '#f9fafb',
              }}
            />

            <Pressable
              onPress={applyDiscountInput}
              disabled={readOnlyCart}
              style={{
                marginTop: 12,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: '#111827',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '800' }}>APPLY</Text>
            </Pressable>

            <Pressable
              style={[styles.modalClose, { backgroundColor: '#374151' }]}
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
          <View style={[styles.modalCard, { width: '45%' }]}>
            <Text style={styles.modalTitle}>Predefined Discounts</Text>
            <Text style={styles.modalSub}>Select an applicable discount</Text>

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
                    borderColor: '#e5e7eb',
                    backgroundColor: '#ffffff',
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ fontWeight: '900', color: '#111827' }}>
                    {d.name}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: '#6b7280',
                      marginTop: 4,
                    }}
                  >
                    {d.mode === 'PERCENT'
                      ? `${d.value}%`
                      : `${toMoney(d.value)}`}
                    {d.scope ? ` • ${d.scope}` : ''}
                  </Text>
                </Pressable>
              ))}

              {applicableDiscounts.length === 0 && (
                <Text style={{ fontSize: 12, color: '#6b7280' }}>
                  No applicable discounts.
                </Text>
              )}
            </ScrollView>

            <Pressable
              style={[styles.modalClose, { backgroundColor: '#374151' }]}
              onPress={() => setDiscountPresetModalVisible(false)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ------------------------ PRICE TIER MODAL ------------------------ */}

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
              <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                <ActivityIndicator />
                <Text style={styles.tierLoadingText}>Loading tiers…</Text>
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
                          {(t.code || '').toUpperCase()}
                          {t.type ? ` • ${String(t.type).toUpperCase()}` : ''}
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
                      color: '#6B7280',
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
                <Text style={[styles.tierBtnText, styles.tierBtnTextGhost]}>
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
                <Text style={[styles.tierBtnText, styles.tierBtnTextPrimary]}>
                  Done
                </Text>
              </Pressable>
            </View>
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

            {/* 2) Drawer Ops */}
            <Pressable style={styles.homeMenuItem} onPress={() => { }}>
              <MaterialIcons
                name="inbox"
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
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

            {/* 5) Reports */}
            <Pressable style={styles.homeMenuItem} onPress={() => { }}>
              <MaterialIcons
                name="bar-chart"
                size={20}
                color="#111827"
                style={{ marginRight: 10 }}
              />
              <Text style={styles.homeMenuItemText}>Reports</Text>
            </Pressable>

            {/* 6) Devices */}
            <Pressable
              style={styles.homeMenuItem}
              onPress={() => {
                setHomeMenuVisible(false);
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
                navigation.navigate("Home");
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



    </SafeAreaView>
  );
}


/* ------------------------ STYLES ------------------------ */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f3f4f6' },
  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topSub: { fontSize: 13, color: '#4b5563' },
  mainRow: { flex: 1, flexDirection: 'row' },

  orderPanel: {
    width: '30%',
    backgroundColor: '#ffffff',
    borderRightWidth: 1,
    borderRightColor: '#e5e7eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  orderHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  customerButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#111827',
  },
  customerButtonText: { fontSize: 12, fontWeight: '600', color: '#111827' },
  orderTypeTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#111827',
  },
  orderTypeText: { fontSize: 12, fontWeight: '600', color: '#111827' },
  orderTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
    color: '#111827',
  },
  orderList: { flex: 1 },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  orderLineTop: { flexDirection: 'row', alignItems: 'center' },
  orderItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  orderItemSize: {
    fontSize: 12,
    color: '#6b7280',
    marginHorizontal: 8,
    minWidth: 50,
    textAlign: 'right',
  },
  orderItemPriceRight: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    minWidth: 50,
    textAlign: 'right',
  },
  orderItemModifiers: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  qtyBox: {
    flexDirection: 'row',
    marginLeft: 8,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  qtyBoxReadOnly: {
    flexDirection: 'row',
    marginLeft: 8,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f3f4f6',
  },
  qtyTapLeft: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  qtyTapRight: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  qtyMid: { paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' },
  qtyText: { fontSize: 14, fontWeight: '700', color: '#111827' },
  qtyValue: { fontSize: 13, fontWeight: '600', color: '#111827' },
  orderFooter: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
    alignItems: 'center',
  },
  summaryLabel: { fontSize: 12, color: '#6b7280' },
  summaryValue: { fontSize: 12, fontWeight: '600', color: '#111827' },
  discountClearText: { fontSize: 10, color: '#b91c1c', textAlign: 'right' },
  paymentsSummaryBox: {
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  paymentSummaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  paymentSummaryLabel: { fontSize: 11, color: '#6b7280' },
  paymentSummaryValue: { fontSize: 11, fontWeight: '600', color: '#111827' },
  paymentSummaryTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  paymentSummaryTotalLabel: { fontSize: 11, color: '#111827', fontWeight: '700' },
  paymentSummaryTotalValue: { fontSize: 11, color: '#111827', fontWeight: '700' },
  totalButton: {
    marginLeft: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: BLACK,
    alignItems: 'center',
  },
  totalButtonLabel: { fontSize: 11, color: '#ffffff', fontWeight: '600' },
  totalButtonValue: { fontSize: 14, color: '#ffffff', fontWeight: '700' },

  productsPanel: { flex: 1, paddingHorizontal: 20, paddingVertical: 14 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  actionButton: {
    height: 44,
    minWidth: 80,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: BLACK,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  actionText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
  searchBox: { marginBottom: 8 },
  searchInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 12,
    color: '#111827',
    backgroundColor: '#f9fafb',
  },
  productsCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  productsGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: 24 },
  productTile: {
    width: '22%',
    marginRight: 12,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  productPressArea: { flex: 1 },
  productImageWrap: {
    height: 90,
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backText: { fontSize: 14, fontWeight: '700', color: '#111827' },
  productImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  productImagePlaceholder: {
    width: '50%',
    height: '50%',
    backgroundColor: '#d1d5db',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  productPlaceholderText: { color: '#6b7280', fontSize: 12, fontWeight: '600' },
  productName: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    color: '#111827',
  },
  productQtyBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingVertical: 4,
  },
  qtyTapSmall: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#f9fafb',
    borderRadius: 999,
    marginHorizontal: 4,
  },
  qtyMidSmall: { minWidth: 24, alignItems: 'center' },

  paymentFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  remainingLabel: { fontSize: 12, color: '#6b7280', marginRight: 8 },
  remainingValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    marginRight: 12,
  },
  changeLabel: { fontSize: 12, color: '#6b7280', marginRight: 8 },
  changeValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#16a34a',
    marginRight: 12,
  },
  clearPaymentsText: { fontSize: 11, color: '#b91c1c', fontWeight: '600' },
  payButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#16a34a',
  },
  payButtonDisabled: { backgroundColor: '#9ca3af' },
  payButtonText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },

  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  bottomItem: { flexDirection: 'row', alignItems: 'center' },
  bottomIcon: { fontSize: 18, marginRight: 6 },
  bottomLabel: { fontSize: 12, fontWeight: '600', color: '#111827' },
  bottomBadge: {
    backgroundColor: 'red',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 6,
    minWidth: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomBadgeText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    width: '30%',
    maxHeight: '80%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
    color: '#111827',
  },
  modalSub: { fontSize: 13, color: '#6b7280', marginBottom: 10 },

  sizeRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  sizeLeft: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  sizeRight: {
    width: 90,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderLeftWidth: 1,
    borderLeftColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  sizePriceValue: { fontSize: 13, color: '#374151', marginTop: 2 },
  sizeQtyLabel: { fontSize: 11, color: '#6b7280' },
  sizeQtyValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginTop: 2,
  },

  modalClose: {
    marginTop: 12,
    alignSelf: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#111827',
  },
  modalCloseText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },

  paymentCard: {
    width: '30%',
    maxHeight: '80%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  paymentMethodRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  paymentMethodText: {
    fontSize: 14,
    color: '#111827',
  },

  amountCard: {
    width: '30%',
    maxHeight: '80%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  amountHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  amountTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  amountRemaining: {
    fontSize: 12,
    color: '#6b7280',
  },

  amountListRow: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  amountListRowPressed: {
    backgroundColor: '#f9fafb',
  },
  amountListText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },

  customInlineBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    gap: 10,
  },
  customInlineInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff',
    color: '#111827',
  },
  customInlineOk: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  customInlineOkText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },

  cancelRow: {
    marginTop: 16,
    alignItems: 'center',
  },
  cancelText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '700',
  },

  customerCard: {
    width: '35%',
    maxHeight: '85%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  customerSearchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 8 },
  customerSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#111827',
    marginRight: 8,
  },
  customerSearchButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: BLACK },
  customerSearchButtonText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
  customerLoadingBox: { paddingVertical: 16, alignItems: 'center' },
  customerRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  customerName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  customerPhone: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  customerEmptyText: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  customerNewBox: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  customerNewTitle: { fontSize: 13, fontWeight: '600', color: '#111827', marginBottom: 4 },
  customerInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    color: '#111827',
    marginBottom: 6,
  },
  customerSaveButton: { alignSelf: 'flex-end', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: BLACK },
  customerSaveText: { color: '#ffffff', fontSize: 13, fontWeight: '600' },

  // ✅ tier modal styles
  tierBackdrop: {
    flex: 1,
    backgroundColor: "rgba(17, 24, 39, 0.45)", // slate-900/45
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
});
