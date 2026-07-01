// Thin proxy to the aegis-cctv-backend service.
//
// The frontend's app/api/**/route.ts handlers contain NO business logic — they
// only forward the incoming request (method, path, query, headers, body) to the
// backend and return its response unchanged. Streaming responses (MJPEG, RTSP)
// pass through because the backend's body is piped straight to the client.

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3001";

export async function forwardToBackend(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${BACKEND_URL}${incoming.pathname}${incoming.search}`;

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    cache: "no-store",
    redirect: "manual",
  };
  if (hasBody) {
    init.body = request.body;
    init.duplex = "half";
  }

  const backendResponse = await fetch(target, init);

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: backendResponse.headers,
  });
}
