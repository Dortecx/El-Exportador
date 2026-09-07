import type { AuthProvider } from "../strategy";

type OAuthMessage = { token?: unknown };

export class YouTubeAuthProvider implements AuthProvider {
  private popup: Window | null = null;
  private token: string | null = null;

  async login(): Promise<void> {
    this.popup = window.open(
      "https://accounts.google.com/o/oauth2/auth",
      "youtube-oauth",
      "width=500,height=600",
    );
    if (!this.popup) throw new Error("Unable to open the YouTube authentication window");
    window.addEventListener("message", this.handleMessage);
  }

  async logout(): Promise<void> {
    this.token = null;
    this.handleClose();
  }

  async getToken(): Promise<string | null> {
    return this.token;
  }

  private handleClose = (): void => {
    window.removeEventListener("message", this.handleMessage);
    this.popup?.close();
    this.popup = null;
  };

  private handleMessage = (event: MessageEvent<OAuthMessage>): void => {
    if (event.origin !== "https://accounts.google.com") return;
    if (typeof event.data?.token !== "string") return;
    this.token = event.data.token;
    this.handleClose();
  };
}

export default YouTubeAuthProvider;
