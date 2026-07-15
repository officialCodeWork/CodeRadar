export function CheckoutPage() {
  // Payment gateway — an outbound hop to Stripe.
  const pay = () => window.open("https://checkout.stripe.com/pay");

  return (
    <div>
      <h1>Checkout</h1>
      <button onClick={pay}>Pay now</button>
    </div>
  );
}
