import { createPortal } from "react-dom";

export function ConfirmDialog({
  open,
  onConfirm,
}: {
  open: boolean;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <div role="dialog">
      <h2>Delete this order?</h2>
      <p>This cannot be undone.</p>
      <button onClick={onConfirm}>Confirm delete</button>
    </div>,
    document.body,
  );
}
