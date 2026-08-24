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
        <div className="flex h-dvh overflow-hidden">
          <Suspense>
            <Sidebar email={session.user.email} />
          </Suspense>
          <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </WorkspaceItemsProvider>
    </ChatDrawerProvider>
  );
}
