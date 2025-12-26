// src/store/priceTierStore.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

/* ============================= Types ============================= */

export type PriceTier = {
  id: string;
  name: string;
  code?: string | null;
  isActive?: boolean;
};

export type TierPricingCache = {
  // productSizeId -> override price
  sizePriceBySizeId: Record<string, number>;
  // modifierItemId -> override price
  modifierPriceByItemId: Record<string, number>;
  // meta
  tierId: string;
  updatedAt: string;
};

/* ============================= Storage Keys ============================= */

const STORAGE_SELECTED_TIER = "pos_selected_price_tier"; // {id,name}
const STORAGE_TIER_CACHE_PREFIX = "pos_tier_cache_"; // + tierId

function n(v: any): number {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Number.isFinite(x) ? x : 0;
}

/* ============================= AsyncStorage helpers ============================= */

export async function loadSelectedTier(): Promise<{ id: string; name: string } | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SELECTED_TIER);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj?.id && obj?.name) return { id: String(obj.id), name: String(obj.name) };
    return null;
  } catch {
    return null;
  }
}

export async function saveSelectedTier(tier: { id: string; name: string } | null) {
  try {
    if (!tier) {
      await AsyncStorage.removeItem(STORAGE_SELECTED_TIER);
      return;
    }
    await AsyncStorage.setItem(
      STORAGE_SELECTED_TIER,
      JSON.stringify({ id: String(tier.id), name: String(tier.name) })
    );
  } catch {
    // ignore
  }
}

export async function loadTierCache(tierId: string): Promise<TierPricingCache | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_TIER_CACHE_PREFIX + tierId);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.tierId) return null;

    return {
      tierId: String(obj.tierId),
      updatedAt: String(obj.updatedAt || new Date().toISOString()),
      sizePriceBySizeId: obj.sizePriceBySizeId || {},
      modifierPriceByItemId: obj.modifierPriceByItemId || {},
    };
  } catch {
    return null;
  }
}

export async function saveTierCache(cache: TierPricingCache) {
  try {
    const safe: TierPricingCache = {
      tierId: String(cache.tierId),
      updatedAt: cache.updatedAt || new Date().toISOString(),
      sizePriceBySizeId: cache.sizePriceBySizeId || {},
      modifierPriceByItemId: cache.modifierPriceByItemId || {},
    };
    await AsyncStorage.setItem(
      STORAGE_TIER_CACHE_PREFIX + safe.tierId,
      JSON.stringify(safe)
    );
  } catch {
    // ignore
  }
}

export async function clearTierCache(tierId: string) {
  try {
    await AsyncStorage.removeItem(STORAGE_TIER_CACHE_PREFIX + tierId);
  } catch {
    // ignore
  }
}

export function mergeTierCache(
  prev: TierPricingCache,
  incoming: {
    sizeOverrides?: Array<{ productSizeId: string; price: any }>;
    modifierOverrides?: Array<{ modifierItemId: string; price: any }>;
  }
): TierPricingCache {
  const next: TierPricingCache = {
    ...prev,
    sizePriceBySizeId: { ...(prev.sizePriceBySizeId || {}) },
    modifierPriceByItemId: { ...(prev.modifierPriceByItemId || {}) },
  };

  for (const row of incoming.sizeOverrides || []) {
    if (!row?.productSizeId) continue;
    const price = n(row.price);
    // only store if override exists (>0). If you allow 0, remove this condition.
    if (price > 0) next.sizePriceBySizeId[String(row.productSizeId)] = price;
  }

  for (const row of incoming.modifierOverrides || []) {
    if (!row?.modifierItemId) continue;
    const price = n(row.price);
    if (price > 0) next.modifierPriceByItemId[String(row.modifierItemId)] = price;
  }

  next.updatedAt = new Date().toISOString();
  return next;
}

/* ============================= ✅ Zustand store ============================= */

type PriceTierState = {
  // selected tier (persisted)
  activeTier: { id: string; name: string } | null;
  setActiveTier: (tier: { id: string; name: string } | null) => void;

  // in-memory cache for fast pricing lookups (tierId -> cache)
  cacheByTierId: Record<string, TierPricingCache>;
  setTierCache: (tierId: string, cache: TierPricingCache) => void;
  clearTierCacheMem: (tierId: string) => void;

  // init from AsyncStorage
  hydrate: () => Promise<void>;
};

export const usePriceTierStore = create<PriceTierState>((set, get) => ({
  activeTier: null,

  setActiveTier: (tier) => {
    set({ activeTier: tier });
    // persist selection (fire and forget)
    saveSelectedTier(tier).catch(() => { });
  },

  cacheByTierId: {},

  setTierCache: (tierId, cache) => {
    set((s) => ({ cacheByTierId: { ...s.cacheByTierId, [tierId]: cache } }));
  },

  clearTierCacheMem: (tierId) => {
    set((s) => {
      const next = { ...s.cacheByTierId };
      delete next[tierId];
      return { cacheByTierId: next };
    });
  },

  hydrate: async () => {
    const tier = await loadSelectedTier();
    if (tier) set({ activeTier: tier });

    // optionally: preload cache for selected tier
    if (tier?.id) {
      const cache = await loadTierCache(tier.id);
      if (cache) get().setTierCache(tier.id, cache);
    }
  },
}));

/* ============================= Convenience helpers ============================= */

// ✅ Use outside React components
export const setActivePriceTier = (tier: { id: string; name: string } | null) =>
  usePriceTierStore.getState().setActiveTier(tier);

// ✅ Read current tier anywhere
export const getActivePriceTier = () => usePriceTierStore.getState().activeTier;

// ✅ Get override price helpers (useful in cart calculations)
export const getTierSizeOverridePrice = (tierId: string, productSizeId: string) => {
  const cache = usePriceTierStore.getState().cacheByTierId[tierId];
  const p = cache?.sizePriceBySizeId?.[String(productSizeId)];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};

export const getTierModifierOverridePrice = (tierId: string, modifierItemId: string) => {
  const cache = usePriceTierStore.getState().cacheByTierId[tierId];
  const p = cache?.modifierPriceByItemId?.[String(modifierItemId)];
  return typeof p === "number" && Number.isFinite(p) ? p : null;
};
