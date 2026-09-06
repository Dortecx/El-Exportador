export const ENV = {
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || "",
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || "",
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI || "http://localhost:3000/auth/callback",
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID || "",
  PORT: process.env.PORT || 3000,
};

export function resolveSpotifyRedirectUri(port: number | string = ENV.PORT): string {
  return `http://127.0.0.1:${String(port)}/api/spotify-auth/callback`;
}
