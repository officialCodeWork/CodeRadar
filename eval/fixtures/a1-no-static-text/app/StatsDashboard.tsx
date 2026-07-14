interface Stat {
  id: string;
  label: string;
  value: number;
}
interface Row {
  id: string;
}

// A dashboard with zero static text — a card grid over a 4-column table. It can
// only be matched by structure (Phase 4.2).
export function StatsDashboard({ stats, rows }: { stats: Stat[]; rows: Row[] }) {
  return (
    <div>
      <div>
        {stats.map((s) => (
          <article key={s.id}>
            <span>{s.label}</span>
            <strong>{s.value}</strong>
          </article>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th></th>
            <th></th>
            <th></th>
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
    </div>
  );
}
