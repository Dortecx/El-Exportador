export const ENV = {
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || "",
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || "",
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI || "http://localhost:3000/auth/callback",
  PORT: process.env.PORT || 3000,
};