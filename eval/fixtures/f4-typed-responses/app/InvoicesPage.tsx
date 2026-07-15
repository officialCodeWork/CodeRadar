import { useEffect, useState } from "react";

import type { Invoice } from "./types";

// Source 2 (annotation): the response type is the annotation on the variable
// the fetch result lands in.
export function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  useEffect(() => {
    async function load() {
      const data: Invoice[] = await fetch("/api/invoices").then((r) => r.json());
      setInvoices(data);
    }
    void load();
  }, []);
  return (
    <div>
      <h1>Invoices</h1>
      {invoices.map((i) => (
        <p key={i.id}>{i.number}</p>
      ))}
    </div>
  );
}
