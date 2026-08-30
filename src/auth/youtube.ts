import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { ENV } from "../config/env";

const youtubeOAuth2Client = new OAuth2Client(
  ENV.YOUTUBE_CLIENT_ID,
  ENV.YOUTUBE_CLIENT_SECRET,
  ENV.YOUTUBE_REDIRECT_URI
);

/**
 * Genera la URL de autenticación de YouTube.
 */
export const getAuthUrl = (): string => {
  const scopes = [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/userinfo.email",
  ];

  return youtubeOAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent", // Forzar consentimiento para obtener refresh_token
  });
};

/**
 * Intercambia el código de autorización por tokens.
 */
export const exchangeCodeForTokens = async (code: string) => {
  const { tokens } = await youtubeOAuth2Client.getToken(code);
  return tokens;
};

/**
 * Obtiene información del usuario autenticado.
 */
export const getUserInfo = async (accessToken: string) => {
  youtubeOAuth2Client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: "v2", auth: youtubeOAuth2Client });
  const { data } = await oauth2.userinfo.get();
  return data;
};