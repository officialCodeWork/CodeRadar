import { useDispatch } from "react-redux";
import { useNavigate } from "react-router-dom";

import { fetchUsers } from "../store/usersSlice";

interface Row {
  id: string;
  name: string;
}

export function UsersPage() {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const rows: Row[] = [];

  // Local handler dispatching a thunk → writes-state on the users slice.
  const refreshUsers = () => dispatch(fetchUsers());
  // Local handler issuing a fetch → triggers a data source.
  const exportUsers = () => fetch("/api/users/export", { method: "POST" });

  return (
    <section>
      <h1>All users</h1>
      <button onClick={refreshUsers}>Refresh</button>
      <button onClick={exportUsers}>Export</button>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            {/* Inline navigate with a computed param → /users/:id, shape-joined to the route. */}
            <button onClick={() => navigate(`/users/${row.id}`)}>{row.name}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
