// Pages-router: getServerSideProps fetches server-side; the page renders props.
export async function getServerSideProps() {
  const res = await fetch("/api/reports/latest");
  const report = await res.json();
  return { props: { report } };
}

export default function ReportsPage({ report }: { report: { title: string } }) {
  return (
    <main>
      <h1>Report viewer</h1>
      <span>{report.title}</span>
    </main>
  );
}
