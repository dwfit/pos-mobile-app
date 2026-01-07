// App.tsx
import "react-native-gesture-handler";
import React, { useEffect, useState } from "react";

// ✅ SQLite init
import { initDatabase } from "./src/database/db";

// ✅ Online/offline monitor
import NetInfo from "@react-native-community/netinfo";

// STORAGE
import AsyncStorage from "@react-native-async-storage/async-storage";
import { syncClockAndTill } from "./src/sync/clockSync";

// SCREENS
import ActivateScreen from "./src/screens/ActivateScreen";
import HomeScreen from "./src/screens/HomeScreen";
import ClockInScreen from "./src/screens/ClockInScreen";
import CategoryScreen from "./src/screens/CategoryScreen";
import ProductsScreen from "./src/screens/ProductsScreen";
import ModifiersScreen from "./src/screens/ModifiersScreen";
import OrdersScreen from "./src/screens/OrdersScreen";
import DevicesScreen from "./src/screens/DevicesScreen";
import DeviceInfoScreen from "./src/screens/DeviceInfoScreen"; // ✅ NEW

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

  // ✅ GLOBAL till state
  const [tillOpen, setTillOpen] = useState(false);

  // Load initial value from storage on app start
  useEffect(() => {
    (async () => {
      try {
        const flag = await AsyncStorage.getItem("pos_till_opened");
        setTillOpen(flag === "1");
      } catch (e) {
        console.log("load till state error", e);
      }
    })();
  }, []);

  // Online / Offline
  const [online, setOnline] = useState(true);

  // =======================================================
  //      INITIALIZE APP (SQLite + Activation + WS + Sync)
  // =======================================================
  useEffect(() => {
    (async () => {
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
    })();

    // 4) Internet status watcher + clock/till sync
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = !!state.isConnected && !!state.isInternetReachable;
      setOnline(isOnline);

      if (isOnline) {
        // 🔁 whenever app comes online, try to sync clock/till
        syncClockAndTill().catch((e) =>
          console.log("syncClockAndTill failed", e)
        );
      }
    });

    return () => {
      unsub();
      // global WS stays alive for app lifecycle; no explicit cleanup
    };
  }, []);

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
      // Devices currently has no params → nothing else to store
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
        // from Devices back to Products
        setScreen("Products");
        return;
      }
      if (screen === "DeviceInfo") {
        // from Printer Info back to Devices
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
