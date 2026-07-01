const BEARER_PREFIX = "Bearer ";

export function getClientServerSecret(): string | null {
  const secret = process.env.CLIENT_SERVER_SECRET?.trim();
  return secret || null;
}

/** Returns an error message when auth fails, or null when the request is authorized. */
export function verifyClientServerAuth(authorization: string | null): string | null {
  const secret = getClientServerSecret();
  if (!secret) {
    return "CLIENT_SERVER_SECRET is not configured";
  }
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return "Unauthorized";
  }
  const token = authorization.slice(BEARER_PREFIX.length).trim();
  if (token !== secret) {
    return "Unauthorized";
  }
  return null;
}
