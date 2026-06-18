import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OSS Capacity",
  description: "Volunteer-run Codex capacity for open source maintainers."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
