// src/screens/CategoryScreen.tsx
import React, { useEffect, useState } from 'react';
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
} from 'react-native';
import { get, post } from '../lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 🔊 sound for new orders
import { Audio } from 'expo-av';

// 🔌 WebSocket client
import { io, Socket } from 'socket.io-client';

// 🔹 SQLite helpers
import { getLocalCategories } from '../database/menu';
import {
  saveOrdersToSQLite as saveOrdersLocal,
  LocalOrder,
} from '../database/ordersLocal';

import { syncMenu } from '../sync/menuSync';

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
};

type CartItem = {
  productId: string;
  productName: string;
  sizeId: string | null;
  sizeName: string | null;
  price: number; // base product/size price (per item, incl. VAT)
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
  kind: 'AMOUNT' | 'PERCENT';
  value: number;
  source?: 'OPEN' | 'PREDEFINED' | null;
  id?: string | null;
  name?: string | null;
  label?: string | null;
};


const PURPLE = '#6d28d9';
const BLACK = '#000000';
const DISCOUNT_STORAGE_KEY = 'pos_applied_discount';

// ============= WebSocket helpers =============

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || 'http://192.168.100.245:4000';

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      console.log('🔌 CategoryScreen WS connected:', socket?.id);
    });
    socket.on('disconnect', (reason) => {
      console.log('⚠️ CategoryScreen WS disconnected:', reason);
    });
    socket.on('connect_error', (err) => {
      console.log('❌ CategoryScreen WS connect_error:', err?.message);
    });
  }
  return socket;
}

type OrdersChangedPayload = {
  orderId?: string;
  branchId?: string;
  channel?: string;
  status?: string;
  action?: 'created' | 'updated';
};

function subscribeOrdersChanged(
  handler: (payload: OrdersChangedPayload) => void
) {
  const s = getSocket();
  const listener = (payload: any) => {
    console.log('🛰 CategoryScreen WS orders:changed', payload);
    handler(payload || {});
  };
  s.on('orders:changed', listener);

  return () => {
    s.off('orders:changed', listener);
  };
}

async function registerPosDeviceOnSocket() {
  try {
    const raw = await AsyncStorage.getItem('deviceInfo');
    if (!raw) {
      console.log('WS register (CategoryScreen): no deviceInfo');
      return;
    }
    const dev = JSON.parse(raw);
    const branchId = dev.branchId;
    const deviceId = dev.id || dev.deviceId;

    if (!branchId || !deviceId) {
      console.log('WS register (CategoryScreen): missing branchId/deviceId', {
        branchId,
        deviceId,
      });
      return;
    }

    const s = getSocket();
    s.emit('pos:register', { deviceId, branchId });
    console.log('📡 CategoryScreen pos:register sent', { deviceId, branchId });
  } catch (e) {
    console.log('registerPosDeviceOnSocket (CategoryScreen) error', e);
  }
}

// ============= shared helpers =============

async function playAlertSound() {
  try {
    const { sound } = await Audio.Sound.createAsync(
      require('../assets/new-order.mp3'),
    );
    await sound.playAsync();
  } catch (err) {
    console.log('SOUND ERROR (CategoryScreen)', err);
  }
}

function normalizePrice(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (raw == null) return 0;
  const n = parseFloat(String(raw));
  return Number.isNaN(n) ? 0 : n;
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
    typeof value === 'number'
      ? value
      : parseFloat(value != null ? String(value) : '0');
  if (Number.isNaN(n)) return '0.00';
  return n.toFixed(2);
}

