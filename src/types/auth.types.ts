export interface YouTubeTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
}