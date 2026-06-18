"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

const convex =
  convexUrl === undefined ? null : new ConvexReactClient(convexUrl);

export function ConvexClientProvider({
  children
}: {
  readonly children: ReactNode;
}) {
  if (convex === null) {
    return children;
  }

  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
