import { SaveButton } from "./SaveButton";

/** Renamed hop: the prop arrives as onSaveDraft, is passed down as onSave. */
export function Toolbar({ onSaveDraft }: { onSaveDraft: () => void }) {
  return (
    <div role="toolbar">
      <SaveButton onSave={onSaveDraft} />
    </div>
  );
}
