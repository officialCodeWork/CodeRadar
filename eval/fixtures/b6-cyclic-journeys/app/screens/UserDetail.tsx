import { useNavigate } from "react-router-dom";

export function UserDetail() {
  const navigate = useNavigate();

  // Navigate back to the list — the return edge that closes the cycle.
  const back = () => navigate("/users");
  const reload = () => fetch("/api/users/current");

  return (
    <article>
      <h1>User profile</h1>
      <button onClick={back}>Back to list</button>
      <button onClick={reload}>Reload</button>
    </article>
  );
}
