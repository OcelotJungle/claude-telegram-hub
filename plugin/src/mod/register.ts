// tg-hub's function hooks module (hooks.json → modules): runs /info and
// /compact sent to the session's topic. Claude Code delivers channel
// messages with slash commands skipped, so the hub keeps them, and this
// module, inside the session, takes them over localhost HTTP. The logic is in
// commands.ts; here are only the engine's `$` calls, which the engine allows
// nowhere but this file.
import type { Register } from "claude-code";

import { DEFAULT_PORT } from "../shared/protocol.ts";
import { Runner } from "./commands.ts";

const POLL_MS = 1000;

let runner: Runner | undefined;

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    const port = Number(await $.env.get("TG_HUB_PORT")) || DEFAULT_PORT;
    const r = new Runner(`http://127.0.0.1:${port}`, {
      sessionId: () => $.session.id(),
      usage: () => $.session.usage({ breakdown: "summary" }),
      run: (command, args) => $.command.run({ command, args }),
      http: (url, init) => $.http.fetch(url, init),
      now: () => Date.now(),
    });
    runner = r;
    $.clock.every(POLL_MS, () => void r.poll());
    return result;
  });

  // The main conversation's compactions only: a precompute installs nothing,
  // a subagent's is its own.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (e.trigger !== "precompute" && e.agentId === undefined) await runner?.compacted(result);
    return result;
  });
};
