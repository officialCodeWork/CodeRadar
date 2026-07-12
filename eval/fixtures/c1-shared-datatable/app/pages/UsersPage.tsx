import { useEffect, useState } from "react";

import { DataTable } from "../components/DataTable";

export function UsersPage() {
  const [rows, setRows] = useState<Record<string, string>[]>([]);

  useEffect(() => {
    fetch("/api/users")
      .then((res) => res.json())
      .then(setRows);
  }, []);

  return (
    <main>
      <h1>All Users</h1>
      <DataTable
        rows={rows}
        columns={[
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
        ]}
      />
    </main>
  );
}
