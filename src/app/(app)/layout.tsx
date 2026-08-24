import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ChatDrawerProvider } from "@/components/cockpit/chat-drawer";
import { WorkspaceItemsProvider } from "@/components/workspace/items-provider";
import { Sidebar } from "@/components/workspace/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return (
    <ChatDrawerProvider>
      <WorkspaceItemsProvider>
        {/* `< lg` : colonne (barre mobile de Sidebar au-dessus, main dessous —
            son overlay est en `fixed`, hors flux, donc sans effet ici).
            `≥ lg` : ligne classique sidebar + main. */}
        <div className="flex h-dvh flex-col overflow-hidden lg:flex-row">
          <Suspense>
            <Sidebar email={session.user.email} />
          </Suspense>
          {/* `min-w-0` (ligne desktop) ET `min-h-0` (colonne mobile) : sans les
              deux, un flex item garde son min-size "auto" et pousse le
              conteneur au lieu de scroller en interne, selon l'orientation. */}
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </WorkspaceItemsProvider>
    </ChatDrawerProvider>
  );
}
