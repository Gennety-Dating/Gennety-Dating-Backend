import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "./jwt.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * JWT, если он есть, и никакого отказа, если его нет.
 *
 * Нужен ровно одному маршруту — приёму клиентской воронки: события онбординга
 * случаются ДО того, как аккаунт существует, и требовать там токен значило бы
 * не собирать ровно ту часть воронки, ради которой она заведена. Битый или
 * протухший токен здесь тоже не ошибка: человек просто остаётся анонимным, а
 * ронять сбор телеметрии из-за истёкшего access-токена незачем.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      req.userId = verifyAccessToken(header.slice(7)).sub;
    } catch {
      // анонимный вызов
    }
  }
  next();
}
