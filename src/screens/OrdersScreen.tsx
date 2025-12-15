// src/screens/OrdersScreen.tsx
import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Modal,
  Switch,
  Alert,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';

import { get, post } from '../lib/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadOrdersFromSQLite as loadOrdersLocal,
  saveOrdersToSQLite as saveOrdersLocal,
  LocalOrder,
} from '../database/ordersLocal';

import {
  subscribeOrdersEvents,
  OrdersChangedPayload,
} from '../lib/ordersEvents';

const BLACK = '#000000';

// 🔹 infinite scroll setup
const INITIAL_VISIBLE = 10;
const LOAD_MORE_STEP = 10;

type OrderRow = {
  id: string;
  orderNo: string;
  status: string;
};

type CartModifier = {
  groupId: string;
  groupName: string;
  itemId: string;
  itemName: string;
  price: number;
};

type CartItem = {
  productId: string;
  productName: string;
  sizeId: string | null;
  sizeName: string | null;
  price: number;
  qty: number;
  modifiers?: CartModifier[];
  readonly?: boolean;
};

type StatusTab = 'ALL' | 'ACTIVE' | 'PENDING' | 'AHEAD';

function isCallcenterOrder(o: any): boolean {
  return String(o.channel || '').toUpperCase() === 'CALLCENTER';
}

function orderMatchesTab(o: any, tab: StatusTab): boolean {
  const status = String(o.status || '').toUpperCase();
  switch (tab) {
    case 'ALL':
      return true;
    case 'ACTIVE':
      return status === 'ACTIVE';
    case 'PENDING':
      return status === 'PENDING';
    case 'AHEAD':
      return isCallcenterOrder(o);
    default:
      return true;
  }
}

/* -------------------- MAP API ORDER -> LocalOrder (for SQLite) -------------------- */

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

/* ---------------- BADGE HELPER (PENDING + ACTIVE) ---------------- */
async function updateGlobalBadgeFromOrders(list: any[]) {
  try {
    const count = (list || []).filter((o) => {
      const st = String(o.status || '').toUpperCase();
      return st === 'PENDING' || st === 'ACTIVE';
    }).length;

    await AsyncStorage.setItem('newOrdersCount', String(count));
    console.log('🔔 OrdersScreen updateGlobalBadgeFromOrders →', count);
  } catch (e) {
    console.log('updateGlobalBadgeFromOrders error', e);
  }
}

