// Guards the hub against work that starts and that nobody tracks. `Hub.busy()` (and so `settled()` in the tests) can
// only see work that went through `spawn()` or sits in a map `busy()` reads; a fire-and-forget start anywhere else is
// work a test cannot wait for, and the only way left to wait for it is a sleep.
import ts from "typescript";
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const HUB_FILE = join(import.meta.dir, "..", "src", "hub", "hub.ts");
// Promise methods that start a chain: a statement that is only such a call drops the promise.
const CHAIN_METHODS = new Set(["then", "catch", "finally"]);
// Calls that hand a callback to a timer: the timer drops what the callback returns.
const TIMER_SETTERS = new Set(["setTimer", "setRepeat"]);
// Operators after which the right side is still the value of the statement.
const CONTINUATIONS = new Set<ts.SyntaxKind>([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken]);
const FUNCTION_KEY = "(function)";

type Scan = { voids: Record<string, number>; dropped: string[] };
type Allowed = { count: number; reason: string };

// Every `void <call>` in hub.ts, by the call's callee. A new one needs a reason that is not "a test waits".
const VOID_ALLOWED: Record<string, Allowed> = {
  "void this.pollLoop": { count: 1, reason: "the standing poll loop: it ends with stop()'s abort, and each update it takes is counted in updatesInFlight" },
  "void this.keepInOrder": { count: 1, reason: "a synchronous call: the void only ends deliver() with no value" },
  "void work.then": { count: 1, reason: "the bookkeeping inside spawn() itself: the work is already in `spawned`, and its failure is logged there" },
  "void next.then": { count: 2, reason: "drops the map entry of a chain that is already in batchSends or reactions, both read by busy()" },
};

function nameOf(expr: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return ts.isIdentifier(expr) ? expr.text : "";
}

function isAsync(node: ts.Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && !ts.isMethodDeclaration(node)) return false;
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

// The calls whose value a statement (or an expression-bodied callback) throws away.
function droppedCalls(expr: ts.Expression): ts.CallExpression[] {
  if (ts.isParenthesizedExpression(expr)) return droppedCalls(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...droppedCalls(expr.whenTrue), ...droppedCalls(expr.whenFalse)];
  if (ts.isBinaryExpression(expr)) return CONTINUATIONS.has(expr.operatorToken.kind) ? droppedCalls(expr.right) : [];
  return ts.isCallExpression(expr) ? [expr] : [];
}

// What a call is named in the allowlist: its callee's text, or a marker for an immediately called function.
function calleeKey(call: ts.CallExpression, source: ts.SourceFile): string {
  return ts.isParenthesizedExpression(call.expression) ? FUNCTION_KEY : call.expression.getText(source);
}

export function scan(text: string): Scan {
  const source = ts.createSourceFile("hub.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const asyncMethods = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && isAsync(node)) asyncMethods.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const dropsPromise = (call: ts.CallExpression): boolean => {
    const target = call.expression;
    if (ts.isParenthesizedExpression(target)) return isAsync(target.expression);
    if (!ts.isPropertyAccessExpression(target)) return false;
    if (CHAIN_METHODS.has(target.name.text)) return true;
    return target.expression.kind === ts.SyntaxKind.ThisKeyword && asyncMethods.has(target.name.text);
  };
  const where = (node: ts.Node): string => `line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source).split("\n")[0]}`;

  const voids: Record<string, number> = {};
  const dropped: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVoidExpression(node)) {
      const inner = node.expression;
      const key = `void ${ts.isCallExpression(inner) ? calleeKey(inner, source) : ts.SyntaxKind[inner.kind]}`;
      voids[key] = (voids[key] ?? 0) + 1;
    }
    if (ts.isExpressionStatement(node)) {
      for (const call of droppedCalls(node.expression)) if (dropsPromise(call)) dropped.push(where(call));
    }
    if (ts.isCallExpression(node) && TIMER_SETTERS.has(nameOf(node.expression))) {
      for (const arg of node.arguments) {
        if (!ts.isArrowFunction(arg) || ts.isBlock(arg.body)) continue;
        for (const call of droppedCalls(arg.body)) if (dropsPromise(call)) dropped.push(where(call));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { voids, dropped };
}

function mismatches(found: Record<string, number>, allowed: Record<string, Allowed>): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(found), ...Object.keys(allowed)])) {
    const have = found[key] ?? 0;
    const want = allowed[key]?.count ?? 0;
    if (have > want) out.push(`${key}: ${have} found, ${want} allowed`);
    if (have < want) out.push(`${key}: ${have} found, the list says ${want}: lower it`);
  }
  return out;
}

const SAMPLE_HEAD = ["class Sample {", "  private async work(): Promise<void> {}", "  private later(fn: () => void): void { fn(); }", "  private run(): void {"];
const SAMPLE_TAIL = ["  }", "}"];
const sample = (...body: string[]): Scan => scan([...SAMPLE_HEAD, ...body, ...SAMPLE_TAIL].join("\n"));

test("hub.ts starts no work that busy() cannot see, apart from the listed ones", () => {
  const found = scan(readFileSync(HUB_FILE, "utf8"));
  for (const key of Object.keys(VOID_ALLOWED)) expect(VOID_ALLOWED[key]?.reason).toBeTruthy();
  expect(found.dropped).toEqual([]);
  expect(mismatches(found.voids, VOID_ALLOWED)).toEqual([]);
});

test("a new `void this.x()` is not allowed unless it is listed", () => {
  const found = sample("    void this.work();");
  expect(mismatches(found.voids, VOID_ALLOWED)).toContain("void this.work: 1 found, 0 allowed");
});

test("a dropped async call, promise chain, async function or timer callback is found", () => {
  expect(sample("    this.work();").dropped.length).toBe(1);
  expect(sample("    this.work().then(() => {});").dropped.length).toBe(1);
  expect(sample("    Promise.resolve().catch(() => {});").dropped.length).toBe(1);
  expect(sample("    if (this) this.work();").dropped.length).toBe(1);
  expect(sample("    this ? this.work() : undefined;").dropped.length).toBe(1);
  expect(sample("    this && this.work();").dropped.length).toBe(1);
  expect(sample("    (async () => {})();").dropped.length).toBe(1);
  expect(sample("    this.setTimer(() => this.work(), 1);").dropped.length).toBe(1);
  expect(sample("    void (async () => {})();").voids).toEqual({ "void (function)": 1 });
});

test("work that is awaited, kept, returned, or handed to spawn() is not found", () => {
  expect(sample("    this.spawn(this.work());").dropped).toEqual([]);
  expect(sample("    const kept = this.work().then(() => {});", "    this.later(() => this.spawn(kept));").dropped).toEqual([]);
  expect(sample("    this.setTimer(() => this.spawn(this.work()), 1);").dropped).toEqual([]);
  expect(sample("    this.setTimer(() => { this.spawn(this.work()); }, 1);").dropped).toEqual([]);
  const awaited = scan(["class Sample {", "  async work(): Promise<void> {}", "  async run(): Promise<void> { await this.work(); return this.work(); }", "}"].join("\n"));
  expect(awaited).toEqual({ voids: {}, dropped: [] });
});
