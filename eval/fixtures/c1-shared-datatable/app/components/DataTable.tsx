export interface Column {
  key: string;
  label: string;
}

export function DataTable({ rows, columns }: { rows: Record<string, string>[]; columns: Column[] }) {
  if (rows.length === 0) return <p>No records found</p>;

  return (
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col.key}>{row[col.key]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
