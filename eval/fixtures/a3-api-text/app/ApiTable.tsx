interface Row {
  id: string;
}

// All visible text comes from the API/CMS at runtime — the source has zero
// literals, so text matching finds nothing. Only the structure identifies it.
export function ApiTable({ columns, rows }: { columns: string[]; rows: Row[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>{columns[0]}</th>
          <th>{columns[1]}</th>
          <th>{columns[2]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
