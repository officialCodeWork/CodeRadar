import { useEffect, useState } from "react";

// Pre-rename version (the "production" graph an agent resolves a ticket against).
// On main this definition is renamed AND moved — see ../new/BillingCard.tsx.
// The body is identical across versions, which is what lets diffRenames pair
// them by signature even though the name and file both change.
export function InvoiceCard() {
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
