import { Button, DataGrid } from "@acme/ui";

export function SettingsPage() {
  return (
    <main>
      <h1>Workspace settings</h1>
      <DataGrid title="Team grid" />
      <Button label="Save changes" />
    </main>
  );
}
