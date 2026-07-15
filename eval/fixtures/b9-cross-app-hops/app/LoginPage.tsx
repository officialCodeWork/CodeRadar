export function LoginPage() {
  // OAuth redirect — the journey leaves the app for the provider.
  const loginWithGoogle = () =>
    window.location.assign("https://accounts.google.com/o/oauth2/auth");

  return (
    <div>
      <h1>Sign in</h1>
      <button onClick={loginWithGoogle}>Continue with Google</button>
      <a href="mailto:support@example.com">Contact support</a>
    </div>
  );
}
