export type MessageKind = "info" | "warning" | "error" | "action";

export function notifies(kind: MessageKind): boolean {
  return kind !== "info";
}
