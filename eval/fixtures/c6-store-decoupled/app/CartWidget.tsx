import { useCartStore } from "./store/cartStore";

/** Zustand reader — the fetch lives inside the store's own load action. */
export function CartWidget() {
  const items = useCartStore((s) => s.items);

  return <span title="Cart items">{items.length} in cart</span>;
}
