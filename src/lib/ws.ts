// src/lib/ws.ts
// Frontend (React Native) WebSocket helpers for POS app

import { io, Socket } from 'socket.io-client';

// ⬇️ IMPORTANT: set this to your API server URL (same as you use for /orders, /pos/orders, etc.)
const WS_URL = 'http://192.168.100.245:4000'; // <--- change if your API is on a different host/port

let socket: Socket | null = null;

/* ------------------------------------------------------------------ */
/* Types – keep compatible with backend ws.ts                          */
/* ------------------------------------------------------------------ */

export type MenuEventPayload = {
  event:
    | 'MENU_UPDATED'
    | 'PRODUCT_UPDATED'
    | 'CATEGORY_UPDATED'
    | 'MODIFIERS_UPDATED';
  productId?: string;
  categoryId?: string;
  branchId?: string | null;
  [key: string]: any;
};

export type CallcenterOrderPayload = {
  id: string;
  status?: string;
  channel?: string;
  branchId?: string | null;
  createdAt?: string | Date | null;
  [key: string]: any;
};

/* ------------------------------------------------------------------ */
/* Core socket singleton                                              */
/* ------------------------------------------------------------------ */

function getSocket(): Socket {
  if (!socket) {
    socket = io(WS_URL, {
      transports: ['websocket'], // force WebSocket first
      reconnection: true,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      console.log('🔌 WS connected:', socket?.id);
    });

    socket.on('disconnect', (reason) => {
      console.log('🔌 WS disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      console.log('⚠️ WS connect_error:', err?.message);
    });
  }

  return socket;
}

/* ------------------------------------------------------------------ */
/* Menu events subscription (used by ModifiersScreen, etc.)           */
/* ------------------------------------------------------------------ */

type MenuSubscribeOptions = {
  productId?: string;
  onModifiersUpdated?: (payload: MenuEventPayload) => void;
  // You can add more callbacks later if needed, e.g. onMenuUpdated, onCategoryUpdated, etc.
};

/**
 * Subscribe to menu-related events from backend (MENU_UPDATED, MODIFIERS_UPDATED, etc).
 *
 * Usage in ModifiersScreen:
 *
 *   const unsubscribe = subscribeToMenuEvents({
 *     productId,
 *     onModifiersUpdated: async (payload) => { ... }
 *   });
 */
export function subscribeToMenuEvents(options: MenuSubscribeOptions) {
  const { productId, onModifiersUpdated } = options;
  const s = getSocket();

  const listener = (payload: MenuEventPayload) => {
    console.log('📩 menu:event', payload);

    // Only react to MODIFIERS_UPDATED for the matching productId (if provided)
    if (
      payload.event === 'MODIFIERS_UPDATED' &&
      onModifiersUpdated &&
      (!productId || payload.productId === productId)
    ) {
      onModifiersUpdated(payload);
    }
  };

  s.on('menu:event', listener);

  // cleanup for useEffect
  return () => {
    s.off('menu:event', listener);
  };
}

/* ------------------------------------------------------------------ */
/* Callcenter orders subscription (used by OrdersScreen / badges)     */
/* ------------------------------------------------------------------ */

/**
 * Listen for new/updated CallCenter orders from backend.
 * Optionally filter by branchId.
 */
export function subscribeToCallcenterOrders(
  handler: (payload: CallcenterOrderPayload) => void,
  branchId?: string | null
) {
  const s = getSocket();

  const listener = (payload: CallcenterOrderPayload) => {
    if (branchId && payload.branchId && payload.branchId !== branchId) {
      return; // ignore other branches
    }
    console.log('📩 callcenter:order', payload);
    handler(payload);
  };

  s.on('callcenter:order', listener);

  return () => {
    s.off('callcenter:order', listener);
  };
}

/* ------------------------------------------------------------------ */
/* Optional: expose raw socket if you need registerDevice elsewhere   */
/* ------------------------------------------------------------------ */

export function getWsInstance() {
  return getSocket();
}
