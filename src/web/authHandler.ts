import { Request, Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { SessionService } from "../services/session.service";
import { YouTubeAuthService } from "../services/youtubeAuth.service";

const YTMUSIC_SCOPE = "https://www.googleapis.com/auth/youtube";
const authDir = path.join(os.homedir(), ".config", "m3u-to-ytmusic");
const ytmusicOAuthPath = path.join(authDir, "ytmusic_oauth.json");

/** Starts the single Google web OAuth flow used by the UI and ytmusicapi. */
export const handleAuthRequest = (_req: Request, res: Response) => {
  res.redirect(YouTubeAuthService.generateAuthUrl());
};

/** Exchanges the web code and persists a refreshable token for ytmusicapi. */
export const handleAuthCallback = async (req: Request, res: Response) => {
  const { code } = req.query;
  if (!code || typeof code !== "string") {
    res.status(400).send("Invalid authorization code");
    return;
  }

  try {
    const tokens = await YouTubeAuthService.exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token. Re-authorize with consent.");
    }

    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const ytmusicToken = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
      scope: YTMUSIC_SCOPE,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
      expires_in: tokens.expires_in,
    };
    fs.writeFileSync(ytmusicOAuthPath, JSON.stringify(ytmusicToken, null, 2), {
      mode: 0o600,
    });

    SessionService.setAuthenticated(res);
    res.redirect("/");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OAuth callback error";
    console.error(`Web OAuth callback failed: ${message}`);
    res.redirect("/?auth=error");
  }
};
