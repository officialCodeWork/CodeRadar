import { useState } from "react";
import { useDispatch } from "react-redux";

import { clearCart } from "../store/cartSlice";

export function CartPage() {
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);

  // Local setter → writes-state on the local useState slot.
  const showDetails = () => setOpen(true);

  return (
    <section>
      <h1>Your cart</h1>
      {/* Inline dispatch of a plain action → writes-state on the cart slice. */}
      <button onClick={() => dispatch(clearCart())}>Clear</button>
      <button onClick={showDetails}>Details</button>
      {open ? <p>Cart details</p> : null}
    </section>
  );
}
