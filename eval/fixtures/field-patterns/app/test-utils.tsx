import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/** The app's custom render: every test goes through this providers wrapper. */
export function renderWithProviders(ui: ReactElement) {
  return render(<div className="providers">{ui}</div>);
}
