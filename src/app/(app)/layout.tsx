import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return (
    <div className="min-h-screen">
      <header className="border-b px-6 py-3 flex items-center justify-between">
        <a href="/" className="font-semibold">content-studio</a>
        <nav className="flex gap-4 text-sm">
          <a href="/" className="hover:underline">Idées</a>
          <a href="/settings/tokens" className="hover:underline">Tokens MCP</a>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl p-6">{children}</main>
    </div>
  );
}
