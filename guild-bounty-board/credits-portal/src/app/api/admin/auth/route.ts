import { NextRequest, NextResponse } from 'next/server';
import {
  clearAdminSessionCookie,
  createAdminSessionToken,
  setAdminSessionCookie,
  verifyAdminAuth,
} from '@/lib/verify-admin-auth';

/**
 * Admin session auth: POST login, GET session check, DELETE logout.
 * Session is stored in a signed HttpOnly cookie (not localStorage).
 */
export async function GET(request: NextRequest) {
  const auth = verifyAdminAuth(request);
  return NextResponse.json({ authenticated: auth.valid });
}

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();
    const adminPassword = (
      process.env.ADMIN_PASSWORD ||
      process.env.admin_password ||
      ''
    ).trim();

    if (!adminPassword) {
      console.error('ADMIN_PASSWORD not configured in environment');
      return NextResponse.json(
        { success: false, error: 'Admin authentication not configured' },
        { status: 500 }
      );
    }

    const isValid = String(password || '').trim() === adminPassword;

    if (!isValid) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return NextResponse.json(
        { success: false, error: 'Invalid password' },
        { status: 401 }
      );
    }

    const token = createAdminSessionToken();
    const response = NextResponse.json({ success: true, authenticated: true });
    setAdminSessionCookie(response, token);
    return response;
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true, authenticated: false });
  clearAdminSessionCookie(response);
  return response;
}
