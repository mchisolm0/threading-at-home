import { makeFunctionReference } from "convex/server";

export type Viewer = {
  readonly userId: string;
  readonly githubUserId?: string;
  readonly githubLogin?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly image?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export const convexApi = {
  users: {
    viewer: makeFunctionReference<"query", Record<string, never>, Viewer | null>(
      "users:viewer"
    ),
    touchSession: makeFunctionReference<
      "mutation",
      Record<string, never>,
      Viewer
    >("users:touchSession")
  }
};
