import { Outlet, useLocation } from "react-router-dom";

export function RequireAuth({ children }: { children?: unknown }) {
  const location = useLocation();
  const authed = Boolean(location);
  if (!authed) {
    return <p>Please sign in to continue</p>;
  }
  return children !== undefined ? <>{children}</> : <Outlet />;
}
