import type { Metadata } from "next";
import "./globals.css";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata: Metadata = {
  title: "OSS Capacity",
  description: "Volunteer-run Codex capacity for open source maintainers."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const body =
    convexUrl === undefined ? (
      children
    ) : (
      <ConvexAuthNextjsServerProvider storageNamespace={convexUrl}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </ConvexAuthNextjsServerProvider>
    );

  return (
    <html lang="en">
      <body>{body}</body>
    </html>
  );
}
