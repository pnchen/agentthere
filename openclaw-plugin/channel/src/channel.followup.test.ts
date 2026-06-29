import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => {
	const state = {
		rawCallback: null as null | ((ctx: Record<string, unknown>) => void),
		invokeRawMessage: (msg: Record<string, unknown>) => {
			if (state.rawCallback) {
				const rawPayload: Record<string, unknown> = {};
				if (msg.text != null) rawPayload.text = msg.text;
				if (msg.uid != null) rawPayload.uid = msg.uid;
				if (msg.file) rawPayload.file = msg.file;
				if (msg.chunk) rawPayload.chunk = msg.chunk;
				if (msg.object_id) rawPayload.object_id = msg.object_id;
				if (msg.type) rawPayload.type = msg.type;
				state.rawCallback({
					raw: JSON.stringify(rawPayload),
					peerId: (msg.peerId as string) || 'test',
					peerName: (msg.peerName as string) || 'test',
					groupId: (msg.groupId as string) || 'test',
					peers: new Map(),
					rtcLabel: 'test',
					getAgentName: () => 'Agent',
					buildAgentProfile: () => ({ name: 'Agent', agent: true }),
				});
			}
		},
	};

	return {
		state,
		dispatchReplyFromConfig: vi.fn(async () => ({ queuedFinal: false, counts: {} })),
		sendToPeer: vi.fn(() => true),
		sendFileToPeer: vi.fn(),
		sendFileToGroup: vi.fn(),
		recordPendingHistoryEntryIfEnabled: vi.fn(),
		clearHistoryEntries: vi.fn(),
		buildPendingHistoryContextFromMap: vi.fn(({ currentMessage }) => currentMessage),
		startGroupMonitor: vi.fn(async () => ({
			cleanup: () => {
				state.rawCallback = null;
			},
			setOnRawMessage: (cb) => {
				state.rawCallback = cb;
			},
			setOnInboundAudio: vi.fn(),
			setOnPeerGone: vi.fn(),
			ensureMediaOutPeer: vi.fn(),
			getMediaOutPeer: vi.fn(),
			getPeerIds: vi.fn(() => []),
			getPeerName: vi.fn(),
		})),
	};
});

vi.mock("openclaw/plugin-sdk/allow-from", () => ({
	formatAllowFromLowercase: vi.fn(({ allowFrom }) => allowFrom ?? []),
	resolveAllowlistMatchSimple: vi.fn(() => ({ allowed: true })),
}));

vi.mock("openclaw/plugin-sdk/allowlist-config-edit", () => ({
	buildDmGroupAccountAllowlistAdapter: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/channel-config-helpers", () => ({
	adaptScopedAccountAccessor: vi.fn((fn) => fn),
	createScopedChannelConfigAdapter: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
	createChannelPairingController: vi.fn(() => ({
		readStoreForDmPolicy: vi.fn(async () => []),
		upsertPairingRequest: vi.fn(async () => ({ code: "123456" })),
	})),
}));

vi.mock("openclaw/plugin-sdk/channel-policy", () => ({
	readStoreAllowFromForDmPolicy: vi.fn(async () => []),
	resolveEffectiveAllowFromLists: vi.fn(({ allowFrom }) => ({ effectiveAllowFrom: allowFrom ?? [] })),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
	buildPairingReply: vi.fn(() => "pairing-challenge"),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
	upsertChannelPairingRequest: vi.fn(async () => ({ code: "123456" })),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
	REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
	createRealtimeVoiceBridgeSession: vi.fn(),
	resolveConfiguredRealtimeVoiceProvider: vi.fn(),
	resamplePcm: vi.fn((input) => input),
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
	buildPendingHistoryContextFromMap: mocks.buildPendingHistoryContextFromMap,
	clearHistoryEntries: mocks.clearHistoryEntries,
	recordPendingHistoryEntryIfEnabled: mocks.recordPendingHistoryEntryIfEnabled,
}));

vi.mock("openclaw/plugin-sdk/status-helpers", () => ({
	buildBaseChannelStatusSummary: vi.fn(() => ({})),
	createComputedAccountStatusAdapter: vi.fn((value) => value),
	createDefaultChannelRuntimeState: vi.fn(() => ({})),
}));

