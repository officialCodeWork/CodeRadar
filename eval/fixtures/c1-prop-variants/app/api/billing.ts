export async function fetchBilling() {
  const res = await fetch("/api/billing");
  return res.json();
}
