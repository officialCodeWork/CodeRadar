import { create } from "zustand";

interface CartState {
  items: string[];
  load: () => Promise<void>;
}

export const useCartStore = create<CartState>((set) => ({
  items: [],
  load: async () => {
    const res = await fetch("/api/cart");
    set({ items: (await res.json()) as string[] });
  },
}));
