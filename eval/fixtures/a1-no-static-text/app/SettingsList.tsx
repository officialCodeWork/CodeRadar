interface Option {
  id: string;
  name: string;
}

export function SettingsList({ options }: { options: Option[] }) {
  return (
    <ul>
      {options.map((o) => (
        <li key={o.id}>{o.name}</li>
      ))}
    </ul>
  );
}
