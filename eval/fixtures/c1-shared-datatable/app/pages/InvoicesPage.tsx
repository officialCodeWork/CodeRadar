import { useEffect, useState } from "react";

import { DataTable } from "../components/DataTable";

export function InvoicesPage() {
  const [rows, setRows] = useState<Record<string, string>[]>([]);

  useEffect(() => {
    fetch("/api/invoices")
      .then((res) => res.json())
      .then(setRows);
  }, []);

  return (
    <main>
      <h1>All Invoices</h1>
      <DataTable
        rows={rows}
        columns={[
          { key: "number", label: "Invoice Number" },
          { key: "total", label: "Total" },
        ]}
      />
    </main>
  );
}
