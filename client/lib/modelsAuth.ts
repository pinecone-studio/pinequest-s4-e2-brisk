const BEARER_PREFIX = "Bearer ";

export function getModelsClientSecret(): string | null {
  const secret = process.env.MODELS_CLIENT_SECRET?.trim();
  return secret || null;
}

export function verifyModelsClientAuth(authorization: string | null): string | null {
  const secret = getModelsClientSecret();
  if (!secret) {
    return "MODELS_CLIENT_SECRET is not configured";
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
