import { Outlet } from "react-router-dom";

export function ReportsLayout() {
  return (
    <div>
      <h2>Reporting</h2>
      <Outlet />
    </div>
  );
}
