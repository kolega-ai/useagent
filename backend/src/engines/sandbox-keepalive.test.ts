import { describe, expect, test } from "bun:test";
import { sandboxKeepAliveIntervalMs } from "../env";
import { startSandboxKeepAlive } from "./sandbox-keepalive";

describe("active sandbox lifetime", () => {
  test("renews immediately and repeatedly without overlapping, and stops on close", async () => {
    let tick = () => {};
    let cancelled = false;
    let calls = 0;
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const stop = startSandboxKeepAlive({ keepAlive: () => (++calls === 1 ? first.promise : second.promise) }, undefined,
      (refresh, interval) => {
        expect(interval).toBe(5 * 60_000);
        tick = refresh;
        return () => { cancelled = true; };
      });
    expect(calls).toBe(1);
    tick();
    expect(calls).toBe(1);
    first.resolve();
    await Promise.resolve();
    tick();
    expect(calls).toBe(2);
    stop();
    stop();
    second.resolve();
    await Promise.resolve();
    tick();
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
  });

  test("reports a failed renewal and retries on the next heartbeat", async () => {
    let tick = () => {};
    let calls = 0;
    let failures = 0;
    const stop = startSandboxKeepAlive({ keepAlive: async () => {
      calls += 1;
      if (calls === 1) throw new Error("sensitive provider detail");
    } }, () => { failures += 1; }, (refresh) => { tick = refresh; return () => {}; });
    await Promise.resolve();
    expect(failures).toBe(1);
    tick();
    await Promise.resolve();
    expect(calls).toBe(2);
    stop();
  });

  test("does not schedule a heartbeat for providers without a lifetime operation", () => {
    let scheduled = false;
    startSandboxKeepAlive({}, undefined, () => { scheduled = true; return () => {}; })();
    expect(scheduled).toBe(false);
  });

  test("renews short configured lifetimes before expiry", () => {
    expect(sandboxKeepAliveIntervalMs({})).toBe(5 * 60_000);
    expect(sandboxKeepAliveIntervalMs({ SANDBOX_AUTO_STOP_MIN: "1" })).toBe(20_000);
    expect(sandboxKeepAliveIntervalMs({ SANDBOX_AUTO_STOP_MIN: "20" })).toBe(5 * 60_000);
    expect(sandboxKeepAliveIntervalMs({ SANDBOX_AUTO_STOP_MIN: "invalid" })).toBe(5 * 60_000);
  });
});
