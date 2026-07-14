import { useEffect, useState } from "react";

import { DataTable } from "./DataTable";

export function UsersPage() {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    fetch("/api/users")
      .then((res) => res.json())
      .then((data) => setUsers(data));
  }, []);

  return (
    <section>
      <h1>Users</h1>
      <DataTable
        rows={users}
        columns={[
          { key: "name", header: "Name" },
          { key: "email", header: "Email" },
        ]}
      />
    </section>
  );
}
