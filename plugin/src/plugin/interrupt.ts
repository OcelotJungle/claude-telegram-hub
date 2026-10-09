import { connect } from "net";

// Puts a note into the Claude Code window's own inbox (its uds-messaging
// socket) with priority now, which ends the agent's turn as Esc would. The
// token, given to the window's child processes, lets the inbox accept it.
// The inbox does not answer: done means the note was written to the socket.
export function sendInterrupt(socket: string, token: string, note: string): Promise<void> {
  const lines = [
    { type: "auth", token },
    { type: "user", message: { role: "user", content: note }, priority: "now", from_plugin: "tg-hub" },
  ];
  return new Promise((resolve, reject) => {
    const c = connect(socket, () => c.end(lines.map(l => JSON.stringify(l)).join("\n") + "\n", () => resolve()));
    c.on("error", reject);
  });
}
