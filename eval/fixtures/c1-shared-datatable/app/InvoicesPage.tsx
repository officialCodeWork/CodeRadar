import { useEffect, useState } from "react";

import { DataTable } from "./DataTable";

export function InvoicesPage() {
  const [invoices, setInvoices] = useState([]);

  useEffect(() => {
    fetch("/api/invoices")
      .then((res) => res.json())
      .then((data) => setInvoices(data));
  }, []);

  return (
    <section>
      <h1>Invoices</h1>
      <DataTable
        rows={invoices}
        columns={[
          { key: "number", header: "Invoice #" },
          { key: "amount", header: "Amount" },
        ]}
      />
    </section>
  );
}
