export function CartSummary({ count, total }: { count: number; total: string }) {
  return (
    <aside>
      <h2 style={{ textTransform: "uppercase" }}>Shopping cart</h2>
      <span>{`${count} items in cart`}</span>
      <strong>{`Total: ${total}`}</strong>
    </aside>
  );
}
