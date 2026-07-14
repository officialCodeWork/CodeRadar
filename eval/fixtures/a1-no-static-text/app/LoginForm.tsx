export function LoginForm({ onSubmit }: { onSubmit: () => void }) {
  return (
    <form onSubmit={onSubmit}>
      <input type="email" />
      <input type="password" />
      <button type="submit" />
    </form>
  );
}
