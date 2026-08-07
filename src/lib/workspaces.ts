import { db } from "@/lib/db";
import { workspaces, memberships, channels } from "@/lib/db/schema";

const DEFAULT_CHANNELS = [
  {
    key: "x_linkedin",
    name: "Post X / LinkedIn",
    outputType: "text" as const,
    constraints: {
      max_chars: 2800,
      structure: "hook en première ligne, une idée par ligne, CTA finale",
      export_format: "plain",
    },
  },
  {
    key: "community",
    name: "Post communauté",
    outputType: "text" as const,
    constraints: {
      structure: "post long : contexte, méthode, exemples concrets, question finale",
      export_format: "markdown",
    },
  },
  {
    key: "seo_article",
    name: "Article SEO",
    outputType: "text" as const,
    constraints: {
      min_words: 1200,
      structure: "H2/H3, intro qui pose le problème, FAQ finale",
      export_format: "markdown",
    },
  },
];

// 12 caractères hex (~48 bits) après le uuid : une collision de slug tient
// désormais du hasard cosmique, mais on gère quand même le cas (voir retry
// ci-dessous) plutôt que de compter dessus.
export function generateWorkspaceSlug(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)}`;
}

const SLUG_UNIQUE_VIOLATION_CODE = "23505";
const SLUG_UNIQUE_CONSTRAINT = "workspaces_slug_unique";
const MAX_SLUG_ATTEMPTS = 3;

function isSlugUniqueViolation(err: unknown): boolean {
  // drizzle-orm enveloppe l'erreur postgres-js dans une DrizzleQueryError
  // (`.cause` = l'erreur d'origine) ; on regarde donc l'erreur ET sa cause.
  for (const candidate of [err, (err as { cause?: unknown } | null | undefined)?.cause]) {
    const e = candidate as { code?: string; constraint_name?: string } | null | undefined;
    if (e?.code === SLUG_UNIQUE_VIOLATION_CODE && e?.constraint_name === SLUG_UNIQUE_CONSTRAINT) {
      return true;
    }
  }
  return false;
}

export async function createWorkspaceWithDefaults(
  userId: string,
  name: string,
  options?: { slugGenerator?: (name: string) => string }
): Promise<{ workspaceId: string }> {
  const slugGenerator = options?.slugGenerator ?? generateWorkspaceSlug;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = slugGenerator(name);
    try {
      return await db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces)
          .values({ name: `Workspace de ${name}`, slug }).returning();
        await tx.insert(memberships)
          .values({ workspaceId: ws.id, userId, role: "owner" });
        await tx.insert(channels)
          .values(DEFAULT_CHANNELS.map((c) => ({ ...c, workspaceId: ws.id })));
        return { workspaceId: ws.id };
      });
    } catch (err) {
      if (!isSlugUniqueViolation(err)) throw err;
      lastError = err;
      // collision de slug : on regénère et on rejoue la transaction entière
      // à l'itération suivante.
    }
  }
  throw new Error(
    `createWorkspaceWithDefaults: échec après ${MAX_SLUG_ATTEMPTS} tentatives (collisions de slug répétées)`,
    { cause: lastError }
  );
}
