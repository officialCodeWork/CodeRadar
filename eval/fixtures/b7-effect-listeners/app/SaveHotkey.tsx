import { useHotkeys } from "react-hotkeys-hook";

export function SaveHotkey() {
  // Hotkey-library registration → an event sourced "hotkey" keyed "ctrl+s".
  useHotkeys("ctrl+s", () => fetch("/api/save", { method: "POST" }));

  return <span>Ctrl+S to save</span>;
}
