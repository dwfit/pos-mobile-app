// src/context/CallcenterOrdersContext.tsx
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { get } from '../lib/api';
import { Audio } from 'expo-av';

import {
  initWebSocket,
  subscribeCallcenterOrders,
  CallcenterOrderPayload,
} from '../sync/wsClient';

type Order = {
  id: string;
  status: string;
  channel: string;
  branchId: string;
  createdAt: string;
  // ...you can add more if you want
};

type CallcenterOrdersContextValue = {
  orders: Order[];
  badgeCount: number;        // for tab bubble
  markAllViewed: () => void; // reset bubble when opening Orders
};

const CallcenterOrdersContext = createContext<
  CallcenterOrdersContextValue | undefined
>(undefined);

export function useCallcenterOrders() {
  const ctx = useContext(CallcenterOrdersContext);
  if (!ctx) {
    throw new Error('useCallcenterOrders must be used inside CallcenterOrdersProvider');
  }
  return ctx;
}

type Props = { children: ReactNode };

export function CallcenterOrdersProvider({ children }: Props) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [badgeCount, setBadgeCount] = useState(0);

  // Keep track of already-seen order IDs so we only “ding” on new ones
  const seenIdsRef = useRef<Set<string>>(new Set());

  // simple helper to play a notification sound
  async function playNewOrderSound() {
    try {
      const { sound } = await Audio.Sound.createAsync(
        // put an mp3/wav in src/assets/new-order.mp3 or adjust the path
        require('../assets/new-order.mp3')
      );
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
        }
      });
    } catch (err) {
      console.warn('Sound play error', err);
    }
  }

  // initial load + WebSocket subscription
  useEffect(() => {
    let cancelled = false;
    let unsubscribeWs: (() => void) | null = null;

    async function setup() {
      try {
        // read deviceInfo to get branchId & deviceId
        const raw = await AsyncStorage.getItem('deviceInfo');
        if (!raw) return;
        const dev = JSON.parse(raw || '{}');
        const branchId: string | undefined = dev?.branchId;
        const deviceId: string =
          dev?.deviceId || dev?.id || 'unknown-device';

        if (!branchId) return;

        // 1) Initial HTTP load (same logic as before)
        const qs =
          `?branchId=${encodeURIComponent(branchId)}` +
          `&status=ACTIVE&channel=CALLCENTER`;
        const data: Order[] = await get('/orders' + qs);

        if (cancelled) return;

        // Sort (optional)
        data.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

        // detect new orders vs seenIds
        const seen = seenIdsRef.current;
        const newOnes = data.filter((o) => !seen.has(o.id));

        if (newOnes.length > 0) {
          newOnes.forEach((o) => seen.add(o.id));
          seenIdsRef.current = new Set(seen);

          // bump badge count by number of new orders
          setBadgeCount((prev) => prev + newOnes.length);

          // play sound once for this batch
          await playNewOrderSound();
        }

        setOrders(data);

        // 2) Init WebSocket once we know branch + device
        initWebSocket({
          deviceId,
          branchId,
        });

        // 3) Subscribe to real-time CALLCENTER orders
        unsubscribeWs = subscribeCallcenterOrders(
          async (incoming: CallcenterOrderPayload) => {
            if (cancelled) return;

            // just in case server sends other branches or non-callcenter
            if (incoming.branchId !== branchId) return;
            if (incoming.channel !== 'CALLCENTER') return;
            if (incoming.status !== 'ACTIVE') {
              // if status changed away from ACTIVE, you might want to remove from list
              setOrders((prev) =>
                prev.filter((o) => o.id !== incoming.id)
              );
              return;
            }

            setOrders((prev) => {
              const exists = prev.find((o) => o.id === incoming.id);
              if (exists) {
                // update existing
                return prev.map((o) =>
                  o.id === incoming.id ? { ...o, ...incoming } : o
                );
              }
              // new order -> put on top
              return [{ ...incoming }, ...prev];
            });

            // 🔔 new order detection for sound + badge
            const seenSet = seenIdsRef.current;
            if (!seenSet.has(incoming.id)) {
              seenSet.add(incoming.id);
              seenIdsRef.current = new Set(seenSet);
              setBadgeCount((prev) => prev + 1);
              await playNewOrderSound();
            }
          }
        );
      } catch (err) {
        console.warn('CALLCENTER setup error', err);
      }
    }

    setup();

    return () => {
      cancelled = true;
      if (unsubscribeWs) unsubscribeWs();
    };
  }, []);

  function markAllViewed() {
    // when user opens Orders screen, reset badge to 0
    setBadgeCount(0);
  }

  return (
    <CallcenterOrdersContext.Provider
      value={{
        orders,
        badgeCount,
        markAllViewed,
      }}
    >
      {children}
    </CallcenterOrdersContext.Provider>
  );
}
