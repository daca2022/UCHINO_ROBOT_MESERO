import { randomBytes } from 'crypto';

const runtimeJwtSecret = randomBytes(32).toString('hex');

export const ADMIN_USER = process.env.ADMIN_USER || process.env.ROBOT_ADMIN_USER || 'admin';
export const ADMIN_PASS = process.env.ADMIN_PASSWORD || process.env.GF_SECURITY_ADMIN_PASSWORD || '';
export const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_JWT_SECRET || runtimeJwtSecret;

export function isAdminAuthConfigured() {
    return Boolean(ADMIN_PASS);
}

