// src/sync/wsClient.ts
import io, { Socket } from 'socket.io-client';
import NetInfo from '@react-native-community/netinfo';

export type CallcenterOrderPayload = {
  id: string;
  status: string;
  channel: string;
  branchId: string;
  createdAt: string;
};

type RegisterDevicePayload = {
  deviceId: string;
  branchId: string;
  token?: string;
};

let socket: Socket | null = null;
let isInitialized = false;

// all listeners interested in new/updated callcenter orders
const callcenterListeners = new Set<(order: CallcenterOrderPayload) => void>();

// 👉 adjust this URL to match your API host
const WS_BASE_URL = 'http://192.168.100.245:4000';

export function getSocket() {
  return socket;
}

export function initWebSocket(register: RegisterDevicePayload) {
  if (isInitialized && socket) {
    // already initialized; optionally re-emit register if needed
    return;
  }

  socket = io(WS_BASE_URL, {
    transports: ['websocket'],
  });

  isInitialized = true;

  socket.on('connect', () => {
    console.log('🔌 WS connected', socket?.id);
    socket?.emit('registerDevice', register);
  });

  // 🔔 Backend should emit this when a CALLCENTER order is created/updated
  // e.g. io.to(branchRoom).emit('callcenter:order', order);
  socket.on('callcenter:order', (order: CallcenterOrderPayload) => {
    // fan-out to all registered listeners in React land
    callcenterListeners.forEach((cb) => {
      try {
        cb(order);
      } catch (err) {
        console.warn('callcenter listener error', err);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('🔌 WS disconnected');
  });

  // auto-reconnect on network changes
  NetInfo.addEventListener((state) => {
    if (state.isConnected && socket && !socket.connected) {
      console.log('🌐 NetInfo -> reconnect WS');
      socket.connect();
    }
  });
}

// subscribe from React contexts/hooks
export function subscribeCallcenterOrders(
  cb: (order: CallcenterOrderPayload) => void
) {
  callcenterListeners.add(cb);
  return () => {
    callcenterListeners.delete(cb);
  };
}
