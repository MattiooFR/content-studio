#!/usr/bin/env node
// Migration jouée au démarrage du conteneur, AVANT le serveur Next.
//
// Pourquoi ce script plutôt que `npx drizzle-kit migrate` (l'ancien CMD) :
//   1. drizzle-kit est une devDependency. L'image finale est construite sur
//      .next/standalone, qui ne contient que les dépendances tracées depuis le
//      code applicatif — drizzle-kit n'y est pas, et l'y remettre ferait
//      rentrer ~10 Mo d'outillage de dev dans une image de production.
//   2. drizzle-kit lit drizzle.config.ts, donc exige un runtime TypeScript dans
//      l'image finale. Le migrateur de drizzle-orm, lui, lit directement le
//      dossier drizzle/ (les .sql + meta/_journal.json) : même table de suivi
//      (`drizzle.__drizzle_migrations`), même bookkeeping, zéro TS.
//   3. `npx ... && npm start` masquait la panne : npx peut sortir 0 sur des
//      chemins d'erreur, et rien ne distinguait « base injoignable » de
//      « migrations en échec ». Ici chaque cas sort explicitement en 1, avec
//      l'erreur complète, et l'entrypoint refuse alors de lancer le serveur.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL absent — refus de démarrer.");
  process.exit(1);
}

const folder = process.env.MIGRATIONS_DIR ?? "./drizzle";
const attempts = Number(process.env.MIGRATE_DB_WAIT_ATTEMPTS ?? 30);
const delayMs = Number(process.env.MIGRATE_DB_WAIT_DELAY_MS ?? 2000);

// max: 1 — ce process ne fait qu'une chose et meurt ; un pool n'a aucun sens
// et laisserait des connexions ouvertes le temps du timeout de fin.
const sql = postgres(url, { max: 1, onnotice: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const close = () => sql.end({ timeout: 5 }).catch(() => {});

// Attente bornée, PAS infinie : `depends_on: service_healthy` couvre déjà le
// démarrage normal de postgres ; cette boucle n'absorbe que la fenêtre de
// quelques secondes d'un redémarrage simultané des deux conteneurs. Passé le
// budget, on sort en erreur — un conteneur qui boucle sans fin sur une base
// morte ressemble à un conteneur vivant, et c'est exactement le silence qu'on
// veut éviter.
let lastError;
let reachable = false;
for (let i = 1; i <= attempts; i++) {
  try {
    await sql`select 1`;
    reachable = true;
    break;
  } catch (error) {
    lastError = error;
    console.error(`[migrate] base injoignable (essai ${i}/${attempts}) : ${error.message}`);
    if (i < attempts) await sleep(delayMs);
  }
}

if (!reachable) {
  console.error(
    `[migrate] ÉCHEC : base toujours injoignable après ${attempts} essais ` +
      `(~${Math.round((attempts * delayMs) / 1000)}s). Le serveur ne sera PAS démarré.`
  );
  console.error(lastError);
  await close();
  process.exit(1);
}

try {
  await migrate(drizzle(sql), { migrationsFolder: folder });
  console.log("[migrate] OK — schéma à jour.");
} catch (error) {
  console.error("[migrate] ÉCHEC des migrations. Le serveur ne sera PAS démarré.");
  console.error(error);
  await close();
  process.exit(1);
}

await close();
process.exit(0);
