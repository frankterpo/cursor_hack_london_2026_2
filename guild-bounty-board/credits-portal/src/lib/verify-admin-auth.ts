import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'admin_session';
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getAdminSecret(): string {
  return (
    process.env.ADMIN_PASSWORD ||
    process.env.admin_password ||
    ''
  ).trim();
}

export function createAdminSessionToken(): string {
  const secret = getAdminSecret();
  if (!secret) {
    throw new Error('ADMIN_PASSWORD not configured');
  }
  const timestamp = Date.now().toString();
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`credits-admin:v1:${timestamp}`)
    .digest('hex');
  return `${timestamp}.${hmac}`;
}

function verifyAdminSessionToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;

  const secret = getAdminSecret();
  if (!secret) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestamp, providedHmac] = parts;
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(`credits-admin:v1:${timestamp}`)
    .digest('hex');

  try {
    if (
      !crypto.timingSafeEqual(
        Buffer.from(providedHmac, 'hex'),
        Buffer.from(expectedHmac, 'hex')
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const tokenAge = Date.now() - Number.parseInt(timestamp, 10);
  return Number.isFinite(tokenAge) && tokenAge >= 0 && tokenAge <= TOKEN_MAX_AGE_MS;
}

function readSessionToken(request: NextRequest): string {
  const authHeader = request.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return request.cookies.get(COOKIE_NAME)?.value || '';
}

export function verifyAdminAuth(request: NextRequest): { valid: boolean; error?: string } {
  if (!getAdminSecret()) {
    return { valid: false, error: 'Admin authentication not configured' };
  }

  const token = readSessionToken(request);
  if (!token) {
    return { valid: false, error: 'No admin session' };
  }

  if (!verifyAdminSessionToken(token)) {
    return { valid: false, error: 'Invalid or expired admin session' };
  }

  return { valid: true };
}

export function adminAuthUnauthorizedResponse(error = 'Unauthorized') {
  return NextResponse.json({ success: false, error }, { status: 401 });
}

export function setAdminSessionCookie(response: NextResponse, token: string) {
  const maxAge = Math.floor(TOKEN_MAX_AGE_MS / 1000);
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  });
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

export function requireAdminAuth(request: NextRequest): NextResponse | null {
  const auth = verifyAdminAuth(request);
  if (!auth.valid) {
    return adminAuthUnauthorizedResponse(auth.error || 'Unauthorized');
  }
  return null;
}
