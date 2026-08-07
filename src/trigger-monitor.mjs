import { setChecked, setTrigger } from "./google-sheets.mjs";
import { findTriggeredChildAccounts, resolveTriggerQueryIds } from "./planning-mcp-client.mjs";

const DEFAULT_INTERVAL_SECONDS = Number(
  process.env.TRIGGER_CHECK_INTERVAL_SECONDS || 60,
);

const state = {
  enabled: false,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  timer: null,
  running: false,
  lastCheckAt: null,
  lastError: null,
  lastTriggeredAccount: null,
  lastResult: null,
};

function secondsToMs(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Seconds must be a positive number.");
  }

  return parsed * 1000;
}

function formatCheckedTimestamp(date = new Date()) {
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
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
  }, secondsToMs(state.intervalSeconds));
}

export function getTriggerMonitorStatus() {
  return {
    enabled: state.enabled,
    intervalSeconds: state.intervalSeconds,
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
    await setChecked(formatCheckedTimestamp());

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

export function startTriggerMonitor({ intervalSeconds } = {}) {
  if (intervalSeconds !== undefined) {
    setTriggerCheckInterval(intervalSeconds);
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

export function setTriggerCheckInterval(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Seconds must be a positive number.");
  }

  state.intervalSeconds = parsed;
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
