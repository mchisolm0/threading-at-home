"use client";

import { useAuthActions } from "@convex-dev/auth/react";

export function SignInPanel() {
  const { signIn } = useAuthActions();

  return (
    <button
      type="button"
      onClick={() => void signIn("github", { redirectTo: "/dashboard" })}
    >
      Sign in with GitHub
    </button>
  );
}
