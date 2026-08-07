import { setTrigger } from "./google-sheets.mjs";
import { findTriggeredChildAccounts, resolveTriggerQueryIds } from "./planning-mcp-client.mjs";

const DEFAULT_INTERVAL_MINUTES = Number(process.env.TRIGGER_CHECK_INTERVAL_MINUTES || 1);

const state = {
  enabled: false,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  timer: null,
  running: false,
  lastCheckAt: null,
  lastError: null,
  lastTriggeredAccount: null,
  lastResult: null,
};

function minutesToMs(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Minutes must be a positive number.");
  }

  return parsed * 60 * 1000;
}

function scheduleNextTick() {
  if (state.timer) {
    clearInterval(state.timer);
  }

  if (!state.enabled) {
    state.timer = null;
    return;
  }

  state.timer = setInterval(() => {
    runTriggerCheck().catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[trigger-monitor] ${state.lastError}\n`);
    });
  }, minutesToMs(state.intervalMinutes));
}

export function getTriggerMonitorStatus() {
  return {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    running: state.running,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    lastTriggeredAccount: state.lastTriggeredAccount,
    lastResult: state.lastResult,
  };
}

export async function runTriggerCheck() {
  if (state.running) {
    return {
      skipped: true,
      reason: "Previous check is still running.",
      status: getTriggerMonitorStatus(),
    };
  }

  state.running = true;
  state.lastCheckAt = new Date().toISOString();
  state.lastError = null;

  try {
    const ids = await resolveTriggerQueryIds();
    const triggeredAccounts = await findTriggeredChildAccounts(ids);

    if (triggeredAccounts.length === 0) {
      state.lastResult = {
        action: "none",
        message: "All child account values are 0.",
      };
      state.lastTriggeredAccount = null;
      return { triggered: false, status: getTriggerMonitorStatus() };
    }

    const accountName = triggeredAccounts[0].accountName;
    await setTrigger(accountName);

    state.lastTriggeredAccount = accountName;
    state.lastResult = {
      action: "set_trigger",
      accountName,
      triggeredAccounts,
    };

    return {
      triggered: true,
      accountName,
      triggeredAccounts,
      status: getTriggerMonitorStatus(),
    };
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.running = false;
  }
}

export function startTriggerMonitor({ intervalMinutes } = {}) {
  if (intervalMinutes !== undefined) {
    setTriggerCheckInterval(intervalMinutes);
  }

  state.enabled = true;
  scheduleNextTick();

  runTriggerCheck().catch((error) => {
    state.lastError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[trigger-monitor] ${state.lastError}\n`);
  });

  return getTriggerMonitorStatus();
}

export function stopTriggerMonitor() {
  state.enabled = false;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  return getTriggerMonitorStatus();
}

export function setTriggerCheckInterval(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Minutes must be a positive number.");
  }

  state.intervalMinutes = parsed;
  if (state.enabled) {
    scheduleNextTick();
  }

  return getTriggerMonitorStatus();
}

export function maybeAutostartTriggerMonitor() {
  const autostart = String(process.env.TRIGGER_CHECK_AUTOSTART || "").toLowerCase();
  if (autostart === "true" || autostart === "1" || autostart === "yes") {
    startTriggerMonitor();
  }
}
