import { lazy } from "react";

import { Loadable } from "../loadable";

// The variable name differs from the definition name on purpose: only
// unwrapping the Loadable(lazy(() => import())) chain can link this usage.
const Invoices = Loadable(lazy(() => import("./InvoicesPage")));

export function PreviewPane() {
  return (
    <aside>
      <h2>Preview</h2>
      <Invoices />
    </aside>
  );
}
