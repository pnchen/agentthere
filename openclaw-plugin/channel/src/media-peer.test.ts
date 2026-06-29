/**
 * Local protocol test: two media peers connect via direct SDP/ICE exchange
 * and pass audio data without MQTT or a real browser.
 *
 * Validates the full media signaling pipeline:
 *   offer → answer → ICE candidates → connection → track open → audio delivery.
 *
 * Architecture note:
 *   node-datachannel's onTrack only fires when the receiver does NOT add a
 *   local track.  For bidirectional audio (AgentThere ↔ browser), use two separate
 *   PeerConnections — one sendonly→recvonly for each direction.  A single
 *   SendRecv PeerConnection is not suitable because both sides adding local
 *   tracks prevents onTrack from detecting remote tracks.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const MIN_AUDIO_FRAME = 100; // SRTP requires reasonable-sized RTP payloads

type MediaPeerHandle = {
  setRemoteOffer(sdp: string): void;
  setRemoteAnswer(sdp: string): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  sendAudioFrame(frame: Buffer): void;
  close(): void;
};

type CreateMediaPeer = (params: Record<string, unknown>) => Promise<MediaPeerHandle>;

async function loadCreateMediaPeer(): Promise<CreateMediaPeer> {
  const mod = await import("./channel/rtc/peer.js" as string);
  return mod.createMediaPeer as CreateMediaPeer;
}

afterAll(async () => {
  const ndc = await import("node-datachannel");
  ndc.cleanup();
});

/**
 * Wire two media peers together directly.
 *
 * The sender's offer and candidates may fire before the receiver handle exists,
 * so we queue them.  Similarly, the receiver's candidates must wait until the
 * sender has accepted the receiver's answer (via setRemoteAnswer).
 */
async function connectMediaPeers(senderDir: string, receiverDir: string) {
  const createMediaPeer = await loadCreateMediaPeer();
  const senderId = randomUUID();
  const receiverId = randomUUID();

  let senderHandle!: MediaPeerHandle;
  let receiverHandle!: MediaPeerHandle;
  let senderHasRemote = false;

  const queuedSenderOffers: string[] = [];
  const queuedSenderCandidates: { candidate: string; mid: string }[] = [];
  const queuedReceiverCandidates: { candidate: string; mid: string }[] = [];

  let resolveReceiverTrackOpen!: () => void;
  const receiverTrackOpen = new Promise<void>((r) => {
    resolveReceiverTrackOpen = r;
  });

  const receivedAudioChunks: Buffer[] = [];
  let resolveAudioReceived!: (buf: Buffer) => void;
  const audioReceived = new Promise<Buffer>((r) => {
    resolveAudioReceived = r;
  });

  function flushAll() {
    for (const sdp of queuedSenderOffers.splice(0)) {
      receiverHandle.setRemoteOffer(sdp);
    }
    for (const c of queuedSenderCandidates.splice(0)) {
      receiverHandle.addRemoteCandidate(c.candidate, c.mid);
    }
    if (senderHasRemote) {
      for (const c of queuedReceiverCandidates.splice(0)) {
        senderHandle.addRemoteCandidate(c.candidate, c.mid);
      }
    }
  }

  senderHandle = await createMediaPeer({
    sessionId: senderId,
    peerId: receiverId,
    iceServers: [],
    direction: senderDir,
    callbacks: {
      onOffer(sdp: string) {
        if (receiverHandle) receiverHandle.setRemoteOffer(sdp);
        else queuedSenderOffers.push(sdp);
      },
      onAnswer(_sdp: string) {},
      onCandidate(candidate: string, mid: string) {
        if (receiverHandle) receiverHandle.addRemoteCandidate(candidate, mid);
        else queuedSenderCandidates.push({ candidate, mid });
      },
      onTrackOpen() {},
      onAudioData(_msg: Buffer) {},
      onClose() {},
    },
  });

  receiverHandle = await createMediaPeer({
    sessionId: receiverId,
    peerId: senderId,
    iceServers: [],
    direction: receiverDir,
    callbacks: {
      onOffer(_sdp: string) {},
      onAnswer(sdp: string) {
        senderHandle.setRemoteAnswer(sdp);
        senderHasRemote = true;
        for (const c of queuedReceiverCandidates.splice(0)) {
          senderHandle.addRemoteCandidate(c.candidate, c.mid);
        }
      },
      onCandidate(candidate: string, mid: string) {
        if (senderHasRemote) senderHandle.addRemoteCandidate(candidate, mid);
        else queuedReceiverCandidates.push({ candidate, mid });
      },
      onTrackOpen() {
        resolveReceiverTrackOpen();
      },
      onAudioData(msg: Buffer) {
        receivedAudioChunks.push(Buffer.isBuffer(msg) ? msg : Buffer.from(msg));
        if (receivedAudioChunks.length === 1) {
          resolveAudioReceived(receivedAudioChunks[0]);
        }
      },
      onClose() {},
    },
  });

  flushAll();

  return {
    sender: senderHandle,
    receiver: receiverHandle,
    receiverTrackOpen,
    audioReceived,
    receivedAudioChunks,
    cleanup: () => {
      senderHandle.close();
      receiverHandle.close();
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AgentThere media peer protocol", () => {
  it(
    "sendonly → recvonly: full SDP/ICE/DTLS handshake and audio delivery",
    { timeout: 15_000 },
    async () => {
      const pair = await connectMediaPeers("sendonly", "recvonly");
      try {
        // Wait for the receiving track to open — proves SDP+ICE+DTLS completed.
        await pair.receiverTrackOpen;

        // Send audio and verify it arrives intact.
        const testFrame = Buffer.alloc(MIN_AUDIO_FRAME);
        testFrame.fill(0xaa);
        pair.sender.sendAudioFrame(testFrame);

        const received = await pair.audioReceived;
        expect(received.equals(testFrame)).toBe(true);
      } finally {
        pair.cleanup();
      }
    },
  );
});
