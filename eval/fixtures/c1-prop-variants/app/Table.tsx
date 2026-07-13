export function Table({ rows }: { rows: string[] }) {
  if (rows.length === 0) return <p>Nothing to show</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}
