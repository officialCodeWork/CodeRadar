import { useEffect, useState } from "react";

// Post-rename version (the "current"/main graph). Same body as
// ../old/InvoiceCard.tsx, but the component is renamed InvoiceCard -> BillingCard
// and the file moved InvoiceCard.tsx -> BillingCard.tsx. A ticket resolved
// against the old graph must warn that the live definition is now BillingCard.
export function BillingCard() {
  const [rows, setRows] = useState<unknown[]>([]);

  useEffect(() => {
    fetch("/api/invoices")
      .then((res) => res.json())
      .then(setRows);
  }, []);

  return (
    <article>
      <h3>Invoice summary</h3>
      <p>{rows.length} line items</p>
    </article>
  );
}
