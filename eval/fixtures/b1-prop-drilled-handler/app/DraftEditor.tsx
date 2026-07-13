import { EditorPanel } from "./EditorPanel";

export function DraftEditor() {
  const persistDraft = () => {
    fetch("/api/drafts", { method: "POST", body: "{}" });
  };

  return (
    <main>
      <h1>Draft editor</h1>
      <EditorPanel onPersist={persistDraft} />
    </main>
  );
}
