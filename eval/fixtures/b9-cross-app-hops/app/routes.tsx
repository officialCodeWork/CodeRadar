import { createBrowserRouter } from "react-router-dom";

import { CallbackPage } from "./CallbackPage";
import { CheckoutPage } from "./CheckoutPage";
import { LoginPage } from "./LoginPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/checkout", element: <CheckoutPage /> },
  { path: "/auth/callback", element: <CallbackPage /> },
]);
