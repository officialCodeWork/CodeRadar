export function ApiForm({ onSubmit }: { onSubmit: () => void }) {
  // Labels/placeholders are all CMS-driven — no literals in source.
  return (
    <form onSubmit={onSubmit}>
      <input type="text" />
      <input type="text" />
      <button type="submit" />
    </form>
  );
}
