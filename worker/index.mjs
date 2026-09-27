// Cloudflare Worker entry. The logic lives in handler.mjs so tests can pass
// their own clock; the Worker always uses the real time.
import { handle } from "./handler.mjs";

export default {
  fetch(request, env) {
    return handle(request, env, new Date());
  },
};