export default function OrdersScreen({
  navigation,
  cart,
  setCart,
  setActiveOrderId,
  online,
}: any) {
  const [orders, setOrders] = useState<any[]>([]);
  const [filteredOrders, setFiltered] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');

  const [branchId, setBranchId] = useState<string | null>(null);

  const [statusTab, setStatusTab] = useState<StatusTab>('ALL');

  const [filterVisible, setFilterVisible] = useState(false);
  const [businessDateOnly, setBusinessDateOnly] = useState(false);
  const [aheadOnly, setAheadOnly] = useState(false);
  const [dueTodayOnly, setDueTodayOnly] = useState(false);

  const [badgeCount, setBadgeCount] = useState(0);

  const [confirmVisible, setConfirmVisible] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);
  const [processing, setProcessing] = useState(false);

  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [loadingMore, setLoadingMore] = useState(false);

  /* ---------------- LOAD INITIAL BADGE FROM STORAGE ---------------- */
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('newOrdersCount');
        const n = raw ? Number(raw) || 0 : 0;
        setBadgeCount(n);
      } catch (e) {
        console.log('OrdersScreen BADGE LOAD ERR', e);
      }
    })();
  }, []);

  /* ---------------- LOAD ALL ORDERS (LOCAL FIRST + SERVER REFRESH) ---------------- */
  useEffect(() => {
    let mounted = true;

    async function load() {
      setLoading(true);

      let currentBranchId: string | undefined;
      try {
        const raw = await AsyncStorage.getItem('deviceInfo');
        if (raw) {
          const dev = JSON.parse(raw);
          currentBranchId = dev.branchId;
          if (dev.branchId && !branchId) {
            setBranchId(dev.branchId);
          }
        }
      } catch (e) {
        console.log('READ deviceInfo ERR', e);
      }

      try {
        // 1) LOCAL FIRST
        try {
          const local = await loadOrdersLocal();
          if (mounted && local && local.length > 0) {
            console.log('📥 Orders from SQLite:', local.length);
            setOrders(local || []);
            setFiltered(local || []);
            setVisibleCount(INITIAL_VISIBLE);
            await updateGlobalBadgeFromOrders(local);
          } else {
            console.log('📥 SQLite empty for orders');
          }
        } catch (e) {
          console.log('LOAD LOCAL ORDERS ERR', e);
        } finally {
          if (mounted) setLoading(false);
        }

        // 2) If offline → stop here
        if (!online) {
          console.log('Offline → using only SQLite cache');
          return;
        }

        // 3) ONLINE REFRESH
        setSyncing(true);
        try {
          let qs = '?take=200';
          if (currentBranchId) qs += `&branchId=${currentBranchId}`;
          const data = await get('/orders' + qs);
          const arr = Array.isArray(data) ? data : [];

          console.log('🌐 Orders from API:', arr.length);
          if (mounted) {
            setOrders(arr || []);
            setFiltered(arr || []);
            setVisibleCount(INITIAL_VISIBLE);
          }

          const locals: LocalOrder[] = arr.map(toLocalOrder);
          await saveOrdersLocal(locals);
          await updateGlobalBadgeFromOrders(arr);
        } catch (err) {
          console.log('ORDERS API ERR (online refresh)', err);
        } finally {
          if (mounted) setSyncing(false);
        }
      } catch (err) {
        console.log('ORDERS ERR (outer)', err);
        if (mounted) {
          setLoading(false);
          setSyncing(false);
        }
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [online, branchId]);

  /* ---------------- MANUAL SYNC BUTTON ---------------- */
  async function handleSyncPress() {
    if (syncing) return;

    try {
      setSyncing(true);

      let currentBranchId: string | undefined = branchId ?? undefined;
      if (!currentBranchId) {
        try {
          const raw = await AsyncStorage.getItem('deviceInfo');
          if (raw) {
            const dev = JSON.parse(raw);
            currentBranchId = dev.branchId;
            if (dev.branchId && !branchId) {
              setBranchId(dev.branchId);
            }
          }
        } catch (e) {
          console.log('READ deviceInfo ERR', e);
        }
      }

      if (!online) {
        console.log('SYNC pressed but offline → using local cache only');
        const local = await loadOrdersLocal();
        setOrders(local || []);
        setFiltered(local || []);
        setVisibleCount(INITIAL_VISIBLE);
        await updateGlobalBadgeFromOrders(local || []);
        return;
      }

      let qs = '?take=200';
      if (currentBranchId) qs += `&branchId=${currentBranchId}`;
      const data = await get('/orders' + qs);
      const arr = Array.isArray(data) ? data : [];

      setOrders(arr || []);
      setFiltered(arr || []);
      setVisibleCount(INITIAL_VISIBLE);

      const locals: LocalOrder[] = arr.map(toLocalOrder);
      await saveOrdersLocal(locals);
      await updateGlobalBadgeFromOrders(arr);
    } catch (err) {
      console.log('SYNC ERR', err);
    } finally {
      setSyncing(false);
    }
  }

  /* ---------------- LISTEN TO GLOBAL WS EVENTS ---------------- */
  useEffect(() => {
    const unsubscribe = subscribeOrdersEvents(
      async (payload: OrdersChangedPayload) => {
        try {
          const devRaw = await AsyncStorage.getItem('deviceInfo');
          const dev = devRaw ? JSON.parse(devRaw) : null;
          const currentBranchId = dev?.branchId || branchId;

          if (
            payload.branchId &&
            currentBranchId &&
            payload.branchId !== currentBranchId
          ) {
            return;
          }

          console.log(
            '📥 OrdersScreen received GLOBAL orders:changed → refresh list',
          );
          await handleSyncPress();

          // Also refresh local badge from storage to keep `badgeCount` in sync
          const raw = await AsyncStorage.getItem('newOrdersCount');
          const n = raw ? Number(raw) || 0 : 0;
          setBadgeCount(n);
        } catch (e) {
          console.log('OrdersScreen GLOBAL handler error', e);
        }
      },
    );

    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  /* ---------------- SEARCH + FILTER LOGIC ---------------- */
  useEffect(() => {
    const q = search.trim().toLowerCase();

    let list = orders.filter((o) => orderMatchesTab(o, statusTab));

    if (businessDateOnly) {
      const todayStr = new Date().toISOString().slice(0, 10);
      list = list.filter((o) => {
        const d = new Date(o.businessDate || o.createdAt);
        if (isNaN(d.getTime())) return false;
        return d.toISOString().slice(0, 10) === todayStr;
      });
    }

    if (aheadOnly) {
      list = list.filter((o) => isCallcenterOrder(o));
    }

    if (dueTodayOnly) {
      const todayStr = new Date().toISOString().slice(0, 10);
      list = list.filter((o) => {
        const d = new Date(o.dueAt || o.createdAt);
        if (isNaN(d.getTime())) return false;
        return d.toISOString().slice(0, 10) === todayStr;
      });
    }

    if (!q) {
      setFiltered(list);
    } else {
      setFiltered(
        list.filter(
          (o) =>
            o.orderNo?.toLowerCase().includes(q) ||
            (o.status || '').toLowerCase().includes(q),
        ),
      );
    }
  }, [search, orders, statusTab, businessDateOnly, aheadOnly, dueTodayOnly]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [
    search,
    statusTab,
    businessDateOnly,
    aheadOnly,
    dueTodayOnly,
    orders.length,
  ]);

  /* ---------------- LOAD ITEMS INTO CART + NAVIGATE ---------------- */
  async function handleOpenOrder(o: any) {
    const status = String(o.status || '').toUpperCase();

    if (status === 'DECLINED' || status === 'CLOSED' || status === 'VOID') {
      Alert.alert('Order closed', `You cannot reopen a ${status} order.`);
      return;
    }

    if (!online) {
      Alert.alert(
        'Offline',
        'Cannot reopen orders while offline. Please connect to internet.',
      );
      return;
    }

    const isCallcenter = isCallcenterOrder(o);

    try {
      const detail: any = await get(`/orders/${o.id}`);
      if (!detail) {
        Alert.alert('Error', 'Order details not found.');
        return;
      }

      const items = detail.items || detail.orderItems || [];
      let firstCategoryId: string | null = null;
      const orderTypeFromOrder = detail.orderType ?? null;

      const newCart: CartItem[] = items.map((it: any) => {
        const productName =
          it.productName || it.name || it.product?.name || 'Item';

        const sizeName =
          it.sizeName ||
          it.size ||
          it.sizeObj?.name ||
          it.size?.name ||
          null;

        const unitPrice = Number(it.unitPrice ?? it.price ?? 0);
        const qty = Number(it.qty ?? 1);

        const modsSrc = it.modifiers || it.orderItemModifiers || [];

        const modifiers: CartModifier[] =
          modsSrc.map((m: any) => ({
            groupId: '',
            groupName: '',
            itemId: m.modifierItemId ?? m.itemId,
            itemName:
              m.modifierName || m.name || m.modifierItem?.name || 'Modifier',
            price: Number(m.price ?? 0),
          })) || [];

        if (!firstCategoryId && it.product && it.product.categoryId) {
          firstCategoryId = it.product.categoryId;
        }

        return {
          productId: it.productId,
          productName,
          sizeId: it.sizeId ?? it.size?.id ?? null,
          sizeName,
          price: unitPrice,
          qty,
          modifiers,
          readonly: isCallcenter,
        };
      });

      console.log('🔎 category for reopen =', firstCategoryId);

      setCart(newCart);
      setActiveOrderId(o.id);

      navigation.navigate('Products', {
        categoryId: firstCategoryId ?? '',
        categoryName: isCallcenter ? 'Callcenter Order' : 'Re-opened Order',
        reopenFromCallcenter: isCallcenter,
        orderTypeFromOrder,
      });
    } catch (err) {
      console.log('OPEN ORDER ERR', err);
      Alert.alert('Error', 'Failed to open order. Please try again.');
    }
  }

  function handleOrderPress(o: any) {
    const status = String(o.status || '').toUpperCase();

    if (isCallcenterOrder(o) && status === 'PENDING') {
      setSelectedOrder(o);
      setConfirmVisible(true);
      return;
    }

    if (status === 'DECLINED' || status === 'CLOSED' || status === 'VOID') {
      Alert.alert('Order closed', `You cannot reopen a ${status} order.`);
      return;
    }

    handleOpenOrder(o);
  }

  async function handleAccept() {
    if (!selectedOrder) return;
    setProcessing(true);
    try {
      await post(`/orders/${selectedOrder.id}/callcenter-accept`, {});

      const updated = orders.map((o) =>
        o.id === selectedOrder.id ? { ...o, status: 'ACTIVE' } : o,
      );
      setOrders(updated);
      setFiltered((prev) =>
        prev.map((o) =>
          o.id === selectedOrder.id ? { ...o, status: 'ACTIVE' } : o,
        ),
      );

      await handleOpenOrder({ ...selectedOrder, status: 'ACTIVE' });

      try {
        const locals: LocalOrder[] = updated.map(toLocalOrder);
        await saveOrdersLocal(locals);
      } catch (e) {
        console.log('SAVE CACHE AFTER ACCEPT ERR', e);
      }

      await updateGlobalBadgeFromOrders(updated);
    } catch (err) {
      console.log('ACCEPT ERR', err);
    } finally {
      setProcessing(false);
      setConfirmVisible(false);
      setSelectedOrder(null);
    }
  }

  async function handleDecline() {
    if (!selectedOrder) {
      setConfirmVisible(false);
      return;
    }
    setProcessing(true);
    try {
      await post(`/orders/${selectedOrder.id}/callcenter-decline`, {});

      const updated = orders.map((o) =>
        o.id === selectedOrder.id ? { ...o, status: 'DECLINED' } : o,
      );
      setOrders(updated);
      setFiltered((prev) =>
        prev.map((o) =>
          o.id === selectedOrder.id ? { ...o, status: 'DECLINED' } : o,
        ),
      );

      try {
        const locals: LocalOrder[] = updated.map(toLocalOrder);
        await saveOrdersLocal(locals);
      } catch (e) {
        console.log('SAVE CACHE AFTER DECLINE ERR', e);
      }

      await updateGlobalBadgeFromOrders(updated);
    } catch (err) {
      console.log('DECLINE ERR', err);
    } finally {
      setProcessing(false);
      setConfirmVisible(false);
      setSelectedOrder(null);
    }
  }

  function resetFilters() {
    setBusinessDateOnly(false);
    setAheadOnly(false);
    setDueTodayOnly(false);
    setStatusTab('ALL');
  }

  function handleScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    if (loading || loadingMore) return;
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;

    const distanceFromBottom =
      contentSize.height - (layoutMeasurement.height + contentOffset.y);

    if (distanceFromBottom < 80 && visibleCount < filteredOrders.length) {
      setLoadingMore(true);
      setVisibleCount((prev) =>
        Math.min(prev + LOAD_MORE_STEP, filteredOrders.length),
      );
      setLoadingMore(false);
    }
  }

  const displayed = filteredOrders.slice(0, visibleCount);

  return (
    <View style={styles.root}>
      {/* HEADER ROW */}
      <View style={styles.headerRow}>
        <Pressable style={styles.headerBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.headerBtnText}>BACK</Text>
        </Pressable>

        <Pressable
          style={styles.headerBtn}
          onPress={() => setFilterVisible(true)}
        >
          <Text style={styles.headerBtnText}>FILTER</Text>
        </Pressable>

        <Pressable style={styles.headerBtn} onPress={handleSyncPress}>
          <Text style={styles.headerBtnText}>
            {syncing ? 'SYNCING…' : 'SYNC'}
          </Text>
        </Pressable>

        <Pressable style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>MORE</Text>
        </Pressable>
      </View>

      {/* SEARCH INPUT */}
      <View style={styles.searchBox}>
        <TextInput
          placeholder="Search orders"
          placeholderTextColor="#888"
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* TABS + BADGE */}
      <View style={styles.tabRow}>
        <Pressable onPress={() => setStatusTab('ALL')}>
          <Text style={statusTab === 'ALL' ? styles.tabActive : styles.tab}>
            ALL ({filteredOrders.length})
          </Text>
        </Pressable>

        <Pressable onPress={() => setStatusTab('ACTIVE')}>
          <Text style={statusTab === 'ACTIVE' ? styles.tabActive : styles.tab}>
            ACTIVE
          </Text>
        </Pressable>

        <Pressable onPress={() => setStatusTab('PENDING')}>
          <Text
            style={statusTab === 'PENDING' ? styles.tabActive : styles.tab}
          >
            PENDING
          </Text>
        </Pressable>

        <Pressable onPress={() => setStatusTab('AHEAD')}>
          <Text style={statusTab === 'AHEAD' ? styles.tabActive : styles.tab}>
            AHEAD
          </Text>
        </Pressable>

        {badgeCount > 0 && (
          <View style={styles.badgeBubble}>
            <Text style={{ color: '#fff', fontSize: 12 }}>
              {badgeCount > 99 ? '99+' : badgeCount}
            </Text>
          </View>
        )}
      </View>

      {/* ORDERS LIST */}
      <ScrollView
        style={{ flex: 1 }}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        {loading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={BLACK} />
          </View>
        )}

        {!loading && filteredOrders.length === 0 && (
          <View style={styles.center}>
            <Text style={{ color: '#666' }}>No orders found</Text>
          </View>
        )}

        {!loading &&
          displayed.map((o) => (
            <Pressable
              key={o.id}
              style={[
                styles.orderRow,
                isCallcenterOrder(o) ? styles.callCenterRow : null,
              ]}
              onPress={() => handleOrderPress(o)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.orderNo}>{o.orderNo}</Text>
                <Text style={styles.orderType}>{o.channel}</Text>
                <Text style={styles.orderDate}>
                  {o.createdAt
                    ? new Date(o.createdAt).toLocaleString()
                    : o.businessDate
                    ? new Date(o.businessDate).toLocaleDateString()
                    : ''}
                </Text>
              </View>

              <View style={{ alignItems: 'flex-end' }}>
                <Text
                  style={[
                    styles.orderStatus,
                    String(o.status || '').toUpperCase() === 'PENDING'
                      ? { color: '#f97316' }
                      : String(o.status || '').toUpperCase() === 'ACTIVE'
                      ? { color: '#10b981' }
                      : String(o.status || '').toUpperCase() === 'DECLINED'
                      ? { color: '#ef4444' }
                      : String(o.status || '').toUpperCase() === 'CLOSED'
                      ? { color: '#3b82f6' }
                      : { color: '#6b7280' },
                  ]}
                >
                  {o.status}
                </Text>
                <Text style={styles.orderAmount}>﷼{o.netTotal}</Text>
              </View>
            </Pressable>
          ))}

        {!loading && displayed.length < filteredOrders.length && (
          <View style={styles.loadMoreBox}>
            <ActivityIndicator size="small" color={BLACK} />
            <Text style={styles.loadMoreText}>Loading more orders…</Text>
          </View>
        )}
      </ScrollView>

      {/* FILTER POPUP */}
      <Modal
        visible={filterVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFilterVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.filterBox}>
            <Text style={styles.filterTitle}>Order Filters</Text>

            {/* Business date */}
            <View style={styles.filterRow}>
              <View>
                <Text style={styles.filterLabel}>Business date</Text>
              </View>
              <Text style={styles.filterValue}>
                {businessDateOnly ? 'Today' : 'All'}
              </Text>
            </View>
            <Pressable
              onPress={() => setBusinessDateOnly(true)}
              style={styles.filterLinkWrapper}
            >
              <Text style={styles.filterLink}>Show current business day</Text>
            </Pressable>

            {/* Ahead toggle */}
            <View style={[styles.filterRow, { marginTop: 8 }]}>
              <Text style={styles.filterLabel}>Ahead</Text>
              <Switch
                value={aheadOnly}
                onValueChange={setAheadOnly}
                thumbColor={aheadOnly ? '#4f46e5' : '#f4f4f5'}
                trackColor={{ false: '#e5e7eb', true: '#c7d2fe' }}
              />
            </View>

            {/* Due date */}
            <View style={[styles.filterRow, { marginTop: 16 }]}>
              <View>
                <Text style={styles.filterLabel}>Due date</Text>
              </View>
              <Text style={styles.filterValue}>
                {dueTodayOnly ? 'Today' : 'All'}
              </Text>
            </View>
            <Pressable
              onPress={() => setDueTodayOnly(true)}
              style={styles.filterLinkWrapper}
            >
              <Text style={styles.filterLink}>Select today</Text>
            </Pressable>

            {/* Footer buttons */}
            <View style={styles.filterFooter}>
              <Pressable
                style={[styles.filterBtn, styles.filterResetBtn]}
                onPress={() => {
                  resetFilters();
                  setFilterVisible(false);
                }}
              >
                <Text style={styles.filterBtnText}>Reset</Text>
              </Pressable>

              <Pressable
                style={[styles.filterBtn, styles.filterApplyBtn]}
                onPress={() => setFilterVisible(false)}
              >
                <Text style={styles.filterBtnText}>Apply</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ACCEPT / DECLINE POPUP */}
      <Modal
        visible={confirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!processing) setConfirmVisible(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Callcenter Order</Text>
            <Text style={styles.modalText}>
              Do you want to accept this order?
            </Text>

            {selectedOrder && (
              <Text style={styles.modalOrderInfo}>
                #{selectedOrder.orderNo} • {selectedOrder.channel}
              </Text>
            )}

            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalBtn, styles.declineBtn]}
                onPress={handleDecline}
                disabled={processing}
              >
                <Text style={styles.modalBtnText}>Decline</Text>
              </Pressable>

              <Pressable
                style={[styles.modalBtn, styles.acceptBtn]}
                onPress={handleAccept}
                disabled={processing}
              >
                <Text style={styles.modalBtnText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f3f4f6',
  },
  headerBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: BLACK,
    marginRight: 8,
  },
  headerBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  searchBox: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  searchInput: {
    fontSize: 13,
    color: '#111827',
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
  },
  tab: {
    marginRight: 16,
    fontSize: 12,
    color: '#6b7280',
  },
  tabActive: {
    marginRight: 16,
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  badgeBubble: {
    marginLeft: 'auto',
    marginRight: 4,
    backgroundColor: '#ef4444',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    backgroundColor: '#ffffff',
  },
  callCenterRow: {
    borderLeftWidth: 4,
    borderLeftColor: '#2563eb',
  },
  orderNo: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  orderType: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  orderDate: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
  },
  orderStatus: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  orderAmount: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  loadMoreBox: {
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreText: {
    marginLeft: 8,
    fontSize: 12,
    color: '#6b7280',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterBox: {
    width: '70%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
  },
  filterTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  filterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  filterLabel: {
    fontSize: 13,
    color: '#111827',
  },
  filterValue: {
    fontSize: 13,
    color: '#6b7280',
  },
  filterLinkWrapper: {
    marginTop: 4,
  },
  filterLink: {
    fontSize: 12,
    color: '#2563eb',
  },
  filterFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  filterBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  filterResetBtn: {
    backgroundColor: '#e5e7eb',
  },
  filterApplyBtn: {
    backgroundColor: BLACK,
  },
  filterBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  modalBox: {
    width: '70%',
    maxWidth: 420,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
  },
  modalText: {
    fontSize: 14,
    color: '#4b5563',
  },
  modalOrderInfo: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  declineBtn: {
    backgroundColor: '#ef4444',
  },
  acceptBtn: {
    backgroundColor: '#16a34a',
  },
  modalBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
});
