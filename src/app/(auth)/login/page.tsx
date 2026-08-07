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
    <main className="mx-auto mt-24 max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Connexion</h1>
      <form onSubmit={submit} className="space-y-3">
        <Input type="email" placeholder="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="mot de passe" value={password}
          onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full">Se connecter</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Pas de compte ? <a className="underline" href="/register">Créer un compte</a>
      </p>
    </main>
  );
}
