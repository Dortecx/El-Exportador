import { create } from 'zustand';

interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  provider: string | null;
  setCredentials: (token: string, provider: string) => void;
  clearCredentials: () => void;
}

const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  token: null,
  provider: null,
  setCredentials: (token: string, provider: string) => set({
    isAuthenticated: true,
    token,
    provider,
  }),
  clearCredentials: () => set({
    isAuthenticated: false,
    token: null,
    provider: null,
  }),
}));

// Exponer el store globalmente para que el frontend pueda acceder a él
if (typeof window !== 'undefined') {
  (window as any).authStore = useAuthStore;
}

export default useAuthStore;