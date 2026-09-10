import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const renderedUi = html.slice(0, html.indexOf("<script>"));
const conversionRequest = html.match(/localMutationFetch\('\/api\/convert',[\s\S]*?body: JSON\.stringify\(\{[\s\S]*?\}\)\s*\}\);/)?.[0] || "";

describe("YouTube-only destination UI", () => {
  it("renders YouTube Music as the only visible authentication destination", () => {
    expect(renderedUi).toContain('id="authBtn" type="button"');
    expect(renderedUi).toContain('src="/icons/ytmusic.svg" alt="YouTube Music"');
    expect(renderedUi).toContain('id="providerAuthStatus" role="status" aria-live="polite"');
    expect(renderedUi).not.toContain('id="spotifyAuthPanel"');
    expect(renderedUi).not.toContain('id="spotifyConnectBtn"');
    expect(renderedUi).not.toContain('alt="Spotify"');
    expect(renderedUi).not.toContain('[ CONNECT SPOTIFY ]');
  });

  it("does not expose a destination chooser or Spotify-specific UI controls", () => {
    expect(renderedUi).not.toContain('data-i18n="destination"');
    expect(renderedUi).not.toContain('destinationSpotify');
    expect(html).not.toContain("spotifyConnectBtn");
    expect(html).not.toContain("spotifyAuthPanel");
    expect(html).not.toContain("spotify-auth-complete");
  });

  it("always sends YouTube Music as the client-side conversion destination", () => {
    expect(html).toContain("const selectedDestination = 'youtube';");
    expect(html).toContain("const conversionDestination = 'youtube';");
    expect(conversionRequest).toContain("destination: 'youtube'");
    expect(conversionRequest).not.toContain("destination: conversionDestination");
    expect(conversionRequest).not.toContain("destination: selectedDestination");
  });

  it("keeps manual review on YouTube Music client routes only", () => {
    expect(html).toContain("localMutationFetch('/api/search-single'");
    expect(html).toContain("localMutationFetch('/api/add-to-playlist'");
    expect(html).toContain("prompt.textContent = t('noSuggestedMatch');");
    expect(html).toContain("manualReviewDescription.textContent = lastPlaylistId");
    expect(html).not.toContain("/api/spotify/search-single");
    expect(html).not.toContain("/api/spotify/add-to-playlist");
    expect(html).not.toContain("lastConversionProvider === 'spotify'");
  });

  it("keeps only the YouTube summary metrics visible", () => {
    expect(html).toContain("['matched', data.matched]");
    expect(html).toContain("['unmatched', data.unmatched]");
    expect(html).toContain("['ambiguous', data.ambiguous]");
    expect(html).not.toContain("['searchErrors', data.searchErrors]");
    expect(html).not.toContain("searchErrors: 'Search retry needed:'");
    expect(html).not.toContain("searchErrors: 'Reintento de búsqueda necesario:'");
    expect(html).toContain("if (Number(data.searchErrors) > 0)");
  });

  it("keeps backend-independent Spotify implementation outside this UI-only change", () => {
    expect(html).not.toContain("/api/spotify-auth/start");
    expect(html).not.toContain("/api/spotify-auth/status");
    expect(html).not.toContain("/api/spotify-auth/disconnect");
  });

  it("surfaces playlist creation failure without showing a playlist URL", () => {
    expect(html).toContain("playlistCreationFailed: 'Playlist creation failed. Matches and manual review are still available below.'");
    expect(html).toContain("const playlistCreationFailed = Boolean(data.playlistCreationFailure);");
    expect(html).toContain("if (!playlistCreationFailed && data.playlistUrl)");
    expect(html).toContain("showToast(t('playlistCreationFailed'), 'error');");
    expect(html).toContain("backendStatus.firstElementChild.className = playlistCreationFailed ? \"backend-dot unavailable\" : \"backend-dot available\";");
  });

  it("recomputes Execute eligibility after conversion cleanup instead of force-enabling it", () => {
    expect(html).not.toContain("startBtn.disabled = false");
    expect(html).toContain("startBtn.disabled = true;");
    expect(html).toContain("updateStartButton();\n                startBtn.textContent = \"[ EXECUTE ]\";");
    expect(html).toContain("updateStartButton();\n            startBtn.textContent = \"[ EXECUTE ]\";");
    expect(html).toContain("updateStartButton();\n          startBtn.textContent = \"[ EXECUTE ]\";");
  });

  it("disables Execute before preflight and restores it when preflight rejects", () => {
    const startConversion = html.slice(html.indexOf("const startConversion = async () =>"), html.indexOf("// Asignar el evento onclick"));
    const disableIndex = startConversion.indexOf("startBtn.disabled = true;\n      startBtn.textContent = t('starting');");
    const preflightIndex = startConversion.indexOf("await ensureConversionReady(conversionDestination)");
    const eventSourceIndex = startConversion.indexOf("new EventSource(");
    expect(disableIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeGreaterThan(disableIndex);
    expect(eventSourceIndex).toBeGreaterThan(preflightIndex);
    expect(startConversion).toContain("if (!await ensureConversionReady(conversionDestination)) {\n                activeConversionRun = null;\n                playConversionNotification('failure');\n                updateStartButton();\n                startBtn.textContent = \"[ EXECUTE ]\";\n                return;\n              }");
  });


  it("primes Web Audio from Execute and emits one terminal notification branch per run", () => {
    const startConversion = html.slice(html.indexOf("const startConversion = async () =>"), html.indexOf("// Asignar el evento onclick"));
    expect(html).toContain("window.AudioContext || window.webkitAudioContext");
    expect(html).toContain("async function primeNotificationAudio()");
    expect(startConversion).toContain("await primeNotificationAudio();");
    expect(html).toContain("success: [523.25, 659.25, 783.99]");
    expect(html).toContain("attention: [659.25, 659.25, 587.33]");
    expect(html).toContain("failure: [783.99, 659.25, 523.25]");
    expect(startConversion).toContain("const completedPartially = Number(data.searchErrors) > 0 || playlistCreationFailed || hasPartialInsertion;");
    expect(startConversion).toContain("playConversionNotification(completedPartially ? 'attention' : 'success');");
    expect(startConversion).toContain("playConversionNotification('failure');");
    expect(startConversion).not.toContain("playConversionNotification('cancel");
  });

  it("renders accessible dynamic manual review navigation with reduced-motion scrolling", () => {
    expect(html).toContain('class="manual-review-nav" id="manualReviewNav" hidden aria-label="Manual review navigation"');
    expect(html).toContain('id="manualReviewUp" aria-label="Scroll to the start of manual review"');
    expect(html).toContain('id="manualReviewDown" aria-label="Scroll to the end of manual review"');
    expect(html).toContain("function updateManualReviewNav()");
    expect(html).toContain("manualReviewSection.scrollHeight > viewportHeight + 1");
    expect(html).toContain("manualReviewUp.hidden = !canScrollUp;");
    expect(html).toContain("manualReviewDown.hidden = !canScrollDown;");
    expect(html).toContain("window.addEventListener('scroll', updateManualReviewNav, { passive: true });");
    expect(html).toContain("window.addEventListener('resize', updateManualReviewNav);");
    expect(html).toContain("behavior: prefersReducedMotion?.matches ? 'auto' : 'smooth'");
    expect(html).toContain("requestAnimationFrame(updateManualReviewNav);");
  });});
