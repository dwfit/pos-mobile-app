import { create } from "zustand";

export type OrderType =
  | "DINE_IN"
  | "TAKEAWAY"
  | "DELIVERY"
  | "DRIVE_THRU"
  | null;

type OrderTypeState = {
  orderType: OrderType;
  setOrderType: (t: OrderType) => void;
};

export const useOrderTypeStore = create<OrderTypeState>((set) => ({
  orderType: null, // default
  setOrderType: (t) => set({ orderType: t }),
}));
