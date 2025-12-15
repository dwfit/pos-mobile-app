// src/screens/ModifiersScreen.tsx
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { get } from '../lib/api';

// ✅ SQLite helpers
import { initDatabase, queryAll, execSql } from '../database/db';

// ✅ WebSocket menu helpers
import { subscribeToMenuEvents } from '../lib/ws';
import type { MenuEventPayload } from '../lib/ws';

type ModifierItem = {
  id: string;
  name: string;
  price?: number | string | null;
  isActive?: boolean; // <-- respect backend flag
};

type ModifierGroup = {
  id: string;
  name: string;
  items: ModifierItem[];
  isActive?: boolean; // <-- respect backend flag
};

type CartModifier = {
  groupId: string;
  groupName: string;
  itemId: string;
  itemName: string;
  price: number;
};

const BLACK = '#000000';

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

/* -------------------- HELPERS -------------------- */

function filterActiveGroups(gs: ModifierGroup[]): ModifierGroup[] {
  return (gs || [])
    .filter((g) => g.isActive !== false)
    .map((g) => ({
      ...g,
      items: Array.isArray(g.items)
        ? g.items.filter((it) => it.isActive !== false)
        : [],
    }))
    .filter((g) => g.items.length > 0);
}

/* -------------------- SQLITE HELPERS -------------------- */

async function ensureModifiersTable() {
  await initDatabase();
  await execSql(`
    CREATE TABLE IF NOT EXISTS modifiers_cache (
      productId     TEXT,
      groupId       TEXT,
      groupName     TEXT,
      itemId        TEXT,
      itemName      TEXT,
      price         REAL,
      isGroupActive INTEGER,
      isItemActive  INTEGER,
      PRIMARY KEY (productId, groupId, itemId)
    );
  `);
}

