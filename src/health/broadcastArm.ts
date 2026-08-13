/**
 * A manual safety gate between the pipeline and real destination platforms.
 * Deliberately in-memory only — every orchestrator restart resets to
 * disarmed, so a stale "armed" state can never survive a crash/restart and
 * silently let a real broadcast leg start unattended.
 */
export interface BroadcastArmState {
  isArmed(): boolean;
  arm(): void;
  disarm(): void;
}

export function createBroadcastArmState(): BroadcastArmState {
  let armed = false;
  return {
    isArmed: () => armed,
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}
