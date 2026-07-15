export function OrdersPanel({
  orders,
  error,
  isAdmin,
}: {
  orders: string[];
  error: boolean;
  isAdmin: boolean;
}) {
  if (error) return <p>Could not load orders</p>;
  if (orders.length === 0) return <p>No orders yet</p>;

  return (
    <section>
      <h2>Recent orders</h2>
      <ul>
        {orders.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
      {isAdmin && <button>Export orders</button>}
      <span>{orders.length > 10 ? "Large order book" : "Small order book"}</span>
    </section>
  );
}
