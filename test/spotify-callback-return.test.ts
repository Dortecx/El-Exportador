import { describe, expect, it } from "vitest";
import { renderSpotifyCallbackReturnPage } from "../src/web/server.js";

describe("Spotify OAuth callback return page", () => {
  it("returns a bounded success message to the origin bound at auth start without exposing callback data", () => {
    const returnOrigin = "http://127.0.0.1:4312";
    const page = renderSpotifyCallbackReturnPage({
      returnOrigin,
      status: "connected",
      reason: "provider-error-description",
    });

    expect(page).toContain('type: "spotify-auth-complete"');
    expect(page).toContain('status: "connected"');
    expect(page).toContain("reason: null");
    expect(page).toContain(`const targetOrigin = "${returnOrigin}"`);
    expect(page).toContain("window.opener.postMessage(message, targetOrigin)");
    expect(page).not.toContain("window.location.origin");
    expect(page).not.toContain('postMessage(message, "*")');
    expect(page).toContain("window.close()");
    expect(page).not.toContain("provider-error-description");
    expect(page).not.toContain("client_id");
    expect(page).not.toContain("code=");
    expect(page).not.toContain("access-token");
    expect(page).not.toContain("refresh-token");
    expect(page).not.toContain("code-verifier");
  });

  it("returns a bounded error message and redirects to the local app when no bound opener origin exists", () => {
    const page = renderSpotifyCallbackReturnPage({
      status: "error",
      reason: "access_denied: provider details",
    });

    expect(page).toContain('status: "error"');
    expect(page).toContain('reason: "authentication_failed"');
    expect(page).toContain('window.location.replace("/")');
    expect(page).not.toContain("access_denied: provider details");
  });
});
