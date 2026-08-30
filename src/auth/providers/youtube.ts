import { AuthProvider } from './strategy';
import { useOAuthPopup } from 'react-oauth-popup';

class YouTubeAuthProvider implements AuthProvider {
  private popup: any;
  private token: string | null = null;

  constructor() {
    this.popup = useOAuthPopup({
      url: 'https://accounts.google.com/o/oauth2/auth',
      width: 500,
      height: 600,
      onClose: this.handleClose.bind(this),
      onMessage: this.handleMessage.bind(this),
    });
  }

  async login(): Promise<void> {
    this.popup.open();
  }

  async logout(): Promise<void> {
    this.token = null;
    // Additional logout logic if needed
  }

  async getToken(): Promise<string | null> {
    return this.token;
  }

  private handleClose(): void {
    this.popup.close();
  }

  private handleMessage(event: MessageEvent): void {
    if (event.origin !== 'https://accounts.google.com') {
      return;
    }
    const data = event.data;
    if (data.token) {
      this.token = data.token;
      this.popup.close();
      // Send token to backend for validation
      fetch('https://your-backend.com/api/validate-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: this.token }),
      });
    }
  }
}

export default YouTubeAuthProvider;