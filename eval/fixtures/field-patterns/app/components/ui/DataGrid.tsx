import { StatusBadge } from "./StatusBadge";

export function DataGrid({ rows }: { rows: string[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row}>
            <td>{row}</td>
            <td>
              <StatusBadge label="Active" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
