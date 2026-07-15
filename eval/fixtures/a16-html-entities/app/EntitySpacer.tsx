// Its only rendered text is HTML entities — the shape the Grafana frontend hit
// (26 &nbsp;, 4 &quot;, plus &#34;/&gt;/&lt;/&middot;/&rsaquo;). Each decodes to
// punctuation/whitespace, so after decoding there is no match target at all.
export function EntitySpacer() {
  return (
    <div aria-hidden="true">
      <span>&nbsp;</span>
      <span>&#34;</span>
      <span>&gt;</span>
      <span>&quot;</span>
      <span>&middot;</span>
      <span>&lt;</span>
      <span>&rsaquo;</span>
    </div>
  );
}
