export function OrphanButton({ onMystery }: { onMystery?: () => void }) {
  return (
    <button type="button" onClick={onMystery}>
      Mystery action
    </button>
  );
}

/** Renders OrphanButton without ever passing the handler — must flag, not guess. */
export function OrphanHost() {
  return (
    <div>
      <h3>Orphan host</h3>
      <OrphanButton />
    </div>
  );
}
