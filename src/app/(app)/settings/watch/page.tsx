"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";

type WatchFeedKind = "account" | "query";

type WatchFeedRow = {
  id: string;
  kind: WatchFeedKind;
  label: string;
  params: Record<string, unknown>;
  enabled: boolean;
  lastFetchedAt: string | null;
};

type WatchSettingsRedacted = {
  topics: string[];
  style: string;
  requireMedia: boolean;
  channelKey: string | null;
  publishConfig: Record<string, string>;
};

type ChannelRow = { id: string; key: string; name: string };

export default function WatchSettingsPage() {
  const [error, setError] = useState<string | null>(null);

  // Feeds
  const [feeds, setFeeds] = useState<WatchFeedRow[]>([]);
  const [feedKind, setFeedKind] = useState<WatchFeedKind>("account");
  const [feedLabel, setFeedLabel] = useState("");
  const [feedParamsText, setFeedParamsText] = useState("");
  const [feedEnabled, setFeedEnabled] = useState(true);
  const [submittingFeed, setSubmittingFeed] = useState(false);

  // Réglages (topics/style/requireMedia/channelKey) — l'état chargé sert de
  // référence pour n'envoyer au PATCH que les champs réellement modifiés.
  const [loadedSettings, setLoadedSettings] = useState<WatchSettingsRedacted | null>(null);
  const [topicsDraft, setTopicsDraft] = useState<string[]>([]);
  const [topicInput, setTopicInput] = useState("");
  const [styleDraft, setStyleDraft] = useState("");
  const [requireMediaDraft, setRequireMediaDraft] = useState(false);
  const [channelKeyDraft, setChannelKeyDraft] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [submittingSettings, setSubmittingSettings] = useState(false);

  // Canaux (pour le <select> du canal de validation)
  const [channels, setChannels] = useState<ChannelRow[]>([]);

  // Config de publication — write-only : jamais de valeur en clair reçue du
  // serveur, seulement des clés + valeurs masquées (••••1234). `pending`
  // accumule ce que CETTE session a effectivement écrit en clair, pour ne
  // pas se re-écraser elle-même à la clé suivante — mais ne peut pas
  // reconstituer une clé posée avant l'ouverture de la page : la
  // remplacer redéfinit tout le bloc (voir avertissement affiché).
  const [publishConfigView, setPublishConfigView] = useState<Record<string, string>>({});
  const [pendingPublishConfig, setPendingPublishConfig] = useState<Record<string, string>>({});
  const [pubKey, setPubKey] = useState("");
  const [pubValue, setPubValue] = useState("");
  const [publishSaved, setPublishSaved] = useState(false);
  const [submittingPublish, setSubmittingPublish] = useState(false);

  const applyLoadedSettings = useCallback((s: WatchSettingsRedacted) => {
    setLoadedSettings(s);
    setTopicsDraft(s.topics);
    setStyleDraft(s.style);
    setRequireMediaDraft(s.requireMedia);
    setChannelKeyDraft(s.channelKey ?? "");
    setPublishConfigView(s.publishConfig);
  }, []);

  const loadFeeds = useCallback(async () => {
    const res = await fetch("/api/watch/feeds");
    if (res.ok) {
      const data = (await res.json()) as { feeds: WatchFeedRow[] };
      setFeeds(data.feeds);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/watch/settings");
    if (res.ok) applyLoadedSettings((await res.json()) as WatchSettingsRedacted);
  }, [applyLoadedSettings]);

  const loadChannels = useCallback(async () => {
    const res = await fetch("/api/channels");
    if (res.ok) setChannels((await res.json()) as ChannelRow[]);
  }, []);

  useEffect(() => {
    loadFeeds();
    loadSettings();
    loadChannels();
  }, [loadFeeds, loadSettings, loadChannels]);

  // --- Feeds ---

  async function createFeed(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Parse et valide le JSON des params AVANT tout appel réseau — même
    // discipline que les headers de jauges (settings/gauges/page.tsx).
    let params: Record<string, unknown> | undefined;
    if (feedParamsText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(feedParamsText);
      } catch {
        setError("Params : JSON invalide — vérifie la syntaxe avant d'enregistrer.");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError('Params : un objet à plat attendu, ex. {"lang": "fr"}');
        return;
      }
      params = parsed as Record<string, unknown>;
    }

    setSubmittingFeed(true);
    try {
      const res = await fetch("/api/watch/feeds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: feedKind, label: feedLabel, params, enabled: feedEnabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Échec de l'enregistrement du feed. Réessaie.");
        return;
      }
      setFeedLabel("");
      setFeedParamsText("");
      setFeedEnabled(true);
      setFeedKind("account");
      await loadFeeds();
    } finally {
      setSubmittingFeed(false);
    }
  }

  async function toggleFeed(id: string, enabled: boolean) {
    setError(null);
    const res = await fetch(`/api/watch/feeds/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      setError("Échec de la mise à jour — l'état n'a pas changé. Réessaie.");
      return;
    }
    loadFeeds();
  }

  async function removeFeed(id: string) {
    setError(null);
    const res = await fetch(`/api/watch/feeds/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Échec de la suppression — le feed reste actif. Réessaie.");
      return;
    }
    loadFeeds();
  }

  // --- Thèmes (liste de chaînes) ---

  function addTopic() {
    const t = topicInput.trim();
    if (!t || topicsDraft.includes(t)) {
      setTopicInput("");
      return;
    }
    setTopicsDraft([...topicsDraft, t]);
    setTopicInput("");
    setSettingsSaved(false);
  }

  function removeTopic(t: string) {
    setTopicsDraft(topicsDraft.filter((x) => x !== t));
    setSettingsSaved(false);
  }

  // --- Réglages : topics/style/requireMedia/channelKey, allow-list + diff ---

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSettingsSaved(false);
    if (!loadedSettings) return;

    // N'envoyer que les champs réellement modifiés depuis le dernier
    // chargement — jamais un spread de tout le formulaire.
    const patch: {
      topics?: string[]; style?: string; requireMedia?: boolean; channelKey?: string;
    } = {};
    const topicsChanged =
      topicsDraft.length !== loadedSettings.topics.length ||
      topicsDraft.some((t, i) => t !== loadedSettings.topics[i]);
    if (topicsChanged) patch.topics = topicsDraft;
    if (styleDraft !== loadedSettings.style) patch.style = styleDraft;
    if (requireMediaDraft !== loadedSettings.requireMedia) patch.requireMedia = requireMediaDraft;
    if (channelKeyDraft.trim() && channelKeyDraft !== (loadedSettings.channelKey ?? "")) {
      patch.channelKey = channelKeyDraft;
    }

    if (Object.keys(patch).length === 0) {
      setSettingsSaved(true);
      return;
    }

    setSubmittingSettings(true);
    try {
      const res = await fetch("/api/watch/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Échec de l'enregistrement des réglages. Réessaie.");
        return;
      }
      applyLoadedSettings((await res.json()) as WatchSettingsRedacted);
      setSettingsSaved(true);
    } finally {
      setSubmittingSettings(false);
    }
  }

  // --- Config de publication (write-only, remplacée en bloc) ---

  async function savePublishKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPublishSaved(false);
    const key = pubKey.trim();
    if (!key) {
      setError("Clé requise.");
      return;
    }
    // Accumule sur ce que CETTE session a déjà posé en clair, pour ne pas
    // s'écraser elle-même d'un appel à l'autre — voir l'avertissement
    // affiché sous ce formulaire pour ce que ça ne couvre PAS.
    const merged = { ...pendingPublishConfig, [key]: pubValue };
    setSubmittingPublish(true);
    try {
      const res = await fetch("/api/watch/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishConfig: merged }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Échec de l'enregistrement de la config de publication. Réessaie.");
        return;
      }
      const data = (await res.json()) as WatchSettingsRedacted;
      setPendingPublishConfig(merged);
      setPublishConfigView(data.publishConfig);
      setPubKey("");
      setPubValue("");
      setPublishSaved(true);
    } finally {
      setSubmittingPublish(false);
    }
  }

  function replaceKey(key: string) {
    setPublishSaved(false);
    setPubKey(key);
    setPubValue("");
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Veille</h1>
        <p className="mt-1 text-xs text-muted">
          Un worker externe dépose des propositions par MCP ; ces réglages définissent ce
          qu&apos;il surveille et où une validation publie.
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <SectionCard title="Nouveau feed">
        <form onSubmit={createFeed} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
            <select
              value={feedKind}
              onChange={(e) => setFeedKind(e.target.value as WatchFeedKind)}
              className="h-8 rounded-lg border border-line bg-transparent px-2.5 text-sm text-ink outline-none focus-visible:border-accent"
            >
              <option value="account">Compte à suivre</option>
              <option value="query">Recherche / mot-clé</option>
            </select>
            <Input
              placeholder="label (ex: @compte ou mot-clé)"
              value={feedLabel}
              onChange={(e) => setFeedLabel(e.target.value)}
              required
            />
          </div>
          <Textarea
            placeholder={'params JSON optionnel, interprété par le worker — ex: {"lang": "fr"}'}
            value={feedParamsText}
            onChange={(e) => setFeedParamsText(e.target.value)}
            className="font-mono text-xs"
          />
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={feedEnabled}
              onChange={(e) => setFeedEnabled(e.target.checked)}
              className="size-4 rounded border-line accent-accent"
            />
            Activé
          </label>
          <p className="text-xs text-faint">
            Rejouer avec le même type + label met à jour ce feed (params, activé) plutôt que
            d&apos;en créer un second.
          </p>
          <Button type="submit" disabled={submittingFeed || !feedLabel.trim()}>
            {submittingFeed ? "Enregistrement…" : "Ajouter"}
          </Button>
        </form>
      </SectionCard>

      <SectionCard
        title="Feeds"
        badge={<span className="text-[11px] text-faint tabular-nums">{feeds.length}</span>}
      >
        {feeds.length === 0 ? (
          <p className="text-sm text-muted">Aucun feed pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-2">
            {feeds.map((f) => (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-sm"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] font-medium tracking-widest text-muted uppercase">
                    {f.kind === "account" ? "compte" : "recherche"}
                  </span>
                  <span className="font-medium">{f.label}</span>
                  {Object.keys(f.params ?? {}).length > 0 && (
                    <code
                      className="max-w-64 truncate font-mono text-xs text-muted"
                      title={JSON.stringify(f.params)}
                    >
                      {JSON.stringify(f.params)}
                    </code>
                  )}
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-widest uppercase ${
                      f.enabled
                        ? "border-success/30 bg-success/10 text-success"
                        : "border-line bg-raised text-muted"
                    }`}
                  >
                    {f.enabled ? "activé" : "désactivé"}
                  </span>
                  {f.lastFetchedAt ? (
                    <span className="text-[11px] text-faint tabular-nums">
                      dernier passage {new Date(f.lastFetchedAt).toLocaleString("fr-FR")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-faint">jamais interrogé</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggleFeed(f.id, !f.enabled)}>
                    {f.enabled ? "Désactiver" : "Activer"}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => removeFeed(f.id)}>
                    Supprimer
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Réglages">
        {!loadedSettings ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : (
          <form onSubmit={saveSettings} className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Thèmes</p>
              <div className="flex flex-wrap gap-1.5">
                {topicsDraft.map((t) => (
                  <span
                    key={t}
                    className="flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-xs text-ink"
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTopic(t)}
                      aria-label={`Retirer le thème ${t}`}
                      className="text-faint hover:text-danger"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {topicsDraft.length === 0 && (
                  <span className="text-xs text-faint">Aucun thème pour l&apos;instant.</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="ajouter un thème…"
                  value={topicInput}
                  onChange={(e) => setTopicInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTopic();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addTopic}>
                  Ajouter
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Style</p>
              <Textarea
                value={styleDraft}
                onChange={(e) => {
                  setStyleDraft(e.target.value);
                  setSettingsSaved(false);
                }}
                placeholder="ex: punchy, phrases courtes, pas de jargon"
                className="text-sm"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={requireMediaDraft}
                onChange={(e) => {
                  setRequireMediaDraft(e.target.checked);
                  setSettingsSaved(false);
                }}
                className="size-4 rounded border-line accent-accent"
              />
              Média exigé (le worker n&apos;adapte que les items avec visuel)
            </label>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Canal de validation</p>
              <select
                value={channelKeyDraft}
                onChange={(e) => {
                  setChannelKeyDraft(e.target.value);
                  setSettingsSaved(false);
                }}
                className="h-8 rounded-lg border border-line bg-transparent px-2.5 text-sm text-ink outline-none focus-visible:border-accent"
              >
                <option value="">— choisir un canal —</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.key}>
                    {c.name} ({c.key})
                  </option>
                ))}
              </select>
              <p className="text-xs text-faint">
                Canal sur lequel une validation crée son contenu — requis pour pouvoir valider.
              </p>
            </div>

            {settingsSaved && !error && <p className="text-sm text-success">Enregistré.</p>}
            <Button type="submit" disabled={submittingSettings}>
              {submittingSettings ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </SectionCard>

      <SectionCard title="Configuration de publication">
        <div className="space-y-4">
          <p className="text-xs text-faint">
            Saisie seule : les valeurs ne sont jamais renvoyées en clair par le serveur, cette
            page n&apos;affiche donc que les clés existantes, valeur masquée. C&apos;est le
            canal que le worker lit en clair pour publier (`get_watch_config`).
          </p>

          {Object.keys(publishConfigView).length === 0 ? (
            <p className="text-sm text-muted">Aucune clé configurée pour l&apos;instant.</p>
          ) : (
            <ul className="space-y-2">
              {Object.entries(publishConfigView).map(([key, masked]) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <code className="font-mono text-xs text-ink">{key}</code>
                    <code className="font-mono text-xs text-muted">{masked}</code>
                  </span>
                  <Button variant="outline" size="sm" onClick={() => replaceKey(key)}>
                    Remplacer
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={savePublishKey} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="clé (ex: api_key)"
                value={pubKey}
                onChange={(e) => setPubKey(e.target.value)}
              />
              <Input
                placeholder="nouvelle valeur, en clair"
                value={pubValue}
                onChange={(e) => setPubValue(e.target.value)}
              />
            </div>
            <p className="text-xs text-warning">
              Enregistrer ici remplace toute la config de publication d&apos;un bloc : toute
              clé déjà en place mais non ressaisie dans CETTE session disparaît. Pour changer
              plusieurs clés, les ajouter toutes avant d&apos;enregistrer si possible.
            </p>
            {publishSaved && !error && <p className="text-sm text-success">Enregistré.</p>}
            <Button type="submit" disabled={submittingPublish || !pubKey.trim()}>
              {submittingPublish ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        </div>
      </SectionCard>
    </div>
  );
}
