import axios from "axios";
import { useEffect, useState } from "react";

import type { User } from "./types";

// Source 1 (generic): the response type is the call's type argument.
export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    axios.get<User[]>("/api/users").then((res) => setUsers(res.data));
  }, []);
  return (
    <div>
      <h1>Users</h1>
      {users.map((u) => (
        <p key={u.id}>{u.name}</p>
      ))}
    </div>
  );
}
