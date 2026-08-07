"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.signIn.email({ email, password });
    if (error) return setError(error.message ?? "échec de connexion");
    router.push("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="size-2 rounded-full bg-accent" aria-hidden />
          <span className="text-sm font-semibold tracking-tight">content-studio</span>
        </div>
        <div className="space-y-4 rounded-xl border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold">Connexion</h1>
          <form onSubmit={submit} className="space-y-3">
            <Input type="email" placeholder="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
            <Input type="password" placeholder="mot de passe" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" className="w-full">Se connecter</Button>
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-muted">
          Pas de compte ?{" "}
          <a className="text-accent hover:underline" href="/register">Créer un compte</a>
        </p>
      </div>
    </main>
  );
}
