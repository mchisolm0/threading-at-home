"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { convexApi } from "../convexApi";

export function DashboardClient() {
  const viewer = useQuery(convexApi.users.viewer);
  const touchSession = useMutation(convexApi.users.touchSession);
  const { signOut } = useAuthActions();
  const [message, setMessage] = useState<string | null>(null);

  if (viewer === undefined) {
    return <p>Loading session...</p>;
  }

  if (viewer === null) {
    return <p>Session unavailable.</p>;
  }

  return (
    <section>
      <p>Signed in</p>
      <h1>{viewer.displayName ?? viewer.githubLogin ?? "GitHub user"}</h1>
      <dl>
        <div>
          <dt>GitHub</dt>
          <dd>{viewer.githubLogin ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>User record</dt>
          <dd>{viewer.userId}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{viewer.updatedAt}</dd>
        </div>
      </dl>
      <div>
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            void touchSession({}).then((updatedViewer) => {
              setMessage(`Session checked at ${updatedViewer.updatedAt}`);
            });
          }}
        >
          Check session
        </button>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      {message === null ? null : <p>{message}</p>}
    </section>
  );
}
