import { lazy } from "react";
import type { RouteObject } from "react-router-dom";

import { Loadable } from "./loadable";
import { HomePage } from "./pages/HomePage";

// Loadable(lazy(() => import())) page elements — the exact field pattern that
// produced 0 route nodes in the v0.3.0 validation run.
const UsersPage = Loadable(lazy(() => import("./pages/UsersPage")));
const InvoicesPage = Loadable(lazy(() => import("./pages/InvoicesPage")));

// Route arrays composed across variables and spread together, not written
// inline at the createBrowserRouter call site.
const billingRoutes: RouteObject[] = [{ path: "invoices", element: <InvoicesPage /> }];

export const routes: RouteObject[] = [
  {
    path: "/",
    children: [
      { index: true, element: <HomePage /> },
      { path: "users", element: <UsersPage /> },
      ...billingRoutes,
    ],
  },
];