vi.mock("openclaw/plugin-sdk/sandbox", () => ({
	resolvePreferredOpenClawTmpDir: vi.fn(() => "/tmp/openclaw"),
}));

vi.mock("node:fs", () => ({
	default: {
		constants: { W_OK: 2, X_OK: 1 },
		accessSync: vi.fn(),
		chmodSync: vi.fn(),
		existsSync: vi.fn(() => false),
		lstatSync: vi.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: process.getuid?.() ?? 501 })),
		readFileSync: vi.fn(),
		statSync: vi.fn(() => ({ size: 0 })),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
	},
}));

vi.mock("./config.js", () => ({
	DEFAULT_ACCOUNT_ID: "default",
	listAccountIds: vi.fn(() => ["default"]),
	resolveAgentIdentityForGroup: vi.fn((_cfg, groupId) => ({
		agentId: `agent-${groupId}`,
		agentName: `Agent ${groupId}`,
		agentAvatar: undefined,
	})),
	resolveAccount: vi.fn(),
	resolveGroupOpenClawAgentId: vi.fn(() => undefined),
	resolveGroupSkillFilter: vi.fn(() => undefined),
	resolveGroupSystemPrompt: vi.fn(() => undefined),
}));

vi.mock("./messaging.js", () => ({
	formatTargetDisplay: vi.fn(),
	looksLikeTargetId: vi.fn(),
	normalizeMessagingTarget: vi.fn(),
	parseMessagingTarget: vi.fn(() => null),
	resolveInboundReplyTarget: vi.fn(() => undefined),
	resolveOutboundSessionRoute: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
	getRuntime: () => ({
		error: vi.fn(),
		channel: {
			pairing: {
				buildPairingReply: vi.fn(() => "pairing"),
			},
			routing: {
				resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
					accountId,
					sessionKey: `${peer.kind}:${peer.id}`,
				})),
			},
			reply: {
				finalizeInboundContext: vi.fn((ctx) => ctx),
				createReplyDispatcherWithTyping: vi.fn(({ deliver }) => ({
					dispatcher: { deliver },
					replyOptions: {},
					markDispatchIdle: vi.fn(),
				})),
				dispatchReplyFromConfig: mocks.dispatchReplyFromConfig,
			},
			session: {
				resolveStorePath: vi.fn(() => null),
			},
		},
	}),
}));

vi.mock("./channel/rtc", () => ({
	startGroupMonitor: mocks.startGroupMonitor,
}));

vi.mock("./channel/sessions.js", () => ({
	getSessionByPeerId: vi.fn(() => undefined),
	listSessions: vi.fn(() => []),
	sendToPeer: mocks.sendToPeer,
}));

vi.mock("./channel/file-send.js", () => ({
	sendFileToGroup: mocks.sendFileToGroup,
	sendFileToPeer: mocks.sendFileToPeer,
	sendMedia: vi.fn(async (params) => {
		if (params.groupId) {
			return mocks.sendFileToGroup(params);
		}
		return mocks.sendFileToPeer(params);
	}),
}));

vi.mock("./channel/messaging.js", () => ({
	createMessageId: vi.fn(() => "agentthere-message-id"),
	buildOutboundTextMessage: vi.fn(({ text, agentProfile }) => ({
		id: "agentthere-outbound-message",
		text,
		from: agentProfile,
	})),
	normalizeMessagingTarget: vi.fn((raw) => raw),
	formatTargetDisplay: vi.fn(),
	looksLikeTargetId: vi.fn(),
	parseMessagingTarget: vi.fn(() => null),
	resolveOutboundSessionRoute: vi.fn(),
}));

vi.mock("./group-policy.js", () => ({
	resolveGroupRequireMention: vi.fn(() => true),
	resolveGroupToolPolicy: vi.fn(() => undefined),
}));

let agenttherePlugin: typeof import("./plugin.js").agenttherePlugin;

