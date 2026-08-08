import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, schema } from "@/lib/db";
import { createWorkspaceWithDefaults } from "@/lib/workspaces";

// Signup ouvert par défaut : v1 self-host mono-utilisateur, pensé pour que
// `docker compose up` donne un cockpit utilisable sans étape de config
// supplémentaire. C'est aussi ce qui transforme "joindre le port" en RCE
// dès qu'on l'expose (cf. README, section Sécurité / déploiement) : tout
// self-host exposé au-delà de sa propre machine DOIT poser
// DISABLE_SIGNUP=1 une fois le compte owner créé.
//
// Fonction PURE (aucun accès DB) — extraite exprès pour être testable pour
// elle-même : la db de test de ce projet est PARTAGÉE entre tous les
// fichiers de tests (`fileParallelism: false`, une seule db) et n'est
// JAMAIS vide au moment où ce fichier de test s'exécute (d'autres fichiers
// y ont déjà créé des users) — la vider en cours de suite casserait les
// cascades (memberships, session, account) d'autres tests déjà passés.
// Cette fonction isole la DÉCISION ("bloquer ou pas") de la LECTURE db (le
// `select ... limit 1` reste dans le hook ci-dessous) : le cas "base vide"
// est donc bien couvert, juste sans avoir besoin d'une db réellement vide.
export function isSignupBlocked(disableSignupEnv: string | undefined, hasExistingUser: boolean): boolean {
  const disabled = disableSignupEnv === "1" || disableSignupEnv === "true";
  return disabled && hasExistingUser;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        // Bootstrap TOUJOURS autorisé : tant qu'aucun user n'existe encore
        // en base, même DISABLE_SIGNUP=1 laisse passer — sinon impossible
        // de créer le tout premier compte (owner) après avoir posé la var
        // d'env avant le premier démarrage. Un `select ... limit 1` (pas un
        // count) : coûte pareil dès le 2e user, jamais plus.
        before: async () => {
          const [existing] = await db.select({ id: schema.user.id }).from(schema.user).limit(1);
          if (isSignupBlocked(process.env.DISABLE_SIGNUP, !!existing)) {
            throw new APIError("FORBIDDEN", {
              message: "inscription désactivée (DISABLE_SIGNUP) — contacte l'administrateur de cette instance",
              code: "SIGNUP_DISABLED",
            });
          }
        },
        after: async (u) => {
          await createWorkspaceWithDefaults(u.id, u.name || u.email);
        },
      },
    },
  },
});
