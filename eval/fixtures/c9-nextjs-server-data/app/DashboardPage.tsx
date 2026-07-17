// App-router RSC: an async server component that fetches in its own body.
export default async function DashboardPage() {
  const res = await fetch("/api/dashboard/summary");
  const data = await res.json();
  return (
    <main>
      <h1>Dashboard totals</h1>
      <p>{data.total}</p>
    </main>
  );
}
