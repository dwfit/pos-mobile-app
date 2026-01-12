// App.tsx
import "react-native-gesture-handler";
import React, { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

//  SQLite init
import { initDatabase } from "./src/database/db";

//  Online/offline monitor
import NetInfo from "@react-native-community/netinfo";

// STORAGE
import AsyncStorage from "@react-native-async-storage/async-storage";
import { syncClockAndTill } from "./src/sync/clockSync";

//  Permissions (professional: single global store)
import { useAuthStore } from "./src/store/authStore";

// SCREENS
import ActivateScreen from "./src/screens/ActivateScreen";
import HomeScreen from "./src/screens/HomeScreen";
import ClockInScreen from "./src/screens/ClockInScreen";
import CategoryScreen from "./src/screens/CategoryScreen";
import ProductsScreen from "./src/screens/ProductsScreen";
import ModifiersScreen from "./src/screens/ModifiersScreen";
import OrdersScreen from "./src/screens/OrdersScreen";
import DevicesScreen from "./src/screens/DevicesScreen";
import DeviceInfoScreen from "./src/screens/DeviceInfoScreen";

// PROVIDERS
import { CallcenterOrdersProvider } from "./src/context/CallcenterOrdersContext";

// 🔌 GLOBAL ORDERS WS (badge + sound)
import { initOrdersEvents } from "./src/lib/ordersEvents";

// ==== TYPES ===========================================

export type RootStackParamList = {
  Activate: undefined;
  Home: undefined;
  ClockIn: {
    branchName?: string;
    userName?: string;
  };
  Category: {
    branchName?: string;
    userName?: string;
  };
  Products: {
    categoryId: string;
    categoryName: string;
    branchName?: string;
    userName?: string;
  };
  Modifiers: {
    productId: string;
    productName: string;
    sizeId?: string | null;
    sizeName?: string | null;
  };
  Orders:
    | {
        mode?: "void" | "reopen";
        branchName?: string;
        userName?: string;
      }
    | undefined;

  // ✅ DEVICES LIST (popup)
  Devices: undefined;

  // ✅ DEVICE INFO (e.g. Printer Info)
  DeviceInfo: {
    mode: "create" | "edit";
    deviceType: string; // "Printer", "KDS", etc.
    deviceId?: string;
  };
};

type ScreenName = keyof RootStackParamList;

// =======================================================
//            START OF MAIN APP COMPONENT
// =======================================================

export default function App() {
  const [screen, setScreen] = useState<ScreenName | null>(null);

  // Params for navigation
  const [clockInParams, setClockInParams] =
    useState<RootStackParamList["ClockIn"]>({
      branchName: "",
      userName: "",
    });

  const [categoryParams, setCategoryParams] =
    useState<RootStackParamList["Category"]>({});

  const [productParams, setProductParams] =
    useState<RootStackParamList["Products"]>({
      categoryId: "",
      categoryName: "",
      branchName: "",
      userName: "",
    });

  const [modifierParams, setModifierParams] =
    useState<RootStackParamList["Modifiers"] | undefined>(undefined);

  const [ordersParams, setOrdersParams] =
    useState<RootStackParamList["Orders"]>(undefined);

  const [deviceInfoParams, setDeviceInfoParams] =
    useState<RootStackParamList["DeviceInfo"]>({
      mode: "create",
      deviceType: "Printer",
    });

  // Cart for POS
  const [cart, setCart] = useState<any[]>([]);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  // ✅ GLOBAL till state (single source of truth for all screens)
  const [tillOpen, setTillOpen] = useState(false);

  // Online / Offline
  const [online, setOnline] = useState(true);

  // =======================================================
  //      Helper: refresh till flag from storage
  // =======================================================
  async function refreshTillFlag() {
    try {
      const flag = await AsyncStorage.getItem("pos_till_opened");
      const next = flag === "1";
      setTillOpen(next);
    } catch (e) {
      console.log("refreshTillFlag error", e);
    }
  }

  // =======================================================
  //  ✅ Helper: refresh user/permissions immediately (ONLINE)
  // =======================================================
  // Goal: if admin updates role/permissions while device is online,
  // app pulls /auth/me quickly and updates UI without relogin.
  const authRefreshInFlightRef = useRef<Promise<void> | null>(null);

  async function refreshAuthNow(reason: string) {
    try {
      // Only when online (avoid noisy errors offline)
      if (!online) return;

      // de-dupe concurrent calls
      if (!authRefreshInFlightRef.current) {
        authRefreshInFlightRef.current = (async () => {
          try {
            await useAuthStore.getState().refresh(); // should call GET /auth/me
          } finally {
            authRefreshInFlightRef.current = null;
          }
        })();
      }
      await authRefreshInFlightRef.current;
    } catch (e) {
      // If refresh fails due to revoke, your api.ts interceptor should logout/clear.
      console.log("refreshAuthNow failed:", reason, e);
    }
  }

  // Load initial till value from storage on app start
  useEffect(() => {
    refreshTillFlag();
  }, []);

  // ✅ Keep till flag synced globally (NO React Navigation needed)
  useEffect(() => {
    // 1) when app comes foreground, refresh
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshTillFlag();
      }
    });

    // 2) small interval safety-net (handles till opened/closed in other screens)
    const timer = setInterval(refreshTillFlag, 1500);

    return () => {
      sub.remove();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =======================================================
  //      INITIALIZE APP (SQLite + Activation + WS + Sync)
  // =======================================================
  useEffect(() => {
    (async () => {
      // 0) ✅ Hydrate auth/permissions once (professional approach)
      // This loads pos_user permissions into global store (offline-friendly)
      try {
        await useAuthStore.getState().hydrate();
      } catch (e) {
        console.log("authStore.hydrate error", e);
      }

      // 1) Initialize local SQLite DB
      try {
        await initDatabase();
      } catch (e) {
        console.log("Failed to init SQLite database", e);
      }

      // 2) Restore activation state
      try {
        const activated = await AsyncStorage.getItem("deviceActivated");
        if (activated === "1") {
          setScreen("Home"); // still go to Home (PIN/login)
        } else {
          setScreen("Activate");
        }
      } catch (e) {
        console.log("Failed to read deviceActivated flag", e);
        setScreen("Activate");
      }

      // 3) ⭐ Start global orders WebSocket manager once for the whole app
      try {
        await initOrdersEvents();
      } catch (e) {
        console.log("initOrdersEvents error", e);
      }

      // 4) Ensure till flag is correct after init
      refreshTillFlag();

      // 5) ✅ If online at startup, refresh auth once (instant user update)
      refreshAuthNow("startup");
    })();

    // 6) Internet status watcher + clock/till sync + permission refresh
    const unsubNetInfo = NetInfo.addEventListener((state) => {
      const isOnline = !!state.isConnected && !!state.isInternetReachable;
      setOnline(isOnline);

      if (isOnline) {
        // 🔁 whenever app comes online, try to sync clock/till
        syncClockAndTill().catch((e) =>
          console.log("syncClockAndTill failed", e)
        );

        // ✅ Refresh permissions/profile from backend (GET /auth/me)
        refreshAuthNow("became-online");
      }
    });

    // 7) ✅ Foreground refresh: when user returns to app, pull latest perms immediately
    const unsubAppState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshAuthNow("foreground");
      }
    });

    return () => {
      unsubNetInfo();
      unsubAppState.remove();
      // global WS stays alive for app lifecycle; no explicit cleanup
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =======================================================
  // ✅ ONLINE "instant-ish" user updates (poll safety-net)
  // =======================================================
  // If you don't yet broadcast WS event for auth changes, this ensures
  // the app still updates within a few seconds while online.
  useEffect(() => {
    if (!online) return;

    // refresh quickly, but not too aggressive
    const timer = setInterval(() => {
      refreshAuthNow("online-poll");
    }, 8000);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // ⛔️ IMPORTANT: all hooks are above this line
  if (screen === null) return null;

  // =======================================================
  //       CUSTOM NAVIGATION HANDLER (NO HOOKS HERE)
  // =======================================================
  const navigation = {
    navigate: (name: ScreenName, params?: any) => {
      if (name === "ClockIn") setClockInParams(params || {});
      if (name === "Category") setCategoryParams(params || {});
      if (name === "Products") setProductParams(params || {});
      if (name === "Modifiers") setModifierParams(params || {});
      if (name === "Orders") setOrdersParams(params);
      if (name === "DeviceInfo") setDeviceInfoParams(params);
      setScreen(name);
    },

    replace: (name: ScreenName, params?: any) => {
      if (name === "ClockIn") setClockInParams(params || {});
      if (name === "Category") setCategoryParams(params || {});
      if (name === "Products") setProductParams(params || {});
      if (name === "Modifiers") setModifierParams(params || {});
      if (name === "Orders") setOrdersParams(params);
      if (name === "DeviceInfo") setDeviceInfoParams(params);
      setScreen(name);
    },

    reset: (config: {
      index: number;
      routes: { name: ScreenName; params?: any }[];
    }) => {
      const route = config.routes[config.index];

      if (route.name === "ClockIn") setClockInParams(route.params || {});
      if (route.name === "Category") setCategoryParams(route.params || {});
      if (route.name === "Products") setProductParams(route.params || {});
      if (route.name === "Modifiers") setModifierParams(route.params || {});
      if (route.name === "Orders") setOrdersParams(route.params);
      if (route.name === "DeviceInfo") setDeviceInfoParams(route.params);

      setScreen(route.name);
    },

    goBack: () => {
      if (screen === "Modifiers") {
        setScreen("Products");
        return;
      }
      if (screen === "Products") {
        setScreen("Category");
        return;
      }
      if (screen === "Category") {
        setScreen("Home");
        return;
      }
      if (screen === "ClockIn") {
        setScreen("Home");
        return;
      }
      if (screen === "Orders") {
        setScreen("Products");
        return;
      }
      if (screen === "Devices") {
        setScreen("Products");
        return;
      }
      if (screen === "DeviceInfo") {
        setScreen("Devices");
        return;
      }
    },
  };

  //   APP UI — SAME FEATURES, WRAPPED IN PROVIDER
  return (
    <CallcenterOrdersProvider>
      {screen === "Activate" && <ActivateScreen navigation={navigation} />}

      {screen === "Home" && (
        <HomeScreen navigation={navigation} online={online} />
      )}

      {screen === "ClockIn" && (
        <ClockInScreen
          navigation={navigation}
          route={{ params: clockInParams }}
          tillOpen={tillOpen}
          setTillOpen={setTillOpen}
        />
      )}

      {screen === "Category" && (
        <CategoryScreen
          navigation={navigation}
          route={{ params: categoryParams }}
          cart={cart}
          setCart={setCart}
          online={online}
          tillOpen={tillOpen}
          setTillOpen={setTillOpen}
        />
      )}

      {screen === "Products" && (
        <ProductsScreen
          navigation={navigation}
          route={{ params: productParams }}
          cart={cart}
          setCart={setCart}
          activeOrderId={activeOrderId}
          setActiveOrderId={setActiveOrderId}
          online={online}
          tillOpen={tillOpen}
          setTillOpen={setTillOpen}
        />
      )}

      {screen === "Modifiers" && (
        <ModifiersScreen
          navigation={navigation}
          route={{ params: modifierParams }}
          cart={cart}
          setCart={setCart}
          online={online}
        />
      )}

      {screen === "Orders" && (
        <OrdersScreen
          navigation={navigation}
          route={{ params: ordersParams }}
          cart={cart}
          setCart={setCart}
          setActiveOrderId={setActiveOrderId}
          online={online}
        />
      )}

      {screen === "Devices" && (
        <DevicesScreen navigation={navigation} online={online} />
      )}

      {screen === "DeviceInfo" && (
        <DeviceInfoScreen
          navigation={navigation}
          route={{ params: deviceInfoParams }}
        />
      )}
    </CallcenterOrdersProvider>
  );
}