// helper to map SQLite rows to Category[]
function mapLocalCategories(rows: any[]): Category[] {
  return (rows || [])
    .filter((c: any) => c.isActive !== 0) // SQLite isActive = 0/1
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

export default function CategoryScreen({
  route,
  navigation,
  cart,
  setCart,
  activeOrderId,
  setActiveOrderId,
  online, // 🔹 optional prop from App.tsx
}: any) {
  const { branchName, userName } = route?.params || {};

  const [categories, setCategories] = useState<Category[]>([]);
  const [filtered, setFiltered] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // branchId from deviceInfo (for WS + orders sync)
  const [branchId, setBranchId] = useState<string | null>(null);

  // VAT + POS config
  const [vatRate, setVatRate] = useState<number>(15);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  // ORDER META
  const [orderType, setOrderType] = useState<string | null>(null);

  // VOID loading
  const [voidLoading, setVoidLoading] = useState(false);

  // 🔔 badge for ORDERS tab (global newOrdersCount from AsyncStorage)
  const [ordersBadge, setOrdersBadge] = useState(0);

  // 🔄 syncing state for Sync button / background refresh
  const [syncing, setSyncing] = useState(false);

  // PAYMENTS + DISCOUNT (same as ProductsScreen)
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paymentModalVisible, setPaymentModalVisible] = useState(false);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] =
    useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [discountValue, setDiscountValue] = useState<string>('0');

  const [appliedDiscount, setAppliedDiscount] =
    useState<AppliedDiscount | null>(null);

  // custom amount UI
  const [showCustomAmount, setShowCustomAmount] = useState(false);
  const [customAmountInput, setCustomAmountInput] = useState('');

  // CUSTOMER selection (same features as ProductsScreen)
  const [customerModalVisible, setCustomerModalVisible] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerList, setCustomerList] = useState<CustomerSummary[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerSummary | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [savingCustomer, setSavingCustomer] = useState(false);

  // ORDER TYPE modal
  const [orderTypeModalVisible, setOrderTypeModalVisible] = useState(false);

  const readOnlyCart = false; // Category screen always editable for now

  /* ------------------------ DISCOUNT LOAD / SYNC ------------------------ */

  async function loadAppliedDiscountFromStorage() {
    try {
      const raw = await AsyncStorage.getItem(DISCOUNT_STORAGE_KEY);
      if (!raw) {
        setAppliedDiscount(null);
        setDiscountValue('0');
        return;
      }

      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.kind === 'AMOUNT' || parsed.kind === 'PERCENT') &&
        typeof parsed.value === 'number'
      ) {
        setAppliedDiscount(parsed as AppliedDiscount);
        setDiscountValue(String(parsed.value));
      } else {
        setAppliedDiscount(null);
        setDiscountValue('0');
      }
    } catch (e) {
      console.log('LOAD DISCOUNT ERR (CategoryScreen)', e);
      setAppliedDiscount(null);
      setDiscountValue('0');
    }
  }

  // initial load
  useEffect(() => {
    loadAppliedDiscountFromStorage();
  }, []);

  // reload whenever Category screen gains focus (coming back from ProductsScreen)
  useEffect(() => {
    const unsubscribe =
      navigation?.addListener?.('focus', () => {
        loadAppliedDiscountFromStorage();
      }) || undefined;

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [navigation]);

  /* ------------------------ sync orders cache (for OrdersScreen) ------------------------ */
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

      if (!online) {
        console.log('syncOrdersCache: offline, skipping API fetch');
        return;
      }

      let qs = '?take=200';
      if (currentBranchId) qs += `&branchId=${currentBranchId}`;
      const data = await get('/orders' + qs);
      const arr = Array.isArray(data) ? data : [];

      console.log(
        '🌐 CategoryScreen syncOrdersCache: fetched orders:',
        arr.length,
      );
      const locals: LocalOrder[] = arr.map(toLocalOrder);
      await saveOrdersLocal(locals);
    } catch (e) {
      console.log('syncOrdersCache error (CategoryScreen)', e);
    }
  }

  /* ------------------------ LOAD CATEGORIES (SQLite-first + background sync) ------------------------ */
  useEffect(() => {
    let mounted = true;

    async function loadCategories() {
      setLoading(true);
      setError(null);

      try {
        // read branchId from deviceInfo once
        try {
          const raw = await AsyncStorage.getItem('deviceInfo');
          if (raw) {
            const dev = JSON.parse(raw);
            if (dev.branchId && !branchId) {
              setBranchId(dev.branchId);
            }
          }
        } catch (e) {
          console.log('READ deviceInfo ERR (CategoryScreen)', e);
        }

        // 1) LOCAL FIRST – fast UI
        try {
          const local = await getLocalCategories();
          if (!mounted) return;
          const mapped = mapLocalCategories(local);
          setCategories(mapped);
          setFiltered(mapped);
          console.log('📥 Categories from SQLite:', mapped.length);
        } catch (e) {
          console.log('CATEGORIES (SQLite) ERR', e);
          if (mounted) setError('Failed to load categories');
        } finally {
          if (mounted) setLoading(false);
        }

        // 2) If offline → stop here (keep local data)
        if (!online) {
          console.log('Offline → using only SQLite categories');
          return;
        }

        // 3) ONLINE BACKGROUND SYNC – no blocking UI
        setSyncing(true);
        try {
          await syncMenu(); // refresh menu (categories/products/modifiers) in SQLite
          if (!mounted) return;
          const fresh = await getLocalCategories();
          const mappedFresh = mapLocalCategories(fresh);
          setCategories(mappedFresh);
          setFiltered(mappedFresh);
          console.log('🌐 Categories after syncMenu:', mappedFresh.length);
        } catch (e) {
          console.log('syncMenu error (CategoryScreen):', e);
        } finally {
          if (mounted) setSyncing(false);
        }
      } catch (e: any) {
        console.log('CATEGORIES load ERR (CategoryScreen)', e);
        if (mounted) {
          setError('Failed to load categories');
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
    if (!online) return; // only sync automatically when online

    const intervalMs = 30 * 60 * 1000; // 30 minutes
    console.log('⏰ CategoryScreen auto-sync scheduler started (30 min)');

    const id = setInterval(async () => {
      try {
        console.log('⏰ CategoryScreen auto syncMenu tick');
        await syncMenu();
        const fresh = await getLocalCategories();
        const mappedFresh = mapLocalCategories(fresh);
        setCategories(mappedFresh);
        setFiltered(mappedFresh);
        console.log(
          '🌐 Categories auto-updated from server:',
          mappedFresh.length,
        );
        // also refresh orders cache in background
        await syncOrdersCache();
      } catch (e) {
        console.log('AUTO syncMenu ERR (CategoryScreen)', e);
      }
    }, intervalMs);

    return () => {
      clearInterval(id);
      console.log('⏹ CategoryScreen auto-sync scheduler cleared');
    };
  }, [online, branchId]);

  /* ------------------------ MANUAL SYNC BUTTON HANDLER ------------------------ */
  async function handleSyncPress() {
    if (!online) {
      Alert.alert(
        'Offline',
        'Cannot sync menu while offline. Please check your internet connection.',
      );
      return;
    }

    if (syncing) return;

    try {
      setSyncing(true);
      console.log('🔘 Manual syncMenu from CategoryScreen');
      await syncMenu();
      const fresh = await getLocalCategories();
      const mappedFresh = mapLocalCategories(fresh);
      setCategories(mappedFresh);
      setFiltered(mappedFresh);
      console.log('🌐 Categories after manual sync:', mappedFresh.length);

      // ⬇️ NEW: also sync orders cache → OrdersScreen gets fresh data
      await syncOrdersCache();
    } catch (e) {
      console.log('MANUAL syncMenu ERR (CategoryScreen)', e);
      Alert.alert('Sync error', 'Failed to sync menu from server.');
    } finally {
      setSyncing(false);
    }
  }

  /* ------------------------ LOAD POS CONFIG (VAT + Payment Methods) ------------------------ */
  useEffect(() => {
    let mounted = true;

    async function loadConfig() {
      try {
        const cfg = await get('/pos/config');
        console.log('📦 POS CONFIG (CategoryScreen):', cfg);
        if (!mounted) return;

        const vat = (cfg as any)?.vatRate;
        if (typeof vat === 'number') {
          setVatRate(vat);
        }

        const methods = (cfg as any)?.paymentMethods;
        if (Array.isArray(methods)) {
          setPaymentMethods(
            methods.map((m: any) => ({
              id: String(m.id),
              code: m.code ?? null,
              name: String(m.name),
            })),
          );
        }
      } catch (err) {
        console.log('POS CONFIG ERR (CategoryScreen):', err);
        // if offline or fails → keep defaults
      }
    }

    loadConfig();
    return () => {
      mounted = false;
    };
  }, []);

  /* ------------------------ POLL BADGE FROM STORAGE (kept) ------------------------ */
  useEffect(() => {
    let mounted = true;
    let timer: NodeJS.Timeout;

    async function loadBadge() {
      try {
        const raw = await AsyncStorage.getItem('newOrdersCount');
        if (!mounted) return;
        const n = raw ? Number(raw) || 0 : 0;
        setOrdersBadge(n);
      } catch (e) {
        console.log('LOAD BADGE ERR (CategoryScreen)', e);
      }
    }

    loadBadge();
    timer = setInterval(loadBadge, 3000); // light polling

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  /* ------------------------ WEBSOCKET: LIVE ORDER UPDATES ------------------------ */
  useEffect(() => {
    if (!online) {
      console.log('CategoryScreen WS disabled because offline');
      return;
    }

    let unsubscribe: (() => void) | undefined;

    (async () => {
      await registerPosDeviceOnSocket();

      unsubscribe = subscribeOrdersChanged(async (payload) => {
        try {
          if (payload.branchId && branchId && payload.branchId !== branchId) {
            return;
          }

          const ch = String(payload.channel || '').toUpperCase();
          const st = String(payload.status || '').toUpperCase();
          const isNew = payload.action === 'created';

          // 🔔 New pending CALLCENTER order → sound + badge + update SQLite/orders cache
          if (ch === 'CALLCENTER' && st === 'PENDING' && isNew) {
            setOrdersBadge((prev) => {
              const next = prev + 1;
              AsyncStorage.setItem('newOrdersCount', String(next)).catch(() => {
                console.log('BADGE SAVE ERR (CategoryScreen)');
              });
              return next;
            });

            await playAlertSound();
          }

          // Always refresh orders cache when we get any order change
          await syncOrdersCache();
        } catch (e) {
          console.log('WS orders:changed handler error (CategoryScreen)', e);
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
    setFiltered(categories.filter((c) => c.name.toLowerCase().includes(q)));
  }, [search, categories]);

  function onCategoryPress(cat: Category) {
    navigation?.navigate?.('Products', {
      categoryId: cat.id,
      categoryName: cat.name,
      branchName,
      userName,
      goBack: () => {
        navigation?.navigate?.('Category', {
          branchName,
          userName,
        });
      },
    });
  }

  /* ------------------------ CART TOTALS + PAYMENT CALC ------------------------ */
  const cartItems: CartItem[] = Array.isArray(cart) ? cart : [];

  // base total without discount
  const rawCartTotal: number = cartItems.reduce(
    (sum, it) => sum + calcLineTotal(it),
    0,
  );

  // compute discountAmount exactly like ProductsScreen
  let discountAmount = 0;
  if (appliedDiscount && rawCartTotal > 0) {
    if (appliedDiscount.kind === 'AMOUNT') {
      discountAmount = Math.min(rawCartTotal, appliedDiscount.value);
    } else if (appliedDiscount.kind === 'PERCENT') {
      discountAmount = Math.min(
        rawCartTotal,
        (rawCartTotal * appliedDiscount.value) / 100,
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

  const groupedPayments = payments.reduce(
    (acc, p) => {
      if (!acc[p.methodId]) {
        acc[p.methodId] = { methodName: p.methodName, amount: 0 };
      }
      acc[p.methodId].amount += p.amount;
      return acc;
    },
    {} as Record<string, { methodName: string; amount: number }>,
  );
  const groupedPaymentsArray = Object.values(groupedPayments);

  const quickAmounts = [remaining, 50, 100].filter((x) => x > 0.01);

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
      console.log('LOAD CUSTOMERS ERROR (CategoryScreen)', err);
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
      console.log('CREATE CUSTOMER ERROR (CategoryScreen)', err);
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

  /* ------------------------ CART QTY CHANGE (edit in Category screen) ------------------------ */
  function onChangeQtyInCart(index: number, delta: number) {
    if (readOnlyCart) return;
    setCart((prev: CartItem[]) => {
      const items = [...prev];
      const item = items[index];
      if (!item) return items;
      const newQty = item.qty + delta;
      if (newQty <= 0) {
        items.splice(index, 1);
      } else {
        items[index] = { ...item, qty: newQty };
      }
      return items;
    });
  }

  /* ------------------------ PAYMENT FLOW (same as ProductsScreen) ------------------------ */

  function openPaymentModal() {
    if (cartTotal <= 0) return;

    setSelectedPaymentMethodId(null);
    setShowCustomAmount(false);
    setCustomAmountInput('');
    setPaymentModalVisible(true);
  }

  const selectedMethod = paymentMethods.find(
    (m) => m.id === selectedPaymentMethodId,
  );
  const selectedPaymentName = selectedMethod?.name || '';

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
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => setPayments([]),
      },
    ]);
  }

  async function handlePay() {
    if (paying) return;
    if (cartTotal <= 0) return;
    if (remaining > 0.01) return;
    if (!payments.length) return; // must have at least one payment
  
    try {
      setPaying(true);
  
      const basePayload: any = {
        vatRate,
        subtotalEx,
        vatAmount,
        total: cartTotal,
        orderType,
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
  
      // ⭐ only add customerId if a customer is actually selected
      if (selectedCustomer?.id) {
        basePayload.customerId = String(selectedCustomer.id);
      }
  
      // ⭐ align with backend /pos-orders + /orders/:id/close – expects discountAmount + discount object
      if (appliedDiscount && discountAmount > 0) {
        basePayload.discountAmount = discountAmount;
        basePayload.discount = {
          kind: appliedDiscount.kind,              // "AMOUNT" | "PERCENT"
          value: appliedDiscount.value,            // 8 or 10 (percent) or amount
          amount: discountAmount,                  // final discount amount
          source: appliedDiscount.source ?? null,  // "OPEN" | "PREDEFINED" | null
          name:
            appliedDiscount.name ||
            appliedDiscount.label ||
            null,
          configId: appliedDiscount.id ?? null,
          scope: 'ORDER',                          // you can change later if you support item-level
        };
      } else {
        basePayload.discountAmount = 0;
        basePayload.discount = null;
      }
  
      if (activeOrderId) {
        console.log(
          '📨 CLOSE existing order from CategoryScreen',
          activeOrderId,
          '\nselectedCustomer =',
          selectedCustomer,
          '\nbasePayload =',
          JSON.stringify(basePayload, null, 2),
        );
  
        const resp = await post(`/orders/${activeOrderId}/close`, basePayload);
        console.log('✅ ORDER CLOSED (CategoryScreen)', resp);
      } else {
        const payload = {
          branchName,
          userName,
          status: 'CLOSED',
          ...basePayload,
        };
  
        console.log(
          '📨 POST /pos/orders (CLOSED from CategoryScreen)',
          '\nselectedCustomer =',
          selectedCustomer,
          '\npayload =',
          JSON.stringify(payload, null, 2),
        );
  
        const resp = await post('/pos/orders', payload);
        console.log('✅ ORDER CREATED & CLOSED (CategoryScreen)', resp);
      }
  
      // reset state after success
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);
  
      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue('0');
  
      await syncOrdersCache();
    } catch (err) {
      console.log('PAY ERROR (CategoryScreen)', err);
    } finally {
      setPaying(false);
    }
  }
  
  
  
  /* ------------------------ NEW ORDER (park cart as ACTIVE, same as ProductsScreen) ------------------------ */
  async function handleNewOrder() {
    const items = cartItems;
  
    if (activeOrderId) {
      console.log(
        'NEW pressed while editing existing order – clearing cart, not creating new order (CategoryScreen)',
      );
  
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);
  
      // 🔐 clear any persisted discount
      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue('0');
  
      return;
    }
  
    if (!items.length) {
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);
  
      // 🔐 clear any persisted discount (starting clean)
      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue('0');
  
      return;
    }
  
    try {
      const payload: any = {
        branchName,
        userName,
        orderType,
        vatRate,
        subtotalEx,
        vatAmount,
        total: cartTotal,
        status: 'ACTIVE',
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
          scope:
            appliedDiscount.kind === 'PERCENT'
              ? 'ORDER'
              : 'ORDER',
        };
      } else {
        payload.discountAmount = 0;
        payload.discount = null;
      }
  
      console.log(
        '📨 POST /pos/orders (ACTIVE from CategoryScreen) payload',
        '\nselectedCustomer =',
        selectedCustomer,
        '\npayload =',
        JSON.stringify(payload, null, 2),
      );
      const resp = await post('/pos/orders', payload);
      console.log('✅ ACTIVE ORDER CREATED (CategoryScreen)', resp);
  
      setCart([]);
      setPayments([]);
      setOrderType(null);
      setActiveOrderId?.(null);
      setSelectedCustomer(null);
  
      // 🔐 clear any persisted discount so next order starts fresh
      await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
      setAppliedDiscount(null);
      setDiscountValue('0');
  
      await syncOrdersCache();
    } catch (err) {
      console.log('NEW ORDER ERROR (CategoryScreen)', err);
    }
  }
  

  /* ------------------------ VOID ORDER FROM CATEGORY (same semantics as ProductsScreen) ------------------------ */
  function handleVoidPress() {
    const items: CartItem[] = Array.isArray(cart) ? cart : [];
    if (!items.length) {
      return;
    }
  
    Alert.alert('Void order', 'Are you sure you want to void this order?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Void',
        style: 'destructive',
        onPress: async () => {
          try {
            setVoidLoading(true);
  
            const payload: any = {
              branchName,
              userName,
              status: 'VOID',
              orderType,
              vatRate,
              subtotalEx,
              vatAmount,
              total: cartTotal,
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
                scope:
                  appliedDiscount.kind === 'PERCENT'
                    ? 'ORDER'
                    : 'ORDER',
              };
            } else {
              payload.discountAmount = 0;
              payload.discount = null;
            }
  
            console.log(
              '📨 POST /pos/orders (VOID from CategoryScreen)',
              '\nselectedCustomer =',
              selectedCustomer,
              '\npayload =',
              JSON.stringify(payload, null, 2),
            );
            await post('/pos/orders', payload);
  
            setCart([]);
            setPayments([]);
            setOrderType(null);
            setActiveOrderId?.(null);
            setSelectedCustomer(null);
  
            // 🔐 clear persisted discount on void as well
            await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
            setAppliedDiscount(null);
            setDiscountValue('0');
  
            await syncOrdersCache();
          } catch (err: any) {
            console.log('VOID ORDER ERROR (CategoryScreen)', err);
            Alert.alert('Error', err?.message || 'Failed to void this order');
          } finally {
            setVoidLoading(false);
          }
        },
      },
    ]);
  }
  

  const payDisabled =
    paying || cartTotal <= 0 || remaining > 0.01 || payments.length === 0;

  /* ------------------------ RENDER ------------------------ */

  return (
    <SafeAreaView style={styles.root}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topSub}>Branch: {branchName || '-'}</Text>
          <Text style={styles.topSub}>User: {userName || '-'}</Text>
        </View>
      </View>

      {/* Main two-column layout */}
      <View style={styles.mainRow}>
        {/* LEFT – Order panel with same cart features as ProductsScreen */}
        <View style={styles.orderPanel}>
          {/* header row with Add Customers + order type */}
          <View style={styles.orderHeaderRow}>
            <Pressable
              style={[
                styles.customerButton,
                readOnlyCart && { opacity: 0.5 },
              ]}
              onPress={openCustomerModal}
              disabled={readOnlyCart}
            >
              <Text style={styles.customerButtonText}>
                {selectedCustomer ? selectedCustomer.name : 'Add Customers'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setOrderTypeModalVisible(true)}
              style={styles.orderTypeTag}
              disabled={readOnlyCart}
            >
              <Text style={styles.orderTypeText}>
                {orderType || 'SELECT ORDER TYPE'}
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
                        <Text style={styles.orderItemName}>
                          {item.productName}
                        </Text>
                        <Text style={styles.orderItemSize}>
                          {item.sizeName || ''}
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
                          {mods.map((m) => m.itemName).join(', ')}
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

          {/* SUMMARY + TOTAL BUTTON (same layout as ProductsScreen) */}
          <View style={styles.orderFooter}>
            <View style={{ flex: 1 }}>
              <View className="summary-row" style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Subtotal (ex-VAT)</Text>
                <Text style={styles.summaryValue}>{toMoney(subtotalEx)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  VAT ({vatRate.toFixed(2)}%)
                </Text>
                <Text style={styles.summaryValue}>{toMoney(vatAmount)}</Text>
              </View>

              {/* Discount row – mirror ProductsScreen */}
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>
                  {appliedDiscount
                    ? `Discount (${
                        appliedDiscount.name ||
                        appliedDiscount.label ||
                        (appliedDiscount.kind === 'PERCENT'
                          ? `${appliedDiscount.value}%`
                          : toMoney(appliedDiscount.value))
                      })`
                    : 'Discount'}
                </Text>

                <View style={styles.discountInputWrap}>
                  <TextInput
                    style={styles.discountInput}
                    value={
                      discountAmount > 0 ? `-${toMoney(discountAmount)}` : ''
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
                    setDiscountValue('0');
                    await AsyncStorage.removeItem(DISCOUNT_STORAGE_KEY);
                  }}
                >
                  <Text style={styles.removeDiscountText}>Remove discount</Text>
                </Pressable>
              )}

              {/* Multi-tender summary */}
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
              <Text style={styles.totalButtonValue}>{toMoney(cartTotal)}</Text>
            </Pressable>
          </View>
        </View>

        {/* RIGHT – Actions + search + categories */}
        <View style={styles.rightPanel}>
          {/* Action buttons row */}
          <View style={styles.actionRow}>
            {[
              'Print',
              'Kitchen',
              'Void',
              'Discount',
              'Notes',
              'Tags',
              'Sync',
              'More',
            ].map((label) => {
              const isVoid = label === 'Void';
              const isSync = label === 'Sync';

              let onPress: () => void | Promise<void> = () =>
                console.log(label.toUpperCase(), 'pressed');

              if (isVoid) {
                onPress = handleVoidPress;
              } else if (isSync) {
                onPress = handleSyncPress;
              }

              const disabled = (isVoid && voidLoading) || (isSync && syncing);

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
                    {isVoid && voidLoading
                      ? 'VOID…'
                      : isSync && syncing
                      ? 'SYNC…'
                      : label.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Search categories */}
          <View style={styles.searchBox}>
            <TextInput
              placeholder="Search categories"
              placeholderTextColor="#9ca3af"
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
            />
          </View>

          {/* Category grid */}
          {loading && (
            <View style={styles.center}>
              <ActivityIndicator size="large" />
            </View>
          )}

          {!loading && error && (
            <View style={styles.center}>
              <Text style={{ color: '#b91c1c' }}>{error}</Text>
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
                    {cat.imageUrl ? (
                      <Image
                        source={{ uri: cat.imageUrl }}
                        style={styles.categoryImage}
                      />
                    ) : (
                      <View style={styles.categoryPlaceholder}>
                        <Text style={styles.categoryPlaceholderText}>IMG</Text>
                      </View>
                    )}
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

      {/* PAYMENT FOOTER (same as ProductsScreen) */}
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
          style={[styles.payButton, payDisabled && styles.payButtonDisabled]}
          onPress={handlePay}
          disabled={payDisabled}
        >
          <Text style={styles.payButtonText}>
            {paying ? 'PAYING...' : 'PAY'}
          </Text>
        </Pressable>
      </View>

      {/* Bottom POS bar */}
      <View style={styles.bottomBar}>
        <Pressable
          style={styles.bottomItem}
          onPress={() => navigation.navigate('Home')}
        >
          <Text style={styles.bottomIcon}>🏠</Text>
          <Text style={styles.bottomLabel}>HOME</Text>
        </Pressable>

        {/* ORDERS (with badge) */}
        <Pressable
          style={[styles.bottomItem]}
          onPress={() => navigation.navigate('Orders')}
        >
          <Text style={[styles.bottomIcon]}>🧾</Text>
          <Text style={[styles.bottomLabel]}>ORDERS</Text>

          {ordersBadge > 0 && (
            <View style={styles.bottomBadge}>
              <Text style={styles.bottomBadgeText}>
                {ordersBadge > 99 ? '99+' : ordersBadge}
              </Text>
            </View>
          )}
        </Pressable>

        <Pressable
          style={styles.bottomItem}
          onPress={() => {
            console.log('TABLES pressed');
          }}
        >
          <Text style={styles.bottomIcon}>📋</Text>
          <Text style={styles.bottomLabel}>TABLES</Text>
        </Pressable>

        {/* NEW → same semantics as ProductsScreen NEW */}
        <Pressable style={styles.bottomItem} onPress={handleNewOrder}>
          <Text style={styles.bottomIcon}>＋</Text>
          <Text style={styles.bottomLabel}>NEW</Text>
        </Pressable>
      </View>

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

            {['Dine In', 'Pick Up', 'Delivery', 'Drive Thru'].map((t) => (
              <Pressable
                key={t}
                style={({ pressed }) => [
                  styles.orderTypeRow,
                  pressed && { backgroundColor: '#f3f4f6' },
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

      {/* PAYMENT MODAL (method + amount) */}
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
                        const val = parseFloat(customAmountInput || '0');
                        if (!val || val <= 0) {
                          Alert.alert(
                            'Invalid amount',
                            'Please enter a valid amount.',
                          );
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
                    setCustomAmountInput('');
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

            {/* search existing */}
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

            {/* create new */}
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
    </SafeAreaView>
  );
}

/* ------------------------ STYLES ------------------------ */
// (keep your existing StyleSheet.create(...) here)


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },

  topBar: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  topSub: {
    fontSize: 12,
    color: '#6b7280',
  },

  mainRow: {
    flex: 1,
    flexDirection: 'row',
  },

  /* LEFT – Order panel */
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
  customerButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  orderTypeTag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#111827',
  },
  orderTypeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },

  orderTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
    color: '#111827',
  },
  orderList: {
    flex: 1,
  },
  orderEmpty: {
    fontSize: 12,
    color: '#9ca3af',
  },

  orderRowFull: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  orderLineTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
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
  orderItemModifiers: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 2,
  },

  qtyBox: {
    flexDirection: 'row',
    marginLeft: 8,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
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
  qtyMid: {
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qtyText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  qtyValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },

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
  summaryLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  summaryValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },

  discountInputWrap: {
    width: 80,
    height: 28,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  
  discountInput: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    height: 35,
    paddingHorizontal: 4,   
    textAlign: 'right',
    color: '#000',             
    fontSize: 11,               
    fontWeight: '500',
  },
  
  paymentsSummaryBox: {
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  paymentSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  paymentSummaryLabel: {
    fontSize: 11,
    color: '#6b7280',
  },
  paymentSummaryValue: {
    fontSize: 11,
    fontWeight: '600',
    color: '#111827',
  },
  paymentSummaryTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  paymentSummaryTotalLabel: {
    fontSize: 11,
    color: '#111827',
    fontWeight: '700',
  },
  paymentSummaryTotalValue: {
    fontSize: 11,
    color: '#111827',
    fontWeight: '700',
  },

  totalButton: {
    marginLeft: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: BLACK,
    alignItems: 'center',
  },
  totalButtonLabel: {
    fontSize: 11,
    color: '#ffffff',
    fontWeight: '600',
  },
  totalButtonValue: {
    fontSize: 14,
    color: '#ffffff',
    fontWeight: '700',
  },

  /* RIGHT – actions + categories grid */
  rightPanel: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
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
  actionText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },

  searchBox: {
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    justifyContent: 'center',
    marginBottom: 12,
  },
  searchInput: {
    fontSize: 13,
    color: '#111827',
  },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  grid: {
    paddingBottom: 24,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  categoryTile: {
    width: '22%',
    marginRight: 12,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    overflow: 'hidden',
  },
  categoryImageWrap: {
    height: 90,
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  categoryPlaceholder: {
    width: '50%',
    height: '50%',
    backgroundColor: '#d1d5db',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryPlaceholderText: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },
  categoryName: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    color: '#111827',
  },

  /* Payment footer */
  paymentFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  remainingLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginRight: 8,
  },
  remainingValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    marginRight: 12,
  },
  changeLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginRight: 8,
  },
  changeValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#16a34a',
    marginRight: 12,
  },
  clearPaymentsText: {
    fontSize: 11,
    color: '#b91c1c',
    fontWeight: '600',
  },
  payButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#16a34a',
  },
  payButtonDisabled: {
    backgroundColor: '#9ca3af',
  },
  payButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },

  /* Bottom POS bar */
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
  bottomItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  bottomIcon: {
    fontSize: 18,
    marginRight: 6,
  },
  bottomLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
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
  bottomBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },

  /* Modals shared */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCardBase: {
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
  modalClose: {
    marginTop: 12,
    alignSelf: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#111827',
  },
  modalCloseText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },

  /* Order type modal */
  orderTypeCard: {
    width: 320,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  orderTypeRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderTypeRowText: {
    fontSize: 15,
    color: '#111827',
  },
  orderTypeTitle: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    color: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },

  /* Payment modal */
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
    width: '40%',
    maxHeight: '40%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  amountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  amountRemainingText: {
    fontSize: 12,
    color: '#6b7280',
  },
  amountRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  amountText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  amountCancelRow: {
    marginTop: 10,
    paddingVertical: 10,
  },
  amountCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#b91c1c',
    textAlign: 'center',
  },

  customAmountBox: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  customLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  customInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    color: '#111827',
    marginBottom: 8,
  },
  customApplyButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: BLACK,
  },
  customApplyText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },

  /* Customers modal */
  customerCard: {
    width: '35%',
    maxHeight: '85%',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
  },
  customerSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
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
  customerSearchButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: BLACK,
  },
  customerSearchButtonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  customerLoadingBox: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  customerRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  customerName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  customerPhone: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  customerEmptyText: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
  },
  customerNewBox: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  customerNewTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
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
  customerSaveButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: BLACK,
  },
  customerSaveText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  removeDiscountText: {
    marginTop: 4,
    fontSize: 12,
    color: '#b91c1c',
    textAlign: 'right',
  },

}); 