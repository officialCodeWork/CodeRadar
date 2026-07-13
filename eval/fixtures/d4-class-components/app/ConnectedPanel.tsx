declare function connect(mapState: unknown): <T>(component: T) => T;

function PanelInner({ items }: { items: string[] }) {
  return (
    <div>
      <h3>Connected panel body</h3>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

const mapState = (state: { items: string[] }) => ({ items: state.items });

export const Panel = connect(mapState)(PanelInner);

export function Dashboard() {
  return (
    <main>
      <h1>Legacy dashboard</h1>
      <Panel />
    </main>
  );
}
