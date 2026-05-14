import { loadCredentials } from "../../src/auth";
import { Request, Response } from "express";

// Generar la URL de autenticación con Google OAuth2
export async function generateAuthUrl(): Promise<string> {
  try {
    console.log("=== INICIANDO generateAuthUrl ==="); // Depuración
    const credentials = await loadCredentials();
    console.log("=== CREDENCIALES CARGADAS ==="); // Depuración
    
    const clientConfig = credentials.installed || credentials.web;
    if (!clientConfig) {
      throw new Error("Configuración de credenciales no válida: falta 'installed' o 'web'");
    }
    
    console.log("=== CLIENT CONFIG ===", clientConfig); // Depuración
    const clientId = clientConfig.client_id;
    const redirectUri = `http://localhost:3000/auth/callback`;
    const scope = "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl";
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline`;
    
    console.log("=== URL DE AUTENTICACIÓN ===", authUrl); // Depuración
    return authUrl;
  } catch (err) {
    console.error("=== ERROR EN generateAuthUrl ===", err); // Depuración
    throw err;
  }
}

// Manejar el endpoint /auth
export async function handleAuthRequest(req: Request, res: Response) {
  console.log("=== ACCEDIENDO A /auth ==="); // Depuración
  try {
    const authUrl = await generateAuthUrl();
    console.log("=== REDIRIGIENDO A GOOGLE OAUTH2 ==="); // Depuración
    res.redirect(authUrl);
  } catch (err) {
    console.error("=== ERROR EN handleAuthRequest ===", err); // Depuración
    // Notificar a la página principal y cerrar el popup
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Error de autenticación</title>
          <script>
            if (window.opener) {
              window.opener.postMessage('auth_error', '*');
              window.close();
            } else {
              window.location.href = 'http://localhost:3000';
            }
          </script>
        </head>
        <body>
          <p>Error al iniciar la autenticación. Verifica la configuración.</p>
        </body>
      </html>
    `);
  }
}