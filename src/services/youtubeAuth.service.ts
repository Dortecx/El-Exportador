import { OAuth2Client } from "google-auth-library";
import { ENV } from "../config/env";
import { YouTubeTokens, UserInfo } from "../types/auth.types";

export class YouTubeAuthService {
  private static oauth2Client = new OAuth2Client(
    ENV.YOUTUBE_CLIENT_ID,
    ENV.YOUTUBE_CLIENT_SECRET,
    ENV.YOUTUBE_REDIRECT_URI
  );

  /**
   * Genera la URL de autenticación con Google OAuth.
   */
  static generateAuthUrl(): string {
    const scopes = [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
      "https://www.googleapis.com/auth/userinfo.email",
    ];

    if (!ENV.YOUTUBE_CLIENT_ID || !ENV.YOUTUBE_CLIENT_SECRET) {
      throw new Error("YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required");
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: scopes,
      state: Math.random().toString(36).substring(2), // Protección CSRF
    });
  }

  /**
   * Intercambia el código de autorización por tokens.
   */
  static async exchangeCodeForTokens(code: string): Promise<YouTubeTokens> {
    const { tokens } = await this.oauth2Client.getToken(code);
    return {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token!,
      expires_in: tokens.expiry_date ? Math.floor((tokens.expiry_date - Date.now()) / 1000) : 3600,
    };
  }

  /**
   * Obtiene información del usuario usando el access_token.
   */
  static async getUserInfo(accessToken: string): Promise<UserInfo> {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const data = await response.json();
    return {
      id: data.id,
      email: data.email,
      name: data.name,
    };
  }
}