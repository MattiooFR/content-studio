"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Idea = {
  id: string; title: string; notes: string; status: string;
  tags: string[]; createdAt: string;
};

export default function InboxPage() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/ideas");
    if (res.ok) setIdeas(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/ideas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, notes }),
    });
    if (res.ok) { setTitle(""); setNotes(""); load(); }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={create} className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">Nouvelle idée</h2>
        <Input placeholder="Titre" value={title}
          onChange={(e) => setTitle(e.target.value)} required />
        <Textarea placeholder="Notes, angle, sources…" value={notes}
          onChange={(e) => setNotes(e.target.value)} rows={3} />
        <Button type="submit">Ajouter</Button>
      </form>
      <ul className="space-y-2">
        {ideas.map((i) => (
          <li key={i.id}>
            <a href={`/ideas/${i.id}`}
              className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent">
              <span>{i.title}</span>
              <Badge variant="outline">{i.status}</Badge>
            </a>
          </li>
        ))}
        {ideas.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Aucune idée. Ajoute la première — ou laisse ton agent le faire via MCP.
          </p>
        )}
      </ul>
    </div>
  );
}
