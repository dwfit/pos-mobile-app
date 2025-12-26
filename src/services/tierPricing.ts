// src/services/tierPricing.ts
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ||
  "http://192.168.100.245:4000";

async function getToken() {
  return (
    (await AsyncStorage.getItem("pos_token")) ||
    (await AsyncStorage.getItem("token")) ||
    ""
  );
}

function safeJsonParse(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function n(v: any): number {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Number.isFinite(x) ? x : 0;
}

export async function fetchActivePriceTiers() {
  const token = await getToken();
  const res = await fetch(`${API_BASE}/pricing/tiers?active=true`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  const text = await res.text().catch(() => "");
  const json = safeJsonParse(text);

  if (!res.ok) throw new Error(json?.message || `Failed (${res.status})`);
  return Array.isArray(json) ? json : [];
}

export type TierPricingForIdsResp = {
  sizesMap: Record<string, number>;
  modifierItemsMap: Record<string, number>;
};

// IMPORTANT: this URL must exist on the backend
export async function getTierPricingForIds(args: {
  tierId: string;
  productSizeIds: string[];
  modifierItemIds: string[];
}): Promise<{ sizesMap: Record<string, number>; modifierItemsMap: Record<string, number> }> {
  const token = await getToken();

  const res = await fetch(`${API_BASE}/pricing/tier-pricing`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      tierId: args.tierId,
      productSizeIds: args.productSizeIds || [],
      modifierItemIds: args.modifierItemIds || [],
    }),
  });

  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) throw new Error(json?.message || `Tier pricing failed (${res.status})`);

  return {
    sizesMap: json?.sizesMap || {},
    modifierItemsMap: json?.modifierItemsMap || {},
  };
}