describe("AgentThere group follow-up routing", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.state.rawCallback = null;
		mocks.sendToPeer.mockReturnValue(true);
		mocks.sendFileToPeer.mockResolvedValue({ ok: true, messageId: "agentthere-file-msg-1", objectId: "obj-1" });
		mocks.sendFileToGroup.mockResolvedValue({ ok: true, messageId: "agentthere-file-msg-2", objectId: "obj-2" });
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
		({ agenttherePlugin } = await import("./plugin.js"));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("auto-follow-up triggers dispatch for same user within one-minute window", async () => {
		const abortController = new AbortController();
		const startPromise = agenttherePlugin.gateway.startAccount({
				runtime: getRuntime(),
			account: {
				accountId: "default",
				enabled: true,
				mqtt: { url: "mqtt://broker.example" },
				groupIds: ["alpha"],
				dmPolicy: "open",
			},
			cfg: {},
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			setStatus: vi.fn(),
			abortSignal: abortController.signal,
		} as never);

		// Wait for async startup to finish.
		await vi.waitFor(() => {
			expect(mocks.state.rawCallback).toBeTypeOf("function");
		}, { timeout: 5000 });

		const invoke = mocks.state.invokeRawMessage;

		// First message: explicit @mention — must pass intentDetection
		invoke({
			peerId: "peer-1",
			peerName: "Alice",
			uid: "alice-uid",
			groupId: "alpha",
			text: "@Agent alpha 你好",
		});

		// Wait for the dispatch to complete.
		await new Promise(r => setTimeout(r, 100));

		// The dispatch should have been called with cleanText (mention prefix stripped).
		const dispatchAfterStartup = mocks.dispatchReplyFromConfig.mock.calls.filter(
			(call) => call[0]?.ctx?.Body === '你好',
		);
		expect(dispatchAfterStartup.length).toBeGreaterThanOrEqual(1);

		// Within the follow-up window, an unmentioned message from the same user
		// should also trigger dispatch (intentDetection follow-up check).
		invoke({
			peerId: "peer-1",
			peerName: "Alice",
			uid: "alice-uid",
			groupId: "alpha",
			text: "再发一条",
		});

		// Wait for the follow-up dispatch to complete.
		await new Promise(r => setTimeout(r, 100));

		const followUpDispatch = mocks.dispatchReplyFromConfig.mock.calls.filter(
			(call) => call[0]?.ctx?.Body === '再发一条',
		);
		expect(followUpDispatch.length).toBeGreaterThanOrEqual(1);

		abortController.abort();
		await startPromise;
	});

	it("converts MEDIA directives into AgentThere file sends", async () => {
		mocks.dispatchReplyFromConfig.mockImplementation(async (params) => {
			if (params?.ctx?.Body?.includes('发个文件')) {
				await params.replyOptions?.onPartialReply?.({ text: "你要的这张图在这：" });
				await params.dispatcher.deliver(
					{
						text: "你要的这张图在这：",
						mediaUrls: ["/tmp/openclaw/agentthere-files/report.pdf"],
						mediaUrl: "/tmp/openclaw/agentthere-files/report.pdf",
					},
					{ kind: "final" },
				);
			}
			return { queuedFinal: false, counts: {} };
		});

		const abortController = new AbortController();
		const startPromise = agenttherePlugin.gateway.startAccount({
				runtime: getRuntime(),
			account: {
				accountId: "default",
				enabled: true,
				mqtt: { url: "mqtt://broker.example" },
				groupIds: ["alpha"],
				dmPolicy: "open",
			},
			cfg: {},
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			setStatus: vi.fn(),
			abortSignal: abortController.signal,
		} as never);

		// Wait for async startup to finish.
		await vi.waitFor(() => {
			expect(mocks.state.rawCallback).toBeTypeOf("function");
		}, { timeout: 5000 });

		// Send @mention message so it passes intentDetection
		mocks.state.invokeRawMessage({
			peerId: "peer-1",
			peerName: "Alice",
			uid: "alice-uid",
			groupId: "alpha",
			text: "@Agent alpha 发个文件",
		});

		// Wait for dispatch to complete.
		await vi.waitFor(() => {
			expect(mocks.sendFileToGroup).toHaveBeenCalled();
		}, { timeout: 5000 });

		expect(mocks.sendFileToGroup).toHaveBeenCalledWith(expect.objectContaining({
			groupId: "alpha",
			rawUrl: "/tmp/openclaw/agentthere-files/report.pdf",
		}));
		// No peers in the map → broadcast is a no-op, sendToPeer should not be called.
		expect(mocks.sendToPeer).not.toHaveBeenCalled();

		abortController.abort();
		await startPromise;
	});
});
