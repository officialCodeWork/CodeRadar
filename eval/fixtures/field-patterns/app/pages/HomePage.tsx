import { useNavigate } from "react-router-dom";

export function HomePage() {
  const navigate = useNavigate();
  return (
    <main>
      <h1>Field Ops</h1>
      <button type="button" onClick={() => navigate("/users")}>
        View team
      </button>
    </main>
  );
}

export default HomePage;
