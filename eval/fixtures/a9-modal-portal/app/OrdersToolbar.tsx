import { useState } from "react";
import { toast } from "react-hot-toast";

import { ConfirmDialog } from "./ConfirmDialog";

export function OrdersToolbar() {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = () => {
    fetch("/api/orders/selected", { method: "DELETE" });
    setConfirming(false);
    toast("Order deleted");
  };

  return (
    <div role="toolbar">
      <button onClick={() => setConfirming(true)}>Delete order</button>
      <ConfirmDialog open={confirming} onConfirm={handleConfirm} />
    </div>
  );
}
