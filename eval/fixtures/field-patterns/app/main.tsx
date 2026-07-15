import { createBrowserRouter } from "react-router-dom";

import { routes } from "./routes";

// The config is an imported identifier, not an inline array literal.
export const router = createBrowserRouter(routes);
