import { Route, Routes } from "react-router-dom";

import { ReportsLayout } from "./ReportsLayout";
import { ReportDetail } from "./pages/ReportDetail";
import { ReportsHome } from "./pages/ReportsHome";

/** JSX-declared route tree — the second React Router declaration style. */
export function ReportsApp() {
  return (
    <Routes>
      <Route path="/reports" element={<ReportsLayout />}>
        <Route index element={<ReportsHome />} />
        <Route path=":reportId" element={<ReportDetail />} />
      </Route>
    </Routes>
  );
}
