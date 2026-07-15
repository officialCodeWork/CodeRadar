export function SettingsForm() {
  return (
    <form>
      <h2>Notification preferences</h2>
      <label>
        Email alerts
        <input type="checkbox" />
      </label>
      <button type="submit">Save</button>
    </form>
  );
}
