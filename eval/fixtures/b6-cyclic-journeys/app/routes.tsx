import { createBrowserRouter } from "react-router-dom";

import { UserDetail } from "./screens/UserDetail";
import { UsersList } from "./screens/UsersList";

export const router = createBrowserRouter([
  { path: "/users", element: <UsersList /> },
  { path: "/users/:userId", element: <UserDetail /> },
]);
