import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, schema } from "@/lib/db";
import { createWorkspaceWithDefaults } from "@/lib/workspaces";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        after: async (u) => {
          await createWorkspaceWithDefaults(u.id, u.name || u.email);
        },
      },
    },
  },
});
