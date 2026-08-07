import { execSync } from "node:child_process";

export default async function setup() {
  const url =
    process.env.DATABASE_URL_TEST ?? "postgres://cs:cs@127.0.0.1:55434/content_studio_test";
  execSync("npx drizzle-kit migrate", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
