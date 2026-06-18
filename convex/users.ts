import { getAuthUserId } from "@convex-dev/auth/server";
import { mutationGeneric, queryGeneric } from "convex/server";

const query = queryGeneric;
const mutation = mutationGeneric;

function publicUser(user: {
  readonly userId: string;
  readonly githubUserId?: string;
  readonly githubLogin?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly image?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}) {
  return {
    userId: user.userId,
    githubUserId: user.githubUserId,
    githubLogin: user.githubLogin,
    displayName: user.displayName,
    email: user.email,
    image: user.image,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);

    if (authUserId === null) {
      return null;
    }

    const user = await ctx.db.get(authUserId);

    if (user === null) {
      throw new Error("Authenticated user record was not found");
    }

    return publicUser(user);
  }
});

export const touchSession = mutation({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);

    if (authUserId === null) {
      throw new Error("Authentication required");
    }

    const user = await ctx.db.get(authUserId);

    if (user === null) {
      throw new Error("Authenticated user record was not found");
    }

    const updatedAt = new Date(Date.now()).toISOString();
    await ctx.db.patch(authUserId, { updatedAt });

    return publicUser({ ...user, updatedAt });
  }
});
