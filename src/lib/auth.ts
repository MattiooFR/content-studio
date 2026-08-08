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
        //
        // LIMITE CONNUE (revue finale, vague cockpit) — course TOCTOU sur le
        // bootstrap : deux tout premiers signups strictement simultanés sur
        // une base vide peuvent tous les deux lire `existing = undefined`
        // avant qu'aucun des deux INSERT n'ait committé, et donc tous les
        // deux passer pour "owner". Volontairement NON corrigé par un verrou
        // ici, pour une raison précise et vérifiée dans le code de
        // better-auth (pas une supposition) :
        //   - ce hook `before` tourne AVANT le `create()` de l'adapter, mais
        //     PAS dans la même transaction DB que lui par défaut — et même
        //     en passant `transaction: true` à drizzleAdapter (ce qui n'est
        //     PAS fait ici), better-auth exécute ce before() avec le `tx`
        //     interne accessible seulement via son AsyncLocalStorage
        //     (`@better-auth/core/context`, `getCurrentAdapter()`) : ce
        //     `db` importé ici en haut de fichier reste la connexion pool
        //     top-level, hors de ce contexte. `pg_advisory_xact_lock` posé
        //     ici se relâcherait de toute façon à la fin de la micro-requête
        //     de lecture, bien AVANT l'INSERT réel — donc inutile tel quel.
        //   - un verrou SESSION (`pg_advisory_lock`/`unlock`) qui tiendrait
        //     de before() à after() exigerait de réserver une connexion
        //     dédiée hors du pool (`postgres.reserve()`) et de la faire
        //     survivre entre deux callbacks déconnectés (before/after, avec
        //     l'INSERT de better-auth entre les deux) via un état partagé
        //     ad hoc — fragile, et un verrou qui ne se relâche pas sur un
        //     chemin d'erreur bloquerait TOUT signup futur, un pire risque
        //     que la course qu'il corrige.
        // Best-effort déjà en place : le bind par défaut est loopback
        // (127.0.0.1), donc en pratique cette fenêtre n'est atteignable que
        // depuis la machine elle-même — pas depuis Internet. Un vrai fix
        // demanderait de faire tourner ce check DANS la transaction de
        // création de better-auth (contrôle qu'on n'a pas sans patcher ses
        // internes), pas un raccourci ajouté ici.
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
