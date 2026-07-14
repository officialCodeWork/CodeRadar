import { useEffect, useState } from "react";

export function UsersPage() {
  const [users, setUsers] = useState<unknown[]>([]);
  useEffect(() => {
    fetch("/api/users").then((r) => r.json()).then(setUsers);
  }, []);
  return (
    <section>
      <h2>All users</h2>
      <ul>{users.length}</ul>
    </section>
  );
}
