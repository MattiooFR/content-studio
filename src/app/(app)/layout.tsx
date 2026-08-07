import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { NavLinks } from "@/components/nav-links";
import { SignOutButton } from "@/components/sign-out-button";
import { SubscriptionGauges } from "@/components/cockpit/subscription-gauges";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center gap-6 px-6">
          <a href="/" className="flex shrink-0 items-center gap-2">
            <span className="size-2 rounded-full bg-accent" aria-hidden />
            <span className="text-sm font-semibold tracking-tight text-ink">
              content-studio
            </span>
          </a>
          <SubscriptionGauges />
          <div className="ml-auto flex shrink-0 items-center gap-4 md:ml-0">
            <NavLinks />
            <div className="flex items-center gap-2 border-l border-line pl-4">
              <span className="hidden max-w-48 truncate text-xs text-muted sm:inline">
                {session.user.email}
              </span>
              <SignOutButton />
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
