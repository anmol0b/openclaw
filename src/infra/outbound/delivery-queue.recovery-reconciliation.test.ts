import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  asDeliverFn,
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueueStatus,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const resolveOutboundChannelMessageAdapterMock = vi.hoisted(() => vi.fn());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveOutboundChannelMessageAdapterMock,
}));

describe("delivery-queue recovery unknown-send reconciliation failures", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  beforeEach(() => {
    resolveOutboundChannelMessageAdapterMock.mockReset();
  });

  it.each([
    ["terminalizes", "chat not found", false],
    ["retains", "provider lookup timed out", true],
  ])("%s an unknown send when reconciliation throws %j", async (_verb, message, retained) => {
    const id = await enqueueDelivery(
      { channel: "demo-channel-a", to: "+1", payloads: [{ text: "unknown send" }] },
      tmpDir(),
    );
    setQueuedEntryState(tmpDir(), id, {
      retryCount: 0,
      platformSendStartedAt: Date.now(),
      recoveryState: "unknown_after_send",
    });
    const reconcileUnknownSend = vi.fn().mockRejectedValue(new Error(message));
    resolveOutboundChannelMessageAdapterMock.mockReturnValue({
      durableFinal: { capabilities: { reconcileUnknownSend: true }, reconcileUnknownSend },
    });
    const deliver = vi.fn();

    const result = await recoverPendingDeliveries({
      deliver: asDeliverFn(deliver),
      log: createRecoveryLog(),
      cfg: {},
      stateDir: tmpDir(),
    });

    expect(reconcileUnknownSend).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    const pending = await loadPendingDeliveries(tmpDir());
    if (retained) {
      expect(pending).toHaveLength(1);
      expect(pending[0]?.retryCount).toBe(1);
    } else {
      expect(result).toMatchObject({ failed: 1 });
      expect(pending).toEqual([]);
      expect(readQueueStatus(tmpDir(), id)).toBeUndefined();
    }
  });
});
