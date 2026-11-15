import { expect, test } from "bun:test";
import { manualClock } from "./manual-clock.ts";

test("an injected interval fires once per period as the clock advances", async () => {
  const clock = manualClock();
  let fired = 0;
  clock.setRepeat(() => { fired++; }, 100);
  await clock.advance(99);
  expect(fired).toBe(0);
  await clock.advance(1);
  expect(fired).toBe(1);
  await clock.advance(250);
  expect(fired).toBe(3);
  expect(clock.now()).toBe(350);
});

test("a cleared interval stops, also when cleared from its own callback", async () => {
  const clock = manualClock();
  let fired = 0;
  const handle = clock.setRepeat(() => {
    fired++;
    if (fired === 2) clock.clearTimer(handle);
  }, 10);
  await clock.advance(100);
  expect(fired).toBe(2);
});

test("clearTimer clears a one-shot timer", async () => {
  const clock = manualClock();
  let fired = 0;
  const handle = clock.setTimer(() => { fired++; }, 10);
  clock.clearTimer(handle);
  await clock.advance(100);
  expect(fired).toBe(0);
});

test("timers fire in time order and sleep resolves when the clock reaches it", async () => {
  const clock = manualClock();
  const order: string[] = [];
  clock.setTimer(() => order.push("b"), 20);
  clock.setTimer(() => order.push("a"), 10);
  const slept = clock.sleep(30).then(() => order.push("sleep"));
  await clock.advance(30);
  await slept;
  expect(order).toEqual(["a", "b", "sleep"]);
});
