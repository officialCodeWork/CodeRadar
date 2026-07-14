import { useEffect, useState } from "react";

export function OrderDetail({ orderId, entity }: { orderId: string; entity: string }) {
  const [order, setOrder] = useState<Record<string, string> | null>(null);
  const [related, setRelated] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/orders/${orderId}`)
      .then((res) => res.json())
      .then(setOrder);
    fetch(`/api/${entity}/list`)
      .then((res) => res.json())
      .then(setRelated);
  }, [orderId, entity]);

  return (
    <article>
      <h1>Order detail</h1>
      <p>{order?.status}</p>
      <ul>
        {related.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </article>
  );
}
