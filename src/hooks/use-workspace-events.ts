"use client";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent } from "@/lib/events";

type Handler = (e: WorkspaceEvent) => void;

/**
 * UNE seule connexion SSE pour toute la page, partagée par tous les abonnés :
 * ouverte au premier `useWorkspaceEvents`, fermée quand le dernier se
 * démonte (le compteur de références EST `handlers.size`).
 *
 * Pourquoi (revue Task 15, finding I3) : les navigateurs plafonnent à ~6
 * connexions par origine en HTTP/1.1, et une connexion SSE en occupe une en
 * permanence. L'écran contenu en ouvrait déjà six avec l'onglet Relire (la
 * page, `useJobs`, `PublicationCard`, les deux `useComments`, le drawer de
 * chat) : le fetch suivant restait bloqué indéfiniment. Un « Réessayer » par
 * carte de transcription échouée (un `useJobs` par carte) rendait le
 * dépassement systématique. Le partage supprime le plafond comme contrainte
 * de conception : on peut désormais s'abonner autant de fois qu'utile.
 *
 * L'API publique du hook est inchangée — les appelants n'ont rien à savoir
 * de tout ceci.
 */
const handlers = new Set<Handler>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(raw: string) {
  let event: WorkspaceEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // trame illisible : on l'ignore plutôt que de casser tous les abonnés
  }
  // copie de la liste : un abonné qui se désabonne (ou s'abonne) pendant la
  // boucle ne doit pas faire sauter la livraison aux suivants
  for (const fn of [...handlers]) {
    try {
      fn(event);
    } catch {
      /* un abonné cassé ne bloque pas les autres (même contrat que le bus serveur) */
    }
  }
}

function connect() {
  const es = new EventSource("/api/events");
  source = es;
  es.onmessage = (ev) => dispatch(ev.data);
  es.onerror = () => {
    es.close();
    if (source !== es) return; // déjà remplacée ou fermée entre-temps
    source = null;
    if (handlers.size === 0) return; // plus personne à servir : ne pas reconnecter
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (handlers.size > 0) connect();
    }, 3000);
  };
}

function subscribe(fn: Handler): () => void {
  handlers.add(fn);
  // ni connexion vivante, ni reconnexion déjà armée → on ouvre
  if (!source && !retryTimer) connect();
  return () => {
    handlers.delete(fn);
    if (handlers.size > 0) return;
    // dernier abonné parti : on ferme et on désarme toute reconnexion
    source?.close();
    source = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}

export function useWorkspaceEvents(onEvent: Handler) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    // indirection stable : le callback de l'appelant change à chaque rendu,
    // l'abonnement, lui, ne bouge pas (donc la connexion partagée non plus)
    const fn: Handler = (e) => handler.current(e);
    return subscribe(fn);
  }, []);
}
