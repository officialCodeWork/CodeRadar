import { useUsers } from "../hooks/useUsers";
import { UserCard } from "./UserCard";

export function UserList() {
  const { users, loading } = useUsers();

  if (loading) return <p>Loading users…</p>;

  return (
    <section>
      <h2>Team Members</h2>
      <input placeholder="Search team members" />
      {users.map((user) => (
        <UserCard key={user.id} user={user} />
      ))}
    </section>
  );
}
