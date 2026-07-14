import { createBrowserRouter } from "react-router-dom";

import { BillingPage } from "./BillingPage";
import { NewBillingPage } from "./NewBillingPage";

export const router = createBrowserRouter([
  { path: "/billing", element: <BillingPage role="admin" /> },
  { path: "/billing/new", element: <NewBillingPage /> },
]);
