/**
 * Middleware de autenticación JWT para rutas del Admin Dashboard.
 *
 * Verifica el header `Authorization: Bearer <token>`.
 * Si el token es válido y tiene rol admin, llama a `next()`; si no, responde
 * 401 o 403 según corresponda.
 *
 * @module middleware/adminAuth
 */

import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../config/adminSecurity.mjs';

/**
 * Middleware Express que valida el JWT de admin.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado' });
    }

    const token = authHeader.slice(7);

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const role = String(payload.role || '').trim().toLowerCase();
        if (role !== 'admin' && payload.is_admin !== true) {
            return res.status(403).json({ error: 'Permisos insuficientes' });
        }
        req.adminUser = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'No autorizado' });
    }
}
