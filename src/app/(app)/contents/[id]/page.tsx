"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { ContentDetail } from "@/components/content-detail";

export default function ContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  return (
    <ContentDetail
      contentId={id}
      onOpenItem={(ref) =>
        router.push(ref.type === "content" ? `/contents/${ref.id}` : `/ideas/${ref.id}`)}
    />
  );
}
