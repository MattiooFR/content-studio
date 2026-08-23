import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Image Docker minimale. Next trace les dépendances réellement importées par
  // le code et écrit dans .next/standalone un serveur node autonome + le seul
  // sous-ensemble de node_modules qu'il utilise. Sans cette clé, l'image finale
  // devait embarquer node_modules en entier (devDependencies comprises).
  output: "standalone",
};

export default nextConfig;
