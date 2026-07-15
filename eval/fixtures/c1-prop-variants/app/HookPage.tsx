import { useMembers } from "./hooks/useMembers";
import { Table } from "./Table";

export function HookPage() {
  const { members } = useMembers();

  return (
    <main>
      <h1>Member rows</h1>
      <Table rows={members} />
    </main>
  );
}
