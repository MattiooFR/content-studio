"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={signOut}
      className="rounded-lg px-2 py-1.5 text-xs text-muted transition-colors duration-150 hover:bg-raised/60 hover:text-ink"
    >
      Déconnexion
    </button>
  );
}
