import { Outlet } from "react-router-dom";

export function RootLayout() {
  return (
    <div>
      <nav>Acme Console</nav>
      <Outlet />
    </div>
  );
}
