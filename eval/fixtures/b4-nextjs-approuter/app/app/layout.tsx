export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>Nimbus Analytics</header>
        {children}
      </body>
    </html>
  );
}
