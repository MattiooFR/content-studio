import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url =
  process.env.NODE_ENV === "test" || process.env.VITEST
    ? process.env.DATABASE_URL_TEST ?? "postgres://cs:cs@127.0.0.1:55434/content_studio_test"
    : process.env.DATABASE_URL ?? "postgres://cs:cs@127.0.0.1:55434/content_studio";

// globalThis-cache : next dev recharge les modules, il ne faut qu'un seul pool.
const g = globalThis as unknown as { __csSql?: ReturnType<typeof postgres> };
const sql = g.__csSql ?? postgres(url, { max: 10 });
g.__csSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
