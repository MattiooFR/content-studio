import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, channels, workspaces, user as userTable } from "@/lib/db/schema";
import { createWorkspaceWithDefaults, generateWorkspaceSlug } from "@/lib/workspaces";
import { auth, isSignupBlocked } from "@/lib/auth";
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

// Critical 1b (revue finale, vague cockpit) : signup ouvert + lanes qui
// spawnent le CLI local + bind 0.0.0.0 par défaut = RCE réseau par
// combinaison. DISABLE_SIGNUP ferme le premier maillon (signup) une fois
// le compte owner créé, SANS jamais bloquer le tout premier compte
// (bootstrap — sinon on ne peut jamais créer cet owner).
describe("DISABLE_SIGNUP — signup désactivable, bootstrap toujours autorisé", () => {
  // isSignupBlocked est une fonction PURE (aucun accès DB) — voir le
  // commentaire dans src/lib/auth.ts : la db de test de ce projet est
  // PARTAGÉE entre tous les fichiers (fileParallelism: false) et n'est
  // JAMAIS vide au moment où ce fichier tourne (d'autres tests y ont déjà
  // créé des users). Ce test unitaire couvre donc le cas "base vide" —
  // hasExistingUser=false — sans avoir besoin d'une db réellement vide.
  it("logique pure : bloque SEULEMENT quand désactivé ET qu'un user existe déjà", () => {
    expect(isSignupBlocked("1", true)).toBe(true);
    expect(isSignupBlocked("true", true)).toBe(true);
    // base vide (bootstrap) : jamais bloqué, même désactivé.
    expect(isSignupBlocked("1", false)).toBe(false);
    expect(isSignupBlocked("true", false)).toBe(false);
    // non désactivé (vide, absent, ou toute autre valeur) : jamais bloqué.
    expect(isSignupBlocked(undefined, true)).toBe(false);
    expect(isSignupBlocked("", true)).toBe(false);
    expect(isSignupBlocked("0", true)).toBe(false);
    expect(isSignupBlocked("false", true)).toBe(false);
  });

  // Intégration réelle du hook better-auth (pas juste la fonction pure) :
  // un premier signup garantit qu'au moins un user existe déjà dans cette
  // db partagée (jamais vide de toute façon), PUIS DISABLE_SIGNUP=1 est
  // posé pour la durée du test SEULEMENT (restauré en finally — cette db
  // est partagée par tous les fichiers de tests suivants, un signup y
  // reste nécessaire ailleurs).
  it("DISABLE_SIGNUP=1 + user existant → auth.api.signUpEmail rejette, rien n'est créé en base", async () => {
    await signUpTestUser(); // garantit un user existant.
    const prevEnv = process.env.DISABLE_SIGNUP;
    process.env.DISABLE_SIGNUP = "1";
    try {
      const email = `blocked-${crypto.randomUUID()}@test.local`;
      await expect(
        auth.api.signUpEmail({
          body: { email, password: "motdepasse-solide-123", name: "Bloqué" },
        })
      ).rejects.toThrow();

      const rows = await db.select().from(userTable).where(eq(userTable.email, email));
      expect(rows).toEqual([]); // aucun user créé malgré le rejet côté hook.
    } finally {
      process.env.DISABLE_SIGNUP = prevEnv;
    }
  });

  it("DISABLE_SIGNUP absent (défaut) → signup ouvert, même avec des users déjà existants", async () => {
    await signUpTestUser(); // un user existe déjà.
    const prevEnv = process.env.DISABLE_SIGNUP;
    delete process.env.DISABLE_SIGNUP;
    try {
      const { userId } = await signUpTestUser(); // un 2e signup doit passer.
      expect(userId).toBeTruthy();
    } finally {
      process.env.DISABLE_SIGNUP = prevEnv;
    }
  });
});
