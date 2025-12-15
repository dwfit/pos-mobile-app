// App.tsx
import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';

// ✅ SQLite init
import { initDatabase } from './src/database/db';

// ✅ Online/offline monitor
import NetInfo from '@react-native-community/netinfo';

// STORAGE
import AsyncStorage from '@react-native-async-storage/async-storage';

// SCREENS
import ActivateScreen from './src/screens/ActivateScreen';
import HomeScreen from './src/screens/HomeScreen';
import CategoryScreen from './src/screens/CategoryScreen';
import ProductsScreen from './src/screens/ProductsScreen';
import ModifiersScreen from './src/screens/ModifiersScreen';
import OrdersScreen from './src/screens/OrdersScreen';

// PROVIDERS
import { CallcenterOrdersProvider } from './src/context/CallcenterOrdersContext';

// 🔌 GLOBAL ORDERS WS (badge + sound)
import { initOrdersEvents } from './src/lib/ordersEvents'; // <-- updated helper

// ==== TYPES ===========================================

export type RootStackParamList = {
  Activate: undefined;
  Home: undefined;
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
        mode?: 'void' | 'reopen';
        branchName?: string;
        userName?: string;
      }
    | undefined;
};

type ScreenName = keyof RootStackParamList;

// =======================================================
//            START OF MAIN APP COMPONENT
// =======================================================

export default function App() {
  const [screen, setScreen] = useState<ScreenName | null>(null);

  // Params for navigation
  const [categoryParams, setCategoryParams] =
    useState<RootStackParamList['Category']>({});

  const [productParams, setProductParams] =
    useState<RootStackParamList['Products']>({
      categoryId: '',
      categoryName: '',
      branchName: '',
      userName: '',
    });

  const [modifierParams, setModifierParams] =
    useState<RootStackParamList['Modifiers'] | undefined>(undefined);

  const [ordersParams, setOrdersParams] =
    useState<RootStackParamList['Orders']>(undefined);

  // Cart for POS
  const [cart, setCart] = useState<any[]>([]);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);

  // Online / Offline
  const [online, setOnline] = useState(true);

  // =======================================================
  //      INITIALIZE APP (SQLite + Activation + WS)
  // =======================================================
  useEffect(() => {
    (async () => {
      // 1) Initialize local SQLite DB
      try {
        await initDatabase();
      } catch (e) {
        console.log('Failed to init SQLite database', e);
      }

      // 2) Restore activation state
      try {
        const activated = await AsyncStorage.getItem('deviceActivated');
        if (activated === '1') {
          setScreen('Home');
        } else {
          setScreen('Activate');
        }
      } catch (e) {
        console.log('Failed to read deviceActivated flag', e);
        setScreen('Activate');
      }

      // 3) ⭐ Start global orders WebSocket manager once for the whole app
      //    - Handles pos:register
      //    - Listens to orders:changed
      //    - Updates newOrdersCount in AsyncStorage
      //    - Plays sound for new callcenter pending orders
      try {
        await initOrdersEvents();
      } catch (e) {
        console.log('initOrdersEvents error', e);
      }
    })();

    // 4) Internet status watcher
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = !!state.isConnected && !!state.isInternetReachable;
      setOnline(isOnline);
    });

    return () => {
      unsub();
      // global WS stays alive for app lifecycle; no explicit cleanup
    };
  }, []);

  if (screen === null) return null;

  // =======================================================
  //       CUSTOM NAVIGATION HANDLER (YOUR ORIGINAL)
  // =======================================================
  const navigation = {
    navigate: (name: ScreenName, params?: any) => {
      if (name === 'Category') setCategoryParams(params || {});
      if (name === 'Products') setProductParams(params || {});
      if (name === 'Modifiers') setModifierParams(params || {});
      if (name === 'Orders') setOrdersParams(params);
      setScreen(name);
    },

    replace: (name: ScreenName, params?: any) => {
      if (name === 'Category') setCategoryParams(params || {});
      if (name === 'Products') setProductParams(params || {});
      if (name === 'Modifiers') setModifierParams(params || {});
      if (name === 'Orders') setOrdersParams(params);
      setScreen(name);
    },

    reset: (config: {
      index: number;
      routes: { name: ScreenName; params?: any }[];
    }) => {
      const route = config.routes[config.index];

      if (route.name === 'Category') setCategoryParams(route.params || {});
      if (route.name === 'Products') setProductParams(route.params || {});
      if (route.name === 'Modifiers') setModifierParams(route.params || {});
      if (route.name === 'Orders') setOrdersParams(route.params);

      setScreen(route.name);
    },

    goBack: () => {
      if (screen === 'Modifiers') {
        setScreen('Products');
        return;
      }
      if (screen === 'Products') {
        setScreen('Category');
        return;
      }
      if (screen === 'Category') {
        setScreen('Home');
        return;
      }
      if (screen === 'Orders') {
        setScreen('Products');
        return;
      }
    },
  };

  // =======================================================
  //     APP UI — SAME FEATURES, WRAPPED IN PROVIDER
  // =======================================================
  return (
    <CallcenterOrdersProvider>
      {screen === 'Activate' && <ActivateScreen navigation={navigation} />}

      {screen === 'Home' && (
        <HomeScreen navigation={navigation} online={online} />
      )}

      {screen === 'Category' && (
        <CategoryScreen
          navigation={navigation}
          route={{ params: categoryParams }}
          cart={cart}
          setCart={setCart}
          online={online}
        />
      )}

      {screen === 'Products' && (
        <ProductsScreen
          navigation={navigation}
          route={{ params: productParams }}
          cart={cart}
          setCart={setCart}
          activeOrderId={activeOrderId}
          setActiveOrderId={setActiveOrderId}
          online={online}
        />
      )}

      {screen === 'Modifiers' && (
        <ModifiersScreen
          navigation={navigation}
          route={{ params: modifierParams }}
          cart={cart}
          setCart={setCart}
          online={online}
        />
      )}

      {screen === 'Orders' && (
        <OrdersScreen
          navigation={navigation}
          route={{ params: ordersParams }}
          cart={cart}
          setCart={setCart}
          setActiveOrderId={setActiveOrderId}
          online={online}
        />
      )}
    </CallcenterOrdersProvider>
  );
}
