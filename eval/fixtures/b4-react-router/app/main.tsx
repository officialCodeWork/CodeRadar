import { createBrowserRouter } from "react-router-dom";

import { RequireAuth } from "./RequireAuth";
import { RootLayout } from "./RootLayout";
import { AdminPanel } from "./pages/AdminPanel";
import { AuditLog } from "./pages/AuditLog";
import { HomePage } from "./pages/HomePage";
import { UserDetail } from "./pages/UserDetail";
import { UsersPage } from "./pages/UsersPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "users", element: <UsersPage /> },
      { path: "users/:userId", element: <UserDetail /> },
      {
        // Pathless guard route: everything below requires auth.
        element: <RequireAuth />,
        children: [{ path: "admin", element: <AdminPanel /> }],
      },
      // Guard wrapping the element inline instead of via a parent route.
      { path: "audit", element: <RequireAuth><AuditLog /></RequireAuth> },
      // Lazy route module (react-router data-router convention).
      { path: "settings", lazy: () => import("./pages/SettingsPage") },
    ],
  },
]);
