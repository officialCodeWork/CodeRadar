export function SaveButton({ onSave }: { onSave: () => void }) {
  return (
    <button type="button" onClick={onSave}>
      Save draft
    </button>
  );
}
