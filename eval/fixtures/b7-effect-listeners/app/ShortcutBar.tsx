import { useEffect } from "react";

export function ShortcutBar() {
  useEffect(() => {
    // addEventListener inside an effect → an event sourced "effect".
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "s") fetch("/api/save", { method: "POST" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <div>Press S to save</div>;
}
