import { useSelector } from "react-redux";

/** No fetch of its own — the data arrived via the slice, populated at login. */
export function UserDirectory() {
  const users = useSelector((s: { users: { list: string[] } }) => s.users.list);

  return (
    <section>
      <h2>User directory</h2>
      <ul>
        {users.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>
    </section>
  );
}
