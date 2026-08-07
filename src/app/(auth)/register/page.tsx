"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await authClient.signUp.email({ email, password, name });
    if (error) return setError(error.message ?? "échec de l'inscription");
    router.push("/");
  }

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Créer un compte</h1>
      <form onSubmit={submit} className="space-y-3">
        <Input type="text" placeholder="nom" value={name}
          onChange={(e) => setName(e.target.value)} required />
        <Input type="email" placeholder="email" value={email}
          onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="mot de passe" value={password}
          onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full">Créer le compte</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Déjà un compte ? <a className="underline" href="/login">Se connecter</a>
      </p>
    </main>
  );
}
