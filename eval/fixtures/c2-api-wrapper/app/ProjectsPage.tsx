import { useApi } from "./hooks/useApi";

export function ProjectsPage() {
  const projects = useApi("/projects") as unknown as string[];

  return (
    <main>
      <h1>Projects overview</h1>
      <ul>
        {projects.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </main>
  );
}
