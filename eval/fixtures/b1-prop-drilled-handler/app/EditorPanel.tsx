import { Toolbar } from "./Toolbar";

/** Inline-arrow hop: the prop is wrapped, not passed directly. */
export function EditorPanel({ onPersist }: { onPersist: () => void }) {
  return (
    <section>
      <h2>Editor tools</h2>
      <Toolbar onSaveDraft={() => onPersist()} />
    </section>
  );
}
