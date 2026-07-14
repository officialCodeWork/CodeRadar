// A shared, presentational table. It owns no data of its own — every render
// site passes different rows/columns via props. This is the headline C1 case:
// a definition-level trace of DataTable finds no data sources, yet each
// instance is fed by a distinct endpoint.

interface Column {
  key: string;
  header: string;
}

export function DataTable({
  rows,
  columns,
}: {
  rows: Record<string, unknown>[];
  columns: Column[];
}) {
  return (
    <table>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col.key}>{String(row[col.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
