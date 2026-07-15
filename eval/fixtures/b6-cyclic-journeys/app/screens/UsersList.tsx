import { useNavigate } from "react-router-dom";

interface User {
  id: string;
  name: string;
}

export function UsersList() {
  const navigate = useNavigate();
  const users: User[] = [];

  const refresh = () => fetch("/api/users");

  return (
    <section>
      <h1>All users</h1>
      <button onClick={refresh}>Refresh</button>
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {/* Navigate into the detail page — the forward edge of the loop. */}
            <button onClick={() => navigate(`/users/${user.id}`)}>{user.name}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
