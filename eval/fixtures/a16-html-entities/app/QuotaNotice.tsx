// A real component with distinctive text, so the fixture isn't trivially
// all-declining: a real query must still land here, and gibberish that shares
// digits with a numeric entity must not poison it.
export function QuotaNotice() {
  return <p>Storage quota exceeded</p>;
}
