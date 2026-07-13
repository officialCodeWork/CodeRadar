import { useQuery } from "@tanstack/react-query";

import { fetchBilling } from "./api/billing";
import { Table } from "./Table";

export function QueryPage() {
  const { data } = useQuery({ queryKey: ["billing"], queryFn: fetchBilling });

  return (
    <main>
      <h1>Billing rows</h1>
      <Table rows={data ?? []} />
    </main>
  );
}
