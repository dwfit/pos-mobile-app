// src/lib/ordersEvents.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { io, Socket } from "socket.io-client";
import { useAuthStore } from "../store/authStore";

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "http://192.168.100.245:4000";

type OrdersChangedPayload = {
  orderId?: string;
  branchId?: string;
  channel?: string;
  status?: string;
  action?: "created" | "updated";
};

// ✅ Auth events payload (admin updates user role/permissions)
type AuthUserUpdatedPayload = {
  userId?: string;
  branchId?: string;
  reason?: string; // optional
};

let socket: Socket | null = null;
let initialized = false;

// ---------------- BADGE STATE ----------------

let badgeCount = 0;

type BadgeListener = (count: number) => void;
const badgeListeners = new Set<BadgeListener>();

function notifyBadgeListeners() {
  for (const fn of badgeListeners) {
    try {
      fn(badgeCount);
    } catch (e) {
      console.log("badge listener error", e);
    }
  }
}

async function setBadgeCount(next: number) {
  badgeCount = next < 0 ? 0 : next;

  try {
    await AsyncStorage.setItem("newOrdersCount", String(badgeCount));
  } catch (e) {
    console.log("save newOrdersCount error", e);
  }

  notifyBadgeListeners();
}

// called from OrdersScreen after full /orders sync (recalc from list)
export async function updateGlobalBadgeFromOrders(orders: any[]) {
  const count = Array.isArray(orders)
    ? orders.filter(
        (o) =>
          String(o.channel || "").toUpperCase() === "CALLCENTER" &&
          String(o.status || "").toUpperCase() === "PENDING"
      ).length
    : 0;

  console.log("🔔 OrdersScreen updateGlobalBadgeFromOrders →", count);
  await setBadgeCount(count);
}

// when user opens OrdersScreen & "reads" all
export async function resetOrdersBadge() {
  await setBadgeCount(0);
}

// for screens to read initial value without waiting for effect
export function getCurrentBadgeCount() {
  return badgeCount;
}

// screens subscribe to badge changes
export function subscribeOrdersEvents(
  event: "badge-changed",
  listener: (count: number) => void
): () => void {
  if (event !== "badge-changed") {
    // we only support badge for now
    return () => {};
  }

  badgeListeners.add(listener);

  // push current value immediately so UI is in sync
  listener(badgeCount);

  return () => {
    badgeListeners.delete(listener);
  };
}

// ---------------- SOCKET SETUP ----------------

let rawListeners = new Set<(payload: OrdersChangedPayload) => void>();

export function subscribeOrdersChanged(
  listener: (payload: OrdersChangedPayload) => void
): () => void {
  rawListeners.add(listener);
  return () => rawListeners.delete(listener);
}

// ✅ Prevent multiple refresh calls at same time
let authRefreshPromise: Promise<void> | null = null;
async function refreshAuthNow(reason: string) {
  try {
    // Only refresh if we have a logged in user
    const current = useAuthStore.getState().user;
    if (!current?.id) return;

    if (!authRefreshPromise) {
      authRefreshPromise = (async () => {
        try {
          // This should call GET /auth/me inside authStore.refresh()
          await useAuthStore.getState().refresh();
          console.log("🔐 auth refreshed (ordersEvents):", reason);
        } finally {
          authRefreshPromise = null;
        }
      })();
    }
    await authRefreshPromise;
  } catch (e) {
    // If refresh fails due to revoke, your api.ts should force logout/clear.
    console.log("🔐 auth refresh failed (ordersEvents):", reason, e);
  }
}

function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });

    socket.on("connect", async () => {
      console.log("🔌 WS connected (ordersEvents):", socket?.id);

      // ✅ Always re-register on reconnect
      await registerPosDeviceOnSocket();

      // ✅ When reconnect happens and we're online, pull latest user/permissions
      // (covers case admin updated user while device was offline)
      refreshAuthNow("ws-connect");
    });

    socket.on("disconnect", (reason) => {
      console.log("⚠️ WS disconnected (ordersEvents):", reason);
    });

    socket.on("connect_error", (err) => {
      console.log("❌ WS connect_error (ordersEvents):", err?.message);
    });
  }
  return socket;
}

async function registerPosDeviceOnSocket() {
  try {
    const raw = await AsyncStorage.getItem("deviceInfo");
    if (!raw) {
      console.log("WS register (ordersEvents): no deviceInfo in storage");
      return;
    }
    const dev = JSON.parse(raw);
    const branchId = dev.branchId;
    const deviceId = dev.id || dev.deviceId;

    if (!branchId || !deviceId) {
      console.log("WS register: missing branchId/deviceId", { branchId, deviceId });
      return;
    }

    const s = getSocket();
    s.emit("pos:register", { deviceId, branchId });
    console.log("📡 pos:register sent (ordersEvents)", { deviceId, branchId });
  } catch (e) {
    console.log("registerPosDeviceOnSocket error", e);
  }
}

function handleOrdersChanged(payload: OrdersChangedPayload) {
  console.log("🛰  WS orders:changed (ordersEvents)", payload);

  // 1) Notify raw listeners (OrdersScreen uses this to SYNC)
  for (const fn of rawListeners) {
    try {
      fn(payload);
    } catch (e) {
      console.log("raw listener error", e);
    }
  }

  // 2) Update global badge for new CALLCENTER PENDING orders
  const ch = String(payload.channel || "").toUpperCase();
  const st = String(payload.status || "").toUpperCase();
  const isNew = payload.action === "created";

  if (ch === "CALLCENTER" && st === "PENDING" && isNew) {
    // unread +1
    setBadgeCount(badgeCount + 1);
  }
}

// ✅ When server tells us "this user updated", refresh /auth/me immediately
function handleAuthUserUpdated(payload: AuthUserUpdatedPayload) {
  try {
    const current = useAuthStore.getState().user;
    if (!current?.id) return;

    const targetUserId = payload?.userId;
    if (!targetUserId) {
      // if server doesn't send userId, safest is refresh anyway
      refreshAuthNow("auth:user-updated(no-userId)");
      return;
    }

    if (String(targetUserId) === String(current.id)) {
      console.log("🧩 WS auth:user-updated for current user:", payload);
      refreshAuthNow("auth:user-updated");
    }
  } catch (e) {
    console.log("handleAuthUserUpdated error", e);
  }
}

// call once from App.tsx
export async function initOrdersEvents() {
  if (initialized) return;
  initialized = true;

  // load last persisted badge
  try {
    const raw = await AsyncStorage.getItem("newOrdersCount");
    badgeCount = raw ? Number(raw) || 0 : 0;
  } catch (e) {
    console.log("read newOrdersCount error", e);
    badgeCount = 0;
  }

  notifyBadgeListeners(); // push initial value to any early listeners

  // ensure socket exists before register (it will queue if not connected yet)
  const s = getSocket();

  // register once (and also auto re-register on reconnect in socket.on('connect'))
  await registerPosDeviceOnSocket();

  // Orders updates
  s.on("orders:changed", handleOrdersChanged);

  // ✅ Auth updates (role/permissions/profile changed)
  // Backend should emit this event when admin updates user or revokes role.
  s.on("auth:user-updated", handleAuthUserUpdated);

  // Optional: if you want a global "refresh me" ping without userId
  
}
