import { Request, Response, NextFunction } from "express";

export class AuthMiddleware {
  /**
   * Middleware para validar el access_token en cookies.
   */
  static validateToken(req: Request, res: Response, next: NextFunction): void {
    const accessToken = req.cookies.access_token;

    if (!accessToken) {
      res.redirect("/auth/youtube");
      return;
    }

    // TODO: Validar el token con Google (opcional en desarrollo)
    next();
  }
}