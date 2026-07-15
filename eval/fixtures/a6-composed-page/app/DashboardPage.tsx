import { RevenueSection } from "./RevenueSection";
import { SettingsSection } from "./SettingsSection";

export function DashboardPage() {
  return (
    <main>
      <h1>Analytics Dashboard</h1>
      <RevenueSection />
      <SettingsSection />
    </main>
  );
}
