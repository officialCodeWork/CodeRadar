import { useEffect, useState } from "react";

import { ENDPOINTS } from "./api/endpoints";

export function UsersPanel() {
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    fetch(ENDPOINTS.USERS)
      .then((res) => res.json())
      .then(setUsers);
  }, []);

  return (
    <section>
      <h2>User Directory</h2>
      <ul>
        {users.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>
    </section>
  );
}
