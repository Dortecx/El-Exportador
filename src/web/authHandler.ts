import { loadCredentials } from "../../src/auth";
import { Request, Response } from "express";

// Generar la URL de autenticación con Google OAuth2
export async function generateAuthUrl(): Promise<string> {
  try {
    const credentials = await loadCredentials();
    const clientConfig = credentials.installed || credentials.web;
    if (!clientConfig) {
      throw new Error("Configuración de credenciales no válida: falta 'installed' o 'web'");
    }
    
    const clientId = clientConfig.client_id;
    const redirectUri = `http://localhost:3000/auth/callback`;
    const scope = "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.force-ssl";
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline`;
    
    console.log("URL de autenticación generada:", authUrl); // Depuración
    return authUrl;
  } catch (err) {
    console.error("Error al generar la URL de autenticación:", err);
    throw err;
  }
}

// Manejar el endpoint /auth
export async function handleAuthRequest(req: Request, res: Response) {
  try {
    const authUrl = await generateAuthUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(
      `Error al iniciar la autenticación. Verifica que el archivo credentials.json exista y sea válido.<br>\n` +
      `Ruta esperada: ${require('path').join(require('os').homedir(), '.config', 'm3u-to-ytmusic', 'credentials.json')}<br>\n` +
      `Error: ${err.message}`
    );
  }
}