import { redirect } from "next/navigation";

// Ancienne route conservée pour les liens existants (jobs, worker, favoris).
export default async function ContentRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/?item=content:${id}`);
}
