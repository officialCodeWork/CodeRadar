import type { User } from "../hooks/useUsers";

export function UserCard({ user }: { user: User }) {
  const handleDelete = () => {
    fetch(`/api/users/${user.id}`, { method: "DELETE" });
  };

  return (
    <div title="User card">
      <strong>{user.name}</strong>
      <span>{user.email}</span>
      <button onClick={handleDelete}>Remove member</button>
    </div>
  );
}
