export function ProfileCardInner({ name }: { name: string }) {
  return (
    <div>
      <h3>Profile details</h3>
      <span>{name}</span>
    </div>
  );
}

export default function AvatarBadge() {
  return <img alt="Member avatar" />;
}