// Save groups/items for a specific productId
async function saveModifiersToSQLite(
  productId: string,
  groups: ModifierGroup[],
): Promise<void> {
  if (!productId) return;

  await initDatabase();

  // Clear old snapshot for this product
  await execSql('DELETE FROM modifiers_cache WHERE productId = ?;', [
    productId,
  ]);

  // Insert fresh snapshot
  for (const g of groups) {
    const isGroupActive = g.isActive === false ? 0 : 1;

    for (const item of g.items || []) {
      const isItemActive = item.isActive === false ? 0 : 1;
      const price = normalizePrice(item.price);

      await execSql(
        `INSERT OR REPLACE INTO modifiers_cache
         (productId, groupId, groupName, itemId, itemName, price, isGroupActive, isItemActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          g.id,
          g.name,
          item.id,
          item.name,
          price,
          isGroupActive,
          isItemActive,
        ],
      );
    }
  }
}

// Load groups/items for a specific productId from SQLite
async function loadModifiersFromSQLite(
  productId: string,
): Promise<ModifierGroup[]> {
  if (!productId) return [];

  await initDatabase();

  try {
    const rows =
      (await queryAll<any>(
        `SELECT * FROM modifiers_cache WHERE productId = ?`,
        [productId],
      )) ?? [];

    if (!rows.length) return [];

    const groupMap: Record<string, ModifierGroup> = {};

    for (const row of rows) {
      if (!groupMap[row.groupId]) {
        groupMap[row.groupId] = {
          id: row.groupId,
          name: row.groupName,
          isActive: row.isGroupActive ? true : false,
          items: [],
        };
      }

      groupMap[row.groupId].items.push({
        id: row.itemId,
        name: row.itemName,
        price: row.price,
        isActive: row.isItemActive ? true : false,
      });
    }

    const groups: ModifierGroup[] = Object.values(groupMap);
    return filterActiveGroups(groups);
  } catch (err) {
    console.log('SQLite loadModifiersFromSQLite error:', err);
    return [];
  }
}

/* -------------------- COMPONENT -------------------- */

export default function ModifiersScreen({
  route,
  navigation,
  cart,
  setCart,
  online, // 🔹 passed from App.tsx
}: any) {
  const { productId, productName, sizeName, sizeId, modifiers: initialMods } =
    route.params || {};

  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // groupId -> set of itemIds
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});

  /* -------------------- LOCAL LOAD (SQLite-first) -------------------- */

  useEffect(() => {
    let mounted = true;

    async function applyGroups(gs: ModifierGroup[]) {
      if (!mounted) return;
      const activeGroups = filterActiveGroups(gs);
      setGroups(activeGroups);
      if (activeGroups.length > 0) {
        setActiveGroupId(activeGroups[0].id);
      } else {
        setActiveGroupId(null);
      }
    }

    async function load() {
      try {
        setLoading(true);
        setError(null);

        if (!productId) {
          setGroups([]);
          setActiveGroupId(null);
          setLoading(false);
          return;
        }

        await ensureModifiersTable();

        // 1) LOCAL FIRST – fast UI from SQLite (ONLY this productId)
        try {
          const cached = await loadModifiersFromSQLite(productId);
          await applyGroups(cached);
        } catch (e) {
          console.log('MODIFIERS SQLite initial ERR', e);
        } finally {
          if (mounted) setLoading(false);
        }

        // 2) If offline → keep using local cache
        if (!online) {
          console.log('Offline → ModifiersScreen using only SQLite');
          return;
        }

        // 3) ONLINE REFRESH ONCE – pull from API, save, then reload from SQLite
        try {
          console.log('ModifiersScreen initial fetch from API');
          const data = await get(
            `/menu/modifiers?productId=${encodeURIComponent(productId)}`,
          );
          const safe: ModifierGroup[] = Array.isArray(data) ? data : [];

          await saveModifiersToSQLite(productId, safe);

          const refreshed = await loadModifiersFromSQLite(productId);
          await applyGroups(refreshed);
        } catch (apiErr) {
          console.log('❌ MODIFIERS API initial ERR', apiErr);
        }
      } catch (e: any) {
        console.log('❌ MODIFIERS ERR (outer)', e);
        if (mounted) setError('Failed to load modifiers');
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [productId, online]);

  /* -------------------- WS: listen for MODIFIERS_UPDATED -------------------- */

  useEffect(() => {
    if (!online || !productId) return;

    console.log('🔔 ModifiersScreen subscribing to menu:event for product', productId);

    const unsubscribe = subscribeToMenuEvents({
      productId,
      onModifiersUpdated: async (_payload: MenuEventPayload) => {
        try {
          console.log(
            '📡 MODIFIERS_UPDATED received, refreshing modifiers for product',
            productId,
          );
          const data = await get(
            `/menu/modifiers?productId=${encodeURIComponent(productId)}`,
          );
          const safe: ModifierGroup[] = Array.isArray(data) ? data : [];

          await saveModifiersToSQLite(productId, safe);

          const refreshed = await loadModifiersFromSQLite(productId);
          const activeGroups = filterActiveGroups(refreshed);
          setGroups(activeGroups);
          if (activeGroups.length > 0) {
            setActiveGroupId((prev) =>
              prev && activeGroups.some((g) => g.id === prev)
                ? prev
                : activeGroups[0].id,
            );
          } else {
            setActiveGroupId(null);
          }
        } catch (e) {
          console.log('WS MODIFIERS_UPDATED refresh error', e);
        }
      },
    });

    return () => {
      console.log(
        '🔕 ModifiersScreen unsubscribing from menu:event for product',
        productId,
      );
      unsubscribe();
    };
  }, [online, productId]);

  /* -------------------- Initialize selection from existing cart modifiers -------------------- */

  useEffect(() => {
    if (!initialMods || !Array.isArray(initialMods) || groups.length === 0) {
      return;
    }
    const map: Record<string, Set<string>> = {};
    for (const m of initialMods as CartModifier[]) {
      if (!m.groupId || !m.itemId) continue;
      if (!map[m.groupId]) map[m.groupId] = new Set<string>();
      map[m.groupId].add(m.itemId);
    }
    setSelected(map);
  }, [groups, initialMods]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || null;

  /* -------------------- HANDLERS -------------------- */

  function toggleModifier(groupId: string, itemId: string) {
    setSelected((prev) => {
      const copy: Record<string, Set<string>> = {};
      for (const key of Object.keys(prev)) {
        copy[key] = new Set(prev[key]);
      }
      if (!copy[groupId]) copy[groupId] = new Set<string>();

      if (copy[groupId].has(itemId)) {
        copy[groupId].delete(itemId);
      } else {
        copy[groupId].add(itemId);
      }

      return copy;
    });
  }

  function isSelected(groupId: string, itemId: string) {
    return selected[groupId]?.has(itemId) ?? false;
  }

  function buildSelectedPayload(): CartModifier[] {
    const result: CartModifier[] = [];
    for (const g of groups) {
      const set = selected[g.id];
      if (!set || set.size === 0) continue;
      for (const item of g.items) {
        if (set.has(item.id)) {
          result.push({
            groupId: g.id,
            groupName: g.name,
            itemId: item.id,
            itemName: item.name,
            price: normalizePrice(item.price),
          });
        }
      }
    }
    return result;
  }

  function handleDone() {
    const payload = buildSelectedPayload();

    // update cart line for this product + size
    setCart((prev: any[]) =>
      prev.map((line) => {
        const sameProduct = line.productId === productId;
        const sameSize = (line.sizeId || null) === (sizeId || null);
        if (sameProduct && sameSize) {
          return {
            ...line,
            modifiers: payload,
          };
        }
        return line;
      }),
    );

    navigation.goBack();
  }

  const selectedSummary = buildSelectedPayload();

  /* -------------------- RENDER -------------------- */

  return (
    <SafeAreaView style={styles.root}>
      {/* Top header */}
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>{'‹ Back'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {productName || 'Product'}
            {sizeName ? ` (${sizeName})` : ''}
          </Text>
          <Text style={styles.headerSub}>Modifiers</Text>
        </View>
      </View>

      {/* Tabs for groups */}
      <View style={styles.tabsContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {groups.map((g) => {
            const active = g.id === activeGroupId;
            return (
              <Pressable
                key={g.id}
                style={({ pressed }) => [
                  styles.tabItem,
                  active && styles.tabItemActive,
                  pressed && { opacity: 0.8 },
                ]}
                onPress={() => setActiveGroupId(g.id)}
              >
                <Text
                  style={[styles.tabText, active && styles.tabTextActive]}
                  numberOfLines={1}
                >
                  {g.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Content area */}
      <View style={styles.content}>
        {loading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" />
            <Text style={{ marginTop: 8, color: '#6b7280' }}>
              Loading modifiers...
            </Text>
          </View>
        )}

        {!loading && error && (
          <View style={styles.center}>
            <Text style={{ color: '#b91c1c' }}>{error}</Text>
          </View>
        )}

        {!loading && !error && !activeGroup && groups.length === 0 && (
          <View style={styles.center}>
            <Text style={{ color: '#6b7280' }}>
              No modifiers configured for this product.
            </Text>
          </View>
        )}

        {!loading && !error && activeGroup && (
          <ScrollView
            contentContainerStyle={styles.itemsGrid}
            showsVerticalScrollIndicator={false}
          >
            {activeGroup.items.map((item) => {
              const selectedFlag = isSelected(activeGroup.id, item.id);
              return (
                <Pressable
                  key={item.id}
                  style={({ pressed }) => [
                    styles.itemTile,
                    selectedFlag && styles.itemTileSelected,
                    pressed && { opacity: 0.9 },
                  ]}
                  onPress={() => toggleModifier(activeGroup.id, item.id)}
                >
                  <Text
                    style={[
                      styles.itemName,
                      selectedFlag && styles.itemNameSelected,
                    ]}
                    numberOfLines={2}
                  >
                    {item.name}
                  </Text>
                  {item.price != null && toMoney(item.price) !== '0.00' && (
                    <Text
                      style={[
                        styles.itemPrice,
                        selectedFlag && styles.itemPriceSelected,
                      ]}
                    >
                      {toMoney(item.price)}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* Bottom summary + DONE */}
      <View style={styles.bottomBar}>
        <View style={styles.summaryBox}>
          <Text style={styles.summaryTitle}>Selected:</Text>
          {selectedSummary.length === 0 ? (
            <Text style={styles.summaryEmpty}>No modifiers</Text>
          ) : (
            <ScrollView style={{ maxHeight: 70 }}>
              {selectedSummary.map((s, idx) => (
                <Text
                  key={idx.toString()}
                  style={styles.summaryItem}
                  numberOfLines={1}
                >
                  {s.groupName}: {s.itemName}
                </Text>
              ))}
            </ScrollView>
          )}
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.doneButton,
            pressed && { opacity: 0.8 },
          ]}
          onPress={handleDone}
        >
          <Text style={styles.doneText}>DONE</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/* -------------------- STYLES -------------------- */

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: {
    marginRight: 12,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  backText: {
    fontSize: 14,
    color: BLACK,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  headerSub: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },

  tabsContainer: {
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  tabItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#e5e7eb',
    marginRight: 8,
  },
  tabItemActive: {
    backgroundColor: BLACK,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  tabTextActive: {
    color: '#ffffff',
  },

  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingBottom: 24,
  },
  itemTile: {
    width: '30%',
    marginRight: 10,
    marginBottom: 10,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingHorizontal: 10,
    paddingVertical: 10,
    justifyContent: 'space-between',
  },
  itemTileSelected: {
    backgroundColor: BLACK,
    borderColor: BLACK,
  },
  itemName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  itemNameSelected: {
    color: '#ffffff',
  },
  itemPrice: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
  },
  itemPriceSelected: {
    color: '#e5e7eb',
  },

  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  summaryBox: {
    flex: 1,
    marginRight: 12,
  },
  summaryTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
  },
  summaryEmpty: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 4,
  },
  summaryItem: {
    fontSize: 12,
    color: '#111827',
  },
  doneButton: {
    minWidth: 100,
    borderRadius: 999,
    backgroundColor: BLACK,
    paddingHorizontal: 20,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  doneText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});
