// src/store/cartStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CartItem = {
  key: string;        // unique line key: productId+sizeId etc
  productId: string;
  sizeId?: string | null;
  name: string;
  unitPrice: number;
  qty: number;
  imageUrl?: string | null;
};

type CartState = {
  items: CartItem[];
  addItem: (item: Omit<CartItem, "qty" | "key"> & { qty?: number }) => void;
  setQty: (key: string, qty: number) => void;
  removeItem: (key: string) => void;
  clearCart: () => void;
  total: number;
};

function makeKey(productId: string, sizeId?: string | null) {
  return `${productId}:${sizeId || "default"}`;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      total: 0,

      addItem: (item) => {
        const key = makeKey(item.productId, item.sizeId);
        const qtyToAdd = item.qty ?? 1;

        const prev = get().items;
        const existing = prev.find((i) => i.key === key);

        let next: CartItem[];
        if (existing) {
          next = prev.map((i) =>
            i.key === key ? { ...i, qty: i.qty + qtyToAdd } : i
          );
        } else {
          next = [
            ...prev,
            {
              key,
              productId: item.productId,
              sizeId: item.sizeId ?? null,
              name: item.name,
              unitPrice: item.unitPrice,
              imageUrl: item.imageUrl ?? null,
              qty: qtyToAdd,
            },
          ];
        }

        const total = next.reduce(
          (sum, i) => sum + i.unitPrice * i.qty,
          0
        );

        set({ items: next, total });
      },

      setQty: (key, qty) => {
        const prev = get().items;
        let next: CartItem[];

        if (qty <= 0) {
          next = prev.filter((i) => i.key !== key);
        } else {
          next = prev.map((i) =>
            i.key === key ? { ...i, qty } : i
          );
        }

        const total = next.reduce(
          (sum, i) => sum + i.unitPrice * i.qty,
          0
        );

        set({ items: next, total });
      },

      removeItem: (key) => {
        const next = get().items.filter((i) => i.key !== key);
        const total = next.reduce(
          (sum, i) => sum + i.unitPrice * i.qty,
          0
        );
        set({ items: next, total });
      },

      clearCart: () => set({ items: [], total: 0 }),
    }),
    {
      name: "pos-cart", // AsyncStorage key
    }
  )
);
