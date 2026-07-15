import { Grid } from "../components";

import { useListInvoicesQuery } from "../store/api/invoicesApi";

export function InvoicesPage() {
  const { data } = useListInvoicesQuery();
  return (
    <section>
      <h1>Invoice history</h1>
      <Grid rows={data ?? []} />
    </section>
  );
}

export default InvoicesPage;
