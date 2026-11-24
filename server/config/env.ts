import dotenv from 'dotenv';

dotenv.config();

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  googleMapsApiKey: string;
  solutionId: string;
}

export function getServerConfig(): ServerConfig {
  // Support both server-only GOOGLE_MAPS_API_KEY and Vite-prefixed VITE_GOOGLE_MAPS_API_KEY
  const apiKey = (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    ''
  ).trim();

  const parsedPort = Number.parseInt(process.env.PORT || '3000', 10);

  return {
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    googleMapsApiKey: apiKey,
    solutionId: 'gmp_mcp_codeassist_v1_aistudio',
  };
}

export function isApiKeyConfigured(): boolean {
  const { googleMapsApiKey } = getServerConfig();
  return (
    googleMapsApiKey.length > 0 &&
    googleMapsApiKey !== 'MY_GOOGLE_MAPS_API_KEY' &&
    googleMapsApiKey !== 'YOUR_API_KEY'
  );
}
