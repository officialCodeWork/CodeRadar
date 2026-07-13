import { apiClient } from "./api/client";

export function CreateProjectButton() {
  const handleCreate = () => {
    apiClient.post("/projects", { name: "Untitled" });
  };

  return <button onClick={handleCreate}>New project</button>;
}
