export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <aside>Dashboard menu</aside>
      {children}
    </section>
  );
}
