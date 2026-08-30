import React, { useEffect } from 'react';
import OAuthPopup from 'react-oauth-popup';
import useAuthStore from '../store/authStore';

interface OAuthPopupProps {
  onAuthSuccess: (token: string) => void;
}

const OAuthPopupComponent: React.FC<OAuthPopupProps> = ({ onAuthSuccess }) => {
  const setAuthToken = useAuthStore((state) => state.setCredentials);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      
      if (event.data.type === 'OAUTH_SUCCESS') {
        const token = event.data.token;
         setAuthToken(token, "youtube");
         onAuthSuccess(token);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onAuthSuccess, setAuthToken]);

  return (
    <OAuthPopup
      url="/auth"
      title="Autenticación con YouTube Music"
      width={600}
      height={600}
      onCode={async (code) => {
        const response = await fetch('/auth/validate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: code }),
        });
        const data = await response.json();
        if (data.valid) {
          setAuthToken(code, "youtube");
          onAuthSuccess(code);
        }
      }}
      onClose={() => console.log('Popup closed')}
    >
      <button style={{ backgroundColor: '#00AAFF', color: '#020818', border: 'none', padding: '10px 20px', borderRadius: '5px', cursor: 'pointer' }}>Iniciar sesión</button>
    </OAuthPopup>
  );
};

export default OAuthPopupComponent;