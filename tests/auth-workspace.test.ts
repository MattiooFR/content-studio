import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, channels, workspaces } from "@/lib/db/schema";
import { createWorkspaceWithDefaults, generateWorkspaceSlug } from "@/lib/workspaces";
import { signUpTestUser } from "./helpers";

describe("signup", () => {
  it("crée workspace + membership owner + 3 canaux seeds", async () => {
    const { userId, workspaceId } = await signUpTestUser();
    const [m] = await db.select().from(memberships)
      .where(eq(memberships.userId, userId));
    expect(m.role).toBe("owner");
    const chans = await db.select().from(channels)
      .where(eq(channels.workspaceId, workspaceId));
    expect(chans.map((c) => c.key).sort()).toEqual(["community", "seo_article", "x_linkedin"]);
  });

  it("regénère le slug et rejoue la transaction en cas de collision", async () => {
    const { userId } = await signUpTestUser();

    // Un workspace occupe déjà ce slug.
    const takenSlug = `collision-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(workspaces).values({ name: "Occupant", slug: takenSlug });

    // Générateur forcé sur ce slug au premier essai, puis comportement par
    // défaut (aléatoire) aux essais suivants.
    let calls = 0;
    const forcedSlugGenerator = (name: string) => {
      calls += 1;
      return calls === 1 ? takenSlug : generateWorkspaceSlug(name);
    };

    const { workspaceId } = await createWorkspaceWithDefaults(userId, "Retry Test", {
      slugGenerator: forcedSlugGenerator,
    });

    expect(calls).toBeGreaterThan(1); // preuve que le retry a eu lieu
    const [created] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(created.slug).not.toBe(takenSlug);

    const m = await db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId));
    expect(m[0]?.role).toBe("owner");
    const chans = await db.select().from(channels).where(eq(channels.workspaceId, workspaceId));
    expect(chans.map((c) => c.key).sort()).toEqual(["community", "seo_article", "x_linkedin"]);
  });
});
