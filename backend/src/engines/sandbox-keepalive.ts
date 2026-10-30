// Extend an active turn's sandbox lifetime through the shared preparation
// lifecycle. Providers without an absolute lifetime need no heartbeat.
import type { SandboxHandle } from "../sandboxes/provider";
import { sandboxKeepAliveIntervalMs } from "../env";

type ScheduleHeartbeat = (refresh: () => void, intervalMs: number) => () => void;

const scheduleHeartbeat: ScheduleHeartbeat = (refresh, intervalMs) => {
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

export function startSandboxKeepAlive(
  sandbox: Pick<SandboxHandle, "keepAlive">,
  onFailure: () => void = () => {},
  schedule: ScheduleHeartbeat = scheduleHeartbeat,
): () => void {
  if (!sandbox.keepAlive) return () => {};
  let stopped = false;
  let pending = false;
  const refresh = (): void => {
    if (stopped || pending) return;
    pending = true;
    try {
      void sandbox.keepAlive!().then(
        () => { pending = false; },
        () => { pending = false; if (!stopped) onFailure(); },
      );
    } catch {
      pending = false;
      if (!stopped) onFailure();
    }
  };
  // A resumed sandbox may have little lifetime left, including during setup.
  refresh();
  const cancel = schedule(refresh, sandboxKeepAliveIntervalMs());
  return () => {
    if (stopped) return;
    stopped = true;
    cancel();
  };
}
