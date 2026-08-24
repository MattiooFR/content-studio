"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { IdeaDetail } from "@/components/idea-detail";

export default function IdeaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  return (
    <IdeaDetail
      ideaId={id}
      onOpenItem={(ref) =>
        router.push(ref.type === "content" ? `/contents/${ref.id}` : `/ideas/${ref.id}`)}
    />
  );
}
