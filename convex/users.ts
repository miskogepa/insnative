/**
 * Modul sa svim korisničkim (user) upitima i mutacijama.
 *
 * Integracija sa Clerk‑om:
 * - Autentikacija se vrši preko Clerk‑a; u Convex funkcijama pristupamo identitetu
 *   preko ctx.auth.getUserIdentity().
 * - identity.subject predstavlja jedinstveni Clerk ID korisnika i koristimo ga kao
 *   foreign key u tabeli "users" (polje "clerkId").
 *
 * Tabele i indeksi koji se koriste (prema `schema.ts`):
 * - "users" sa indeksom "by_clerk_id" (po polju clerkId) za brzo pronalaženje korisnika.
 * - "follows" sa indeksom "by_both" (po poljima followerId + followingId) za provjere
 *   i togglanje praćenja.
 * - "notifications" se koristi za kreiranje notifikacije kad nekoga zapratiš.
 *
 * Napomena o zaštiti:
 * - Funkcije koje mijenjaju stanje (mutations) koriste pomoćnu funkciju
 *   getAuthenticatedUser(...) da bi osigurale da je korisnik prijavljen i da postoji
 *   u bazi prije izmjena.
 */
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { mutation, MutationCtx, query, QueryCtx } from "./_generated/server";

// Kreiranje korisnika u bazi nakon uspješne prijave preko Clerk‑a (idempotentno po clerkId)
export const createUser = mutation({
  args: {
    username: v.string(),
    fullname: v.string(),
    image: v.string(),
    bio: v.optional(v.string()),
    email: v.string(),
    clerkId: v.string(),
  },

  handler: async (ctx, args) => {
    // Ako korisnik već postoji (po jedinstvenom clerkId), preskoči kreiranje
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .first();

    if (existingUser) return;

    // Upis novog korisnika u bazu (inicijalne metrike: 0)
    await ctx.db.insert("users", {
      username: args.username,
      fullname: args.fullname,
      email: args.email,
      bio: args.bio,
      image: args.image,
      clerkId: args.clerkId,
      followers: 0,
      following: 0,
      posts: 0,
    });
  },
});

// Dohvat korisnika po Clerk ID‑u (javna operacija, ne zahtijeva auth)
export const getUserByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    return user;
  },
});

// Ažuriranje profila trenutno prijavljenog korisnika
export const updateProfile = mutation({
  args: {
    fullname: v.string(),
    bio: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Osiguraj da je korisnik prijavljen i postoji u bazi
    const currentUser = await getAuthenticatedUser(ctx);

    await ctx.db.patch(currentUser._id, {
      fullname: args.fullname,
      bio: args.bio,
    });
  },
});

/**
 * Helper: vraća trenutno prijavljenog korisnika iz baze.
 * - Ako nema validnog Clerk identiteta → baca "Unauthorized".
 * - Ako ne postoji korisnik u bazi za dati Clerk ID → baca "User not found"
 *   (npr. onboarding nije dovršen pa createUser nije pozvan).
 */
export async function getAuthenticatedUser(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthorized");

  const currentUser = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .first();

  if (!currentUser) throw new Error("User not found");

  return currentUser;
}

// Dohvat korisničkog profila po ID‑u (korisno za prikaz profila)
export const getUserProfile = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) throw new Error("User not found");

    return user;
  },
});

// Provjera da li prijavljeni korisnik već prati zadati korisnički ID
export const isFollowing = query({
  args: { followingId: v.id("users") },
  handler: async (ctx, args) => {
    const currentUser = await getAuthenticatedUser(ctx);

    const follow = await ctx.db
      .query("follows")
      .withIndex("by_both", (q) =>
        q.eq("followerId", currentUser._id).eq("followingId", args.followingId)
      )
      .first();

    return !!follow;
  },
});

// Toggle follow/unfollow za zadatog korisnika + održavanje brojila i kreiranje notifikacije
export const toggleFollow = mutation({
  args: { followingId: v.id("users") },
  handler: async (ctx, args) => {
    const currentUser = await getAuthenticatedUser(ctx);

    const existing = await ctx.db
      .query("follows")
      .withIndex("by_both", (q) =>
        q.eq("followerId", currentUser._id).eq("followingId", args.followingId)
      )
      .first();

    if (existing) {
      // Unfollow grana
      await ctx.db.delete(existing._id);
      await updateFollowCounts(ctx, currentUser._id, args.followingId, false);
    } else {
      // Follow grana
      await ctx.db.insert("follows", {
        followerId: currentUser._id,
        followingId: args.followingId,
      });
      await updateFollowCounts(ctx, currentUser._id, args.followingId, true);

      // Kreiraj notifikaciju za primatelja (receiverId)
      await ctx.db.insert("notifications", {
        receiverId: args.followingId,
        senderId: currentUser._id,
        type: "follow",
      });
    }
  },
});

// Interna pomoćna funkcija: održavanje brojila followers/following na oba profila
async function updateFollowCounts(
  ctx: MutationCtx,
  followerId: Id<"users">,
  followingId: Id<"users">,
  isFollow: boolean
) {
  const follower = await ctx.db.get(followerId);
  const following = await ctx.db.get(followingId);

  if (follower && following) {
    await ctx.db.patch(followerId, {
      following: follower.following + (isFollow ? 1 : -1),
    });
    await ctx.db.patch(followingId, {
      followers: following.followers + (isFollow ? 1 : -1),
    });
  }
}
