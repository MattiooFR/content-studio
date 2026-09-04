"""Transcripteur résident : charge mlx-whisper UNE fois, puis transcrit à la
demande. Un chemin .wav par ligne sur stdin → une ligne JSON sur stdout.

Piloté par scripts/worker.mjs. Le modèle reste en mémoire GPU : une dictée de
30 s revient en ~2 s au lieu de ~20 s si on relançait le processus à chaque
fois. Repris de formation-vdl-review/transcribe-worker.py.
"""
import json
import os
import sys
import time

import mlx_whisper

MODEL = os.environ.get("CS_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
LANG = os.environ.get("CS_WHISPER_LANG", "fr")
# Amorçage : sans vocabulaire, « Claude Code » devient « Cloud code » et
# « netlinking » « net linking ». Surchargeable par CS_WHISPER_PROMPT.
PROMPT = os.environ.get(
    "CS_WHISPER_PROMPT",
    "Dictée pour un studio de contenu sur l'IA, le SEO et le no-code. "
    "Vocabulaire : Claude, Claude Code, ChatGPT, GPT, OpenAI, Anthropic, MCP, agent, "
    "prompt, LLM, RAG, workflow, n8n, Make, Zapier, Supabase, Next.js, Vercel, WordPress, "
    "SEO, backlink, netlinking, Search Console, La Minute IA, LinkQuiver, GetLinkFast, "
    "newsletter, YouTube, tuto, communauté.",
)


def warm():
    """Premier appel = téléchargement/compilation : au démarrage, pas à la première dictée."""
    import numpy as np
    mlx_whisper.transcribe(
        np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language=LANG, verbose=False
    )


def hallucine(texte):
    """Whisper boucle parfois sur les silences : un segment long et très répétitif est écarté."""
    mots = texte.split()
    return len(mots) > 20 and len(set(mots)) / len(mots) < 0.25


warm()
print(json.dumps({"ready": True}), flush=True)

for ligne in sys.stdin:
    chemin = ligne.strip()
    if not chemin:
        continue
    t0 = time.time()
    try:
        res = mlx_whisper.transcribe(
            chemin,
            path_or_hf_repo=MODEL,
            language=LANG,
            initial_prompt=PROMPT,
            condition_on_previous_text=False,
            verbose=False,
        )
        morceaux = [
            s["text"].strip()
            for s in res["segments"]
            if s["text"].strip() and not hallucine(s["text"].strip())
        ]
        print(json.dumps({"text": " ".join(morceaux), "sec": round(time.time() - t0, 1)}), flush=True)
    except Exception as e:  # noqa: BLE001 — l'erreur remonte au worker, qui fail_job
        print(json.dumps({"error": str(e)[:300]}), flush=True)
