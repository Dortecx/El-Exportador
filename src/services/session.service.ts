import { Response } from "express";
import { YouTubeTokens } from "../types/auth.types";

export class SessionService {
  /**
   * Almacena tokens en cookies HTTP-only.
   */
  static setTokens(res: Response, tokens: YouTubeTokens): void {
    res.cookie("access_token", tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: tokens.expires_in * 1000, // Convertir segundos a milisegundos
    });

    res.cookie("refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 días
    });
  }

  /**
   * Marks the local web session as authenticated after ytmusicapi device OAuth succeeds.
   */
  static setAuthenticated(res: Response): void {
    res.cookie("ytmusic_session", "authenticated", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * Elimina las cookies de tokens (logout).
   */
  static logout(res: Response): void {
    res.clearCookie("access_token");
    res.clearCookie("refresh_token");
    res.clearCookie("ytmusic_session");
  }
}