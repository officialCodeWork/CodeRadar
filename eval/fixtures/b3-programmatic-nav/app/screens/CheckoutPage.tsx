import { useNavigate } from "react-router-dom";

export function CheckoutPage() {
  const navigate = useNavigate();

  // Resolves to a known route → navigates-to /cart.
  const goBack = () => navigate("/cart");
  // Resolves to a path with no declared route → flagged unresolved-nav.
  const goBroken = () => navigate("/nowhere");

  return (
    <section>
      <h1>Checkout</h1>
      <button onClick={goBack}>Back to cart</button>
      <button onClick={goBroken}>Broken link</button>
    </section>
  );
}
