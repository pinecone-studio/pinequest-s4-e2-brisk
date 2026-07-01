import { forwardToBackend } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";

export {
  forwardToBackend as GET,
  forwardToBackend as POST,
  forwardToBackend as PUT,
  forwardToBackend as PATCH,
  forwardToBackend as DELETE,
};
