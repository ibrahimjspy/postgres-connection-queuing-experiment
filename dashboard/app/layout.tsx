import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Connection Queue Lab",
  description: "A learning dashboard for the Postgres connection queuing experiments",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
