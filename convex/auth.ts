import GitHub from "@auth/core/providers/github";
import { convexAuth, type GenericDoc } from "@convex-dev/auth/server";
import type { GenericMutationCtx, GenericDataModel } from "convex/server";
import type { GenericId, Value } from "convex/values";

type MutationCtx = GenericMutationCtx<GenericDataModel>;
type UserDoc = GenericDoc<GenericDataModel, "users"> & {
  readonly githubUserId?: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);

  if (parsed === undefined) {
    throw new Error(`GitHub OAuth profile did not include ${field}`);
  }

  return parsed;
}

function toConvexValue(value: unknown): Value {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toConvexValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const objectValue: Record<string, Value> = {};

    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        objectValue[key] = toConvexValue(item);
      }
    }

    return objectValue;
  }

  throw new Error("Expected a Convex-compatible value");
}

function userPatchForProfile(
  profile: Record<string, unknown>,
  now: string
): Record<string, Value> {
  const githubUserId = requiredString(profile.githubUserId, "id");
  const githubLogin = requiredString(profile.githubLogin, "login");
  const displayName = optionalString(profile.name) ?? githubLogin;
  const email = optionalString(profile.email);
  const image = optionalString(profile.image);

  return toConvexValue({
    userId: `github:${githubUserId}`,
    githubUserId,
    githubLogin,
    displayName,
    name: displayName,
    email,
    image,
    emailVerificationTime: email === undefined ? undefined : Date.now(),
    updatedAt: now
  }) as Record<string, Value>;
}

async function findExistingGithubUser(
  ctx: MutationCtx,
  githubUserId: string
): Promise<UserDoc | null> {
  return (await ctx.db
    .query("users")
    .withIndex("by_github_user_id", (q) => q.eq("githubUserId", githubUserId))
    .unique()) as UserDoc | null;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      profile(githubProfile) {
        return {
          id: String(githubProfile.id),
          githubUserId: String(githubProfile.id),
          githubLogin: githubProfile.login,
          name: githubProfile.name ?? githubProfile.login,
          email: githubProfile.email,
          image: githubProfile.avatar_url
        };
      }
    })
  ],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      const now = new Date(Date.now()).toISOString();
      const patch = userPatchForProfile(args.profile, now);
      const existingUserId = args.existingUserId;

      if (existingUserId !== null) {
        await ctx.db.patch(existingUserId, patch);
        return existingUserId;
      }

      const githubUserId = requiredString(args.profile.githubUserId, "id");
      const existingGithubUser = await findExistingGithubUser(
        ctx as unknown as MutationCtx,
        githubUserId
      );

      if (existingGithubUser !== null) {
        await ctx.db.patch(existingGithubUser._id, patch);
        return existingGithubUser._id as GenericId<"users">;
      }

      return await ctx.db.insert("users", {
        ...patch,
        createdAt: now
      });
    }
  }
});
