import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "guardai_session";

/** Sends first-time visitors to /login; Skip Login sets the cookie before redirecting back to /. */
export function middleware(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
