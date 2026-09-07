import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

describe("provider status and destination UI", () => {
  it("renders one accessible, icon-free neutral provider status", () => {
    expect(html).toContain('id="providerAuthStatus" role="status" aria-live="polite"');
    expect(html).toContain('providerAuthIcon.hidden = !showIcon');
    expect(html).not.toContain('id="authStatus"');
    expect(html).not.toContain('id="spotifyAuthStatus"');
  });

  it("uses local accessible provider icons and aligns them with control/status text", () => {
    expect(html).toContain('src="/icons/spotify.svg" alt="Spotify"');
    expect(html).toContain('src="/icons/ytmusic.svg" alt="YouTube Music"');
    expect(html).toContain('vertical-align: -0.125em');
    expect(html).toContain('#providerAuthText');
    expect(html).toContain('line-height: 1');
    expect(html).not.toMatch(/(?:src|href)="https?:\/\/[^\"]*(?:spotify|youtube|icon)/i);
  });

  it("uses one toggle per provider with the same localized disconnect label", () => {
    expect(html).toContain('id="authBtn" type="button"');
    expect(html).toContain('id="spotifyConnectBtn" type="button"');
    expect(html).toContain("if (youtubeAuthenticated)");
    expect(html).toContain("if (spotifyDestination.connected)");
    expect(html).toContain("spotifyAuthButtonLabel.textContent = t(spotifyDestination.connected ? 'disconnect' : 'spotifyConnect');");
    expect(html).toContain("youtubeAuthButtonLabel.textContent = t(youtubeAuthenticated ? 'disconnect' : 'connect');");
    expect(html).not.toContain('disconnectAuthBtn');
    expect(html).not.toContain('spotifyDisconnectBtn');
    expect(html).not.toContain('DISCONNECT SPOTIFY');
    expect(html).not.toContain('DESCONECTAR SPOTIFY');
  });

  it("uses collision-resistant in-memory local UI and conversion run identifiers", () => {
    expect(html).toContain("const localUiClientId = crypto.getRandomValues(new Uint8Array(32)).reduce((value, byte) => value + byte.toString(16).padStart(2, '0'), '');");
    expect(html).toContain("const runId = crypto.getRandomValues(new Uint8Array(32)).reduce((value, byte) => value + byte.toString(16).padStart(2, '0'), '');");
    expect(html).toContain("async function localMutationFetch(path, options = {})");
    expect(html).toContain("headers.set('X-Local-UI-Capability', capability);");
    expect(html).toContain("/api/convert-progress?clientId=${encodeURIComponent(localUiClientId)}&runId=${encodeURIComponent(runId)}&capability=${encodeURIComponent(capability)}");
    expect(html).toMatch(/body: JSON\.stringify\(\{[\s\S]*?runId,\s*destination: conversionDestination/);
  });

  it("preserves guarded Spotify callbacks and selected conversion destinations", () => {
    const callbackSelection = html.indexOf("if (spotifyCallback.status === 'connected') selectedDestination = 'spotify';");
    expect(callbackSelection).toBeGreaterThan(-1);
    expect(html.indexOf('await refreshProviderStates();', callbackSelection)).toBeGreaterThan(callbackSelection);
    expect(html).toContain("spotifyCallback.type !== 'spotify-auth-complete'");
    expect(html).toContain("event.origin !== window.location.origin && event.origin !== spotifyLoopbackCallbackOrigin");
    expect(html).toContain('destination: conversionDestination');
    expect(html).not.toContain('destination: selectedDestination');
  });

  it("pulses provider status illumination while keeping text static and glitch layers horizontal", () => {
    const pulse = html.match(/@keyframes auth-status-pulse \{[\s\S]*?\n    \}/)?.[0] || "";
    const reducedMotion = html.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?#providerAuthStatus\.auth-status-pulse \{[\s\S]*?\n      \}\n    \}/)?.[0] || "";

    expect(pulse).toContain('filter: brightness(1.35)');
    expect(pulse).toContain('text-shadow: -9px 0 #00E1FF, 9px 0 #FF3366');
    expect(pulse).toContain('text-shadow: 9px 0 #00E1FF, -9px 0 #FF3366');
    expect(pulse).not.toMatch(/(?:opacity|transform|scale|skew)\s*:/);
    expect(html).toContain('animation: auth-status-pulse 2200ms ease-in-out infinite');
    expect(html).not.toContain('auth-status-pulse 900ms ease-out forwards');
    expect(reducedMotion).toContain('animation: none;');
    expect(reducedMotion).toContain('filter: none;');
    expect(reducedMotion).toContain('opacity: 1;');
    expect(reducedMotion).toContain('text-shadow: none;');
    expect(reducedMotion).toContain('transform: none;');
    expect(html).toContain("function setProviderAuthStatus(provider, message, color, shouldPulse = true, showIcon = false)");
    expect(html).toContain("authStatus.classList.toggle('auth-status-pulse', shouldPulse)");
    expect(html).toContain("setProviderAuthStatus('spotify', message, spotifyDestination.connected ? '#00FF88' : '#5588BB', true, spotifyDestination.connected);");
    expect(html).toContain("setProviderAuthStatus('youtube', youtubeAuthenticated ? t('authConnected') : t('authUnauthenticated'), youtubeAuthenticated ? '#00FF88' : '#5588BB', true, youtubeAuthenticated);");
    expect(html).toContain("setProviderAuthStatus('spotify', t('spotifyConnecting'), '#00AAFF', true)");
    expect(html).toContain("setAuthStatus(t('authWaiting'), '#00AAFF')");
    expect(html).toContain("setAuthStatus(t('authFailed'), '#FF4444')");
    expect(html).toContain("setAuthStatus(t('authRequired'), '#FF4444')");
    expect(html).not.toContain('spotify-auth-status-pulse');
  });

  it("preserves provider color states, summary behavior, and manual-review routes", () => {
    expect(html).toContain("spotifyConnectBtn.classList.toggle('spotify-auth-btn', !spotifyDestination.connected);");
    expect(html).toContain("spotifyConnectBtn.classList.toggle('spotify-disconnect', spotifyDestination.connected);");
    expect(html).toContain('color: #00FF88;');
    expect(html).toContain('color: #FF5577;');
    expect(html).toContain("[['matched', data.matched], ['unmatched', data.unmatched], ['ambiguous', data.ambiguous]]");
    expect(html).toContain("'/api/spotify/search-single'");
    expect(html).toContain("'/api/spotify/add-to-playlist'");
  });

  it("reports bounded partial and zero Spotify insertions without exposing provider errors or identifiers", () => {
      expect(html).toContain("const insertedCount = Number(data.sideEffects?.inserted);");
      expect(html).toContain("const hasPartialInsertion = Boolean(data.playlistId)");
      expect(html).toContain("insertedCount >= 0");
      expect(html).toContain("insertedCount < matchedCount;");
      expect(html).toContain("t('partialInsertion', { inserted: insertedCount, matched: matchedCount })");
      expect(html).toContain("partialInsertion: 'Playlist created with partial insertion: {inserted} of {matched} matched tracks added.'");
      expect(html).toContain("partialInsertion: 'Playlist creada con inserción parcial: {inserted} de {matched} pistas coincidentes añadidas.'");
      expect(html).not.toContain("partialInsertion: 'Playlist created with partial insertion: {inserted} of {matched} matched tracks added. {error}'");
    });

    it("opens Spotify SSE manual review with URI candidates and searchable unmatched rows", () => {
    expect(html).toContain("lastConversionProvider = data.provider || conversionDestination;");
    expect(html).toContain("lastConversionResults = data.manualReviewTracks ||");
    expect(html).toContain("if (lastConversionResults.length > 0) {");
    expect(html).toContain("showManualReview();");
    expect(html).toContain("const initialCandidates = [track.bestMatch, ...(track.alternatives || [])]");
    expect(html).toContain("lastConversionProvider === 'spotify' ? candidate?.uri : candidate?.videoId");
    expect(html).toContain("if (initialCandidates.length) {");
    expect(html).toContain("prompt.textContent = t(lastConversionProvider === 'spotify' ? 'noSuggestedMatchSpotify' : 'noSuggestedMatch');");
  });

  it("uses Spotify-only manual-review copy while preserving YouTube Music copy", () => {
    expect(html).toContain("chooseSuggestionSpotify: 'Choose a suggestion or search Spotify");
    expect(html).toContain("noSuggestedMatchSpotify: 'No suggested match. Search Spotify");
    expect(html).toContain("? t(lastConversionProvider === 'spotify' ? 'chooseSuggestionSpotify' : 'chooseSuggestion')");
    expect(html).toContain("? 'noSuggestedMatchSpotify' : 'noSuggestedMatch'");
    expect(html).toContain("noSuggestedMatch: 'No suggested match. Search YouTube Music");
  });

  it("renders Spotify albumName when supplied and selects candidates exclusively by URI", () => {
    expect(html).toContain("const album = candidate.albumName || candidate.album?.name || candidate.album || t('unknownAlbum');");
    expect(html).toContain("function getManualCandidateId(candidate)");
    expect(html).toContain("lastConversionProvider === 'spotify' ? candidate?.uri : candidate?.videoId");
    expect(html).toContain("option.dataset.candidateId = candidateId;");
    expect(html).toContain("element.dataset.candidateId === candidateId");
    expect(html).toContain("if (!candidateId || seenCandidateIds.has(candidateId)) return false;");
    expect(html).not.toContain("candidate.videoId || candidate.uri");
  });

  it("keeps Spotify dry-run manual additions disabled and side-effect free", () => {
    expect(html).toContain("const manualAddAvailable = Boolean(lastPlaylistId) && !lastConversionDryRun;");
    expect(html).toContain("if (lastConversionDryRun || !lastPlaylistId || !manualSelections.size) return;");
    expect(html).toContain("lastConversionDryRun = conversionDryRun;");
    expect(html).toContain("dryRun.addEventListener('change', updateManualAddButton);");
  });

  it("bootstraps a persisted Spotify session with a loaded M3U before enabling Execute", () => {
    expect(html).toContain("async function refreshProviderStates()");
    expect(html).toContain("await Promise.all([checkAuthStatus(false), refreshSpotifyStatus(false)]);");
    expect(html).toContain("await refreshProviderStates();");
    expect(html).toContain("else if (selectedDestination === 'youtube' && spotifyDestination.connected) selectedDestination = 'spotify';");
    expect(html).toContain("startBtn.disabled = !dropZone.classList.contains('has-file') || !destinationReady;");
  });

  it("preflights the selected provider before changing conversion state or opening SSE", () => {
      const readinessCheck = html.match(/async function ensureConversionReady\(destination\)[\s\S]*?(?=\n\s*const startConversion)/)?.[0] || "";
      const conversion = html.match(/const startConversion = async \(\) => \{[\s\S]*?(?=\n\s*\/\/ Asignar el evento)/)?.[0] || "";
      expect(readinessCheck).toContain("localMutationFetch('/api/conversion-preflight'");
      expect(readinessCheck).toContain("body: JSON.stringify({ destination })");
      expect(readinessCheck).toContain("payload?.status === 'ready'");
          expect(readinessCheck).toContain("payload?.status === 'not_ready'");
          const spotifyAuthorizationPreflight = readinessCheck.match(
            /const spotifyAuthorizationRequired = destination === 'spotify'\s*&& response\.ok\s*&& payload\?\.status === 'not_ready'\s*&& payload\?\.code === 'AUTHORIZATION_REQUIRED';\s*if \(spotifyAuthorizationRequired\) \{\s*await disconnectSpotify\(\);\s*showToast\(t\('spotifyAuthorizationRequired'\), 'error'\);[\s\S]*?return false;/,
          )?.[0] || "";
          expect(spotifyAuthorizationPreflight).not.toBe("");
      expect(readinessCheck).toContain("payload?.code === 'AUTHENTICATION_REQUIRED'");
      expect(readinessCheck).toContain("await disconnectSpotify();");
      expect(readinessCheck).toContain("await disconnectYtMusic();");
      expect(html).toContain("async function disconnectSpotify()");
      expect(html).toContain("await refreshProviderStates();");
      expect(conversion.indexOf("const conversionDestination = selectedDestination;")).toBeGreaterThan(-1);
       expect(conversion.indexOf("if (!await ensureConversionReady(conversionDestination)) return;")).toBeGreaterThan(-1);
      expect(conversion.indexOf("if (!await ensureConversionReady(conversionDestination)) return;")).toBeLessThan(conversion.indexOf("startBtn.disabled = true;"));
      expect(conversion.indexOf("if (!await ensureConversionReady(conversionDestination)) return;")).toBeLessThan(conversion.indexOf("new EventSource("));
    });

    it("automatically cleans up only auth-invalid preflight results with fake provider controls", async () => {
      const readinessCheck = html.match(/async function ensureConversionReady\(destination\)[\s\S]*?(?=\n\s*const startConversion)/)?.[0];
      if (!readinessCheck) throw new Error("conversion preflight handler was not found");
      const spotifyDisconnect = vi.fn(async () => {});
      const youtubeDisconnect = vi.fn(async () => {});
      const showToast = vi.fn();
      const ensureConversionReady = new Function(
        "localMutationFetch", "disconnectSpotify", "disconnectYtMusic", "showToast", "t", `${readinessCheck}; return ensureConversionReady;`,
      );
      const withPreflight = (payload: unknown, ok = false) => ensureConversionReady(
        vi.fn(async () => ({ ok, json: async () => payload })),
        spotifyDisconnect, youtubeDisconnect, showToast, (key: string) => key,
      );

      await expect(withPreflight({ code: "AUTHENTICATION_REQUIRED" })("spotify")).resolves.toBe(false);
      expect(spotifyDisconnect).toHaveBeenCalledOnce();
      expect(youtubeDisconnect).not.toHaveBeenCalled();

      await expect(withPreflight({ code: "AUTHENTICATION_REQUIRED" })("youtube")).resolves.toBe(false);
      expect(youtubeDisconnect).toHaveBeenCalledOnce();

      spotifyDisconnect.mockClear();
      youtubeDisconnect.mockClear();
      await expect(withPreflight({ code: "AUTHORIZATION_REQUIRED", status: "not_ready" }, true)("spotify")).resolves.toBe(false);
      expect(spotifyDisconnect).toHaveBeenCalledOnce();
      expect(showToast).toHaveBeenLastCalledWith("spotifyAuthorizationRequired", "error");

          spotifyDisconnect.mockClear();
          youtubeDisconnect.mockClear();
          showToast.mockClear();
          await expect(withPreflight({ code: "AUTHORIZATION_REQUIRED", status: "not_ready" })("spotify")).resolves.toBe(false);
          expect(spotifyDisconnect).not.toHaveBeenCalled();
          expect(showToast).toHaveBeenCalledWith("conversionError");

      spotifyDisconnect.mockClear();
      youtubeDisconnect.mockClear();
      await expect(withPreflight({ code: "PROVIDER_UNAVAILABLE" })("spotify")).resolves.toBe(false);
      await expect(withPreflight({ code: "PROVIDER_UNAVAILABLE" })("youtube")).resolves.toBe(false);
      expect(spotifyDisconnect).not.toHaveBeenCalled();
      expect(youtubeDisconnect).not.toHaveBeenCalled();
    });

    it("settles fake conversion streams before classified Spotify POST handling and ignores their close errors", () => {
      const conversion = html.match(/const startConversion = async \(\) => \{[\s\S]*?(?=\n\s*\/\/ Asignar el evento)/)?.[0] || "";
      const settleSource = conversion.match(/const settleConversionRun = \(\) => \{[\s\S]*?\n\s*\};/)?.[0];
      if (!settleSource) throw new Error("conversion settlement handler was not found");
      const stream = { close: vi.fn() };
      const run = { destination: "spotify", eventSource: stream, settled: false };
      const settleConversionRun = new Function("conversionRun", "eventSource", `${settleSource}; return settleConversionRun;`)(run, stream);

      settleConversionRun();
      settleConversionRun();

      expect(run.settled).toBe(true);
      expect(stream.close).toHaveBeenCalledOnce();
      expect(conversion).toContain("const conversionDestination = selectedDestination;");
      expect(conversion).toContain("destination: conversionDestination");
      expect(conversion).toContain("const isSpotifyRun = conversionDestination === 'spotify';");
      expect(conversion).toContain("lastConversionProvider = data.provider || conversionDestination;");
      expect(conversion).toContain("if (conversionRun.settled) return;");
      expect(conversion.indexOf("if (conversionRun.settled) return;", conversion.indexOf("conversionRun.eventSource.onerror"))).toBeGreaterThan(conversion.indexOf("conversionRun.eventSource.onerror"));
      expect(conversion.indexOf("settleConversionRun();", conversion.indexOf("if (classifiedFailure)"))).toBeGreaterThan(conversion.indexOf("if (classifiedFailure)"));
      expect(conversion).toContain("showToast(spotifyConversionErrorMessage(error));");
    });

    it("renders exact bounded Spotify authentication and playlist-authorization guidance", () => {
      expect(html).toContain("spotifyAuthenticationRequired: 'Spotify authentication is required. Please reconnect.'");
      expect(html).toContain("spotifyAuthorizationRequired: 'Spotify authorization is required to create playlists. Please reconnect and approve playlist access.'");
      expect(html).toContain("spotifyAuthenticationRequired: 'Se requiere autenticación de Spotify. Vuelve a conectar.'");
      expect(html).toContain("spotifyAuthorizationRequired: 'Se requiere autorización de Spotify para crear playlists. Vuelve a conectar y aprueba el acceso a playlists.'");
      expect(html).toContain("payload?.code === 'SPOTIFY_AUTHORIZATION_REQUIRED'");
      expect(html).toContain("showToast(spotifyConversionErrorMessage(payload), 'error');");
      expect(html).not.toContain("showToast(t('spotifyNotConnected'), 'error');");
    });

    it("classifies only coherent Spotify auth statuses and codes before settling the stream", () => {
      const conversion = html.match(/const startConversion = async \(\) => \{[\s\S]*?(?=\n\s*\/\/ Asignar el evento)/)?.[0] || "";

      expect(html).toContain("const spotifyAuthenticationRequired = response.status === 401 && payload?.code === 'SPOTIFY_AUTHENTICATION_REQUIRED';");
      expect(html).toContain("const spotifyAuthorizationRequired = response.status === 403 && payload?.code === 'SPOTIFY_AUTHORIZATION_REQUIRED';");
      expect(html).toContain("const youtubeAuthenticationRequired = response.status === 401 && payload?.code === 'AUTHENTICATION_REQUIRED';");
      expect(html).toContain("if (!youtubeAuthenticationRequired) return false;");
      expect(conversion).toContain("const spotifyAuthenticationRequired = isSpotifyRun && response.status === 401");
      expect(conversion).toContain("const spotifyAuthorizationRequired = isSpotifyRun && response.status === 403");
      expect(conversion).toContain("const youtubeAuthenticationRequired = !isSpotifyRun && response.status === 401");
      const classifiedPostBlock = conversion.match(
        /if \(classifiedFailure\) \{\s*settleConversionRun\(\);\s*if \(authenticationRequired \|\| authorizationRequired\) \{\s*await handleAuthenticationRequired\(response, error\);[\s\S]*?return;\s*\}/,
      )?.[0] || "";
      expect(classifiedPostBlock).not.toBe("");
      expect(classifiedPostBlock.indexOf("settleConversionRun();")).toBeLessThan(classifiedPostBlock.indexOf("await handleAuthenticationRequired(response, error);"));
      expect(classifiedPostBlock.indexOf("await handleAuthenticationRequired(response, error);")).toBeLessThan(classifiedPostBlock.indexOf("return;"));
      expect(classifiedPostBlock).not.toContain("showToast(t('conversionError'));");
      expect(conversion).not.toContain("error?.code === 'SPOTIFY_AUTHENTICATION_REQUIRED' || error?.code === 'AUTHENTICATION_REQUIRED'");
    });

    it("renders bounded Spotify rate-limit and provider failures without disconnecting", () => {
      expect(html).toContain("function spotifyConversionErrorMessage(payload)");
      expect(html).toContain("payload?.code === 'SPOTIFY_RATE_LIMITED'");
      expect(html).toContain("payload?.code === 'SPOTIFY_REQUEST_REJECTED'");
      expect(html).toContain("payload?.error || t('spotifyRequestRejected')");
      expect(html).toContain("payload?.code === 'SPOTIFY_PROVIDER_UNAVAILABLE'");
      expect(html).toContain("spotifyRateLimited: 'Spotify is rate limited. Please try again shortly.'");
      expect(html).toContain("spotifyRequestRejected: 'Spotify rejected the request. Check the playlist details and selected tracks, then try again.'");
      expect(html).toContain("spotifyProviderUnavailable: 'Spotify is unavailable. Please try again shortly.'");
    });

    it("localizes manual actions, associates upload inputs with labels, and exposes intermediate progress to assistive technology", () => {
        expect(html).toContain('label class="file-upload" id="dropZone" for="fileInput" tabindex="0" role="button" aria-describedby="uploadHintText"');
        expect(html).toContain('<label for="m3uContent" data-i18n="m3uContent">');
        expect(html).toContain('<label for="playlistName" data-i18n="playlistName">');
        expect(html).toContain("search: '[ BUSCAR ]'");
        expect(html).toContain("button.textContent = t('search');");
        expect(html).toContain('aria-valuenow="0" role="progressbar"');
        expect(html).toContain('progressTrack.setAttribute("aria-valuenow", String(percent));');
        expect(html).toContain('progressBar.parentElement.setAttribute("aria-valuenow", "100");');
      });

      it("falls back after either provider disconnects and remains neutral when neither is connected", () => {
    expect(html).toContain("if (selectedDestination === 'spotify' && youtubeAuthenticated) selectedDestination = 'youtube';");
    expect(html).toContain("else if (selectedDestination === 'youtube' && spotifyDestination.connected) selectedDestination = 'spotify';");
    expect(html).toContain("void refreshProviderStates();");
    expect(html).toContain("await refreshProviderStates();");
    expect(html).toContain("setProviderAuthStatus('youtube', youtubeAuthenticated ? t('authConnected') : t('authUnauthenticated')");
  });

  it("keeps the upload, connection status, and Execute control in one bounded panel without cancellation UI", () => {
    const upperPanelStart = html.indexOf('<div class="card conversion-panel">');
    const progressPanelStart = html.indexOf('<div class="card" style="margin-top: 1.5rem; max-width: 800px;');
    const upperPanel = html.slice(upperPanelStart, progressPanelStart);

    expect(upperPanelStart).toBeGreaterThan(-1);
    expect(html).toContain('.conversion-panel {');
    expect(upperPanel).toContain('<div class="icon">[FILE]</div>');
    expect(upperPanel).toContain('data-i18n="uploadDrop">Drop .m3u file here</div>');
    expect(upperPanel).toContain('id="providerAuthStatus"');
    expect(upperPanel).toContain('id="startBtn" disabled>[ EXECUTE ]</button>');
    expect(html).toContain('filename.textContent = `[OK] ${file.name}`;');
    expect(html).not.toContain('file.name.toUpperCase');
    expect(html).not.toContain('id="cancelBtn"');
    expect(html).not.toContain('const cancelBtn');
  });
});
