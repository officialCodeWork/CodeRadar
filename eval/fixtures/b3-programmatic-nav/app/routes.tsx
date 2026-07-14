import { createBrowserRouter } from "react-router-dom";

import { CartPage } from "./screens/CartPage";
import { CheckoutPage } from "./screens/CheckoutPage";
import { UserDetail } from "./screens/UserDetail";
import { UsersPage } from "./screens/UsersPage";

export const router = createBrowserRouter([
  { path: "/users", element: <UsersPage /> },
  { path: "/users/:userId", element: <UserDetail /> },
  { path: "/cart", element: <CartPage /> },
  { path: "/checkout", element: <CheckoutPage /> },
]);
