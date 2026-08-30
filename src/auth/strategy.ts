export interface AuthProvider {
  login(): Promise<void>;
  logout(): Promise<void>;
  getToken(): Promise<string | null>;
}