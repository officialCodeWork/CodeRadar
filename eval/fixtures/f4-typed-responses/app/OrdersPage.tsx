import { useEffect, useState } from "react";

// Source 3 (OpenAPI): the code says nothing about the shape — the response type
// is recovered from the spec by matching GET /api/orders.
export function OrdersPage() {
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  useEffect(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then(setOrders);
  }, []);
  return (
    <div>
      <h1>Orders</h1>
      {orders.map((o, i) => (
        <p key={i}>{String(o.id)}</p>
      ))}
    </div>
  );
}
