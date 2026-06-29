function addIceCandidateSafe(pc, candidate) {
	if (!pc) return;
	console.log(`[rtc-peer:signal] addIceCandidateSafe type=${candidate && candidate.type} sdpMLineIndex=${candidate && candidate.sdpMLineIndex}`);
	if (!pc._ice_candidate_chain) {
		pc._ice_candidate_chain = Promise.resolve();
	}
	pc._ice_candidate_chain = pc._ice_candidate_chain
		.then(() => pc.addIceCandidate(candidate))
		.then(() => {
			console.log(`[rtc-peer:signal] addIceCandidate OK`);
		})
		.catch(err => console.warn('[rtc-peer:signal] addIceCandidate error:', err));
	return pc._ice_candidate_chain;
}

/**
 * Signaling mixin — MQTT-based SDP / ICE exchange.
 */
export default {
	data() {
		return {
			channel_remote: null,
			channel_me: null,
			making_offer: false,
			has_remote_description: false,
			pending_candidates: []
		};
	},
	computed: {
		polite() {
			return this.peerId < this.remoteId;
		}
	},

	beforeUnmount() {
		this.teardown_signaling();
	},

	methods: {
		async setup_signaling() {
			const hPeer = await this.hashId(this.peerId);
			const hRemote = await this.hashId(this.remoteId);
			this.channel_remote = this.ns(`${hPeer}2${hRemote}`);
			this.channel_me = this.ns(`${hRemote}2${hPeer}`);
			console.log(
				'[rtc-peer:signal] ====== setup_signaling ======',
				'\n  peerId:', this.peerId, '→', hPeer,
				'\n  remoteId:', this.remoteId, '→', hRemote,
				'\n  channel_remote:', this.channel_remote,
				'\n  channel_me:', this.channel_me,
				'\n  polite:', this.polite
			);

			await new Promise((resolve, reject) => {
				this.mqtt_client.subscribe(`${this.channel_me}/#`, err => {
					if (err) {
						console.warn('[rtc-peer:signal] subscribe FAILED', err);
						reject(err);
					} else {
						console.log('[rtc-peer:signal] subscribed OK:', `${this.channel_me}/#`);
						resolve();
					}
				});
			});

			this._onMqttMessage = (topic, message) => {
				if (!topic.startsWith(`${this.channel_me}/`)) return;
				this.on_signaling_message(topic, message);
			};
			this.mqtt_client.on('message', this._onMqttMessage);
			console.log('[rtc-peer:signal] message listener registered');
		},

		teardown_signaling() {
			console.log('[rtc-peer:signal] ====== teardown_signaling ======');
			this.mqtt_client.unsubscribe(`${this.channel_me}/#`, err => {
				if (err) console.warn('[rtc-peer:signal] unsubscribe error:', err);
			});
			this.mqtt_client.removeListener('message', this._onMqttMessage);
			console.log('[rtc-peer:signal] listener removed');
		},

		on_signaling_message(topic, message) {
			var data;
			try {
				data = JSON.parse(message.toString());
			} catch (_) {
				console.warn(`[rtc-peer:signal] invalid JSON on ${topic}`);
				return;
			}
			var key = topic.replace(`${this.channel_me}/`, '');
			console.log(`[rtc-peer:signal] <<< MSG key="${key}"`);

			// ── candidate ────────────────────────────────────
			if (key == 'candidate') {
				var { tag, candidate } = data;
				var iceCandidate = candidate;
				if (candidate && typeof candidate === 'object' && candidate.candidate) {
					iceCandidate = new RTCIceCandidate(candidate);
				}
				const m = this.media_pc(tag);
				if (m) {
					console.log(`[rtc-peer:signal] ICE → media pc tag=${tag}`);
					addIceCandidateSafe(m.pc, iceCandidate);
				} else {
					if (!this.has_remote_description) {
						console.log(`[rtc-peer:signal] ICE → buffered (no remote description yet, count=${this.pending_candidates.length + 1})`);
						this.pending_candidates.push(iceCandidate);
					} else {
						console.log(`[rtc-peer:signal] ICE → main pc`);
						addIceCandidateSafe(this.pc, iceCandidate);
					}
				}
				return;
			}

			// ── description ────────────────────────────────────
			if (key == 'description') {
				var { tag, description } = data;
				console.log(`[rtc-peer:signal] <<< DESCRIPTION type=${description.type} tag=${tag} pcSignalingState=${this.pc.signalingState}`);

				// media PC
				const m = this.media_pc(tag);
				if (tag && tag.endsWith(this.remoteId)) {
					console.log(`[rtc-peer:signal] new media PC tag=${tag}`);
					var pc = this.add_media(tag);
					return pc.setRemoteDescription(description).then(() => {
						console.log(`[rtc-peer:signal] media setRemote OK, creating answer`);
						return pc.setLocalDescription().then(() => {
							console.log(`[rtc-peer:signal] media answer created, publishing`);
							return this.mqtt_client.publish(
								`${this.channel_remote}/description`,
								JSON.stringify({ tag, description: pc.localDescription })
							);
						});
					});
				}
				if (m) {
					console.log(`[rtc-peer:signal] existing media PC tag=${tag}, setting remote`);
					return m.pc.setRemoteDescription(description);
				}

				// ── data channel description ──
				const offer_collision = description.type === 'offer'
					&& (this.making_offer || this.pc.signalingState !== 'stable');

				var ignoreOffer = !this.polite && offer_collision;
				if (ignoreOffer) {
					console.log(`[rtc-peer:signal] offer collision: IMPOLITE → ignore, resend own offer`);
					if (this.pc.localDescription) {
						this.mqtt_client.publish(
							`${this.channel_remote}/description`,
							JSON.stringify({ description: this.pc.localDescription })
						);
					}
					return;
				}
				if (offer_collision) {
					console.log(`[rtc-peer:signal] offer collision: POLITE → rolling back local, accepting remote`);
					this.making_offer = false;
					return Promise.all([
						this.pc.setLocalDescription({ type: 'rollback' }),
						this.pc.setRemoteDescription(description)
					]).then(() => {
						this.has_remote_description = true;
						console.log(`[rtc-peer:signal] collision resolved, flushing ${this.pending_candidates.length} ICE candidates`);
						if (this.pending_candidates.length > 0) {
							this.pending_candidates.forEach(c => addIceCandidateSafe(this.pc, c));
							this.pending_candidates = [];
						}
						return this.pc.setLocalDescription().then(() => {
							console.log(`[rtc-peer:signal] publishing answer after collision recovery`);
							return this.mqtt_client.publish(
								`${this.channel_remote}/description`,
								JSON.stringify({ description: this.pc.localDescription })
							);
						});
					}).catch(err => {
						console.error('[rtc-peer:signal] collision recovery failed:', err);
					});
				}

				// Normal case: answer or non-colliding offer
				if (description.type === 'answer' && this.pc.signalingState === 'stable') {
					console.log(`[rtc-peer:signal] duplicate answer (pc already stable), ignored`);
					return;
				}

				console.log(`[rtc-peer:signal] setting remote ${description.type}, signalingState=${this.pc.signalingState}`);
				return this.pc
					.setRemoteDescription(description)
					.then(() => {
						console.log(`[rtc-peer:signal] setRemoteDescription OK, signalingState=${this.pc.signalingState}`);
						this.has_remote_description = true;
						if (this.pending_candidates.length > 0) {
							console.log(`[rtc-peer:signal] flushing ${this.pending_candidates.length} buffered ICE candidates`);
							this.pending_candidates.forEach(c => addIceCandidateSafe(this.pc, c));
							this.pending_candidates = [];
						}
						if (description.type === 'offer') {
							console.log(`[rtc-peer:signal] creating answer`);
							return this.pc.setLocalDescription().then(() => {
								console.log(`[rtc-peer:signal] publishing answer`);
								return this.mqtt_client.publish(
									`${this.channel_remote}/description`,
									JSON.stringify({ description: this.pc.localDescription })
								);
							});
						} else {
							console.log(`[rtc-peer:signal] answer applied, signalingState=${this.pc.signalingState}`);
						}
					})
					.catch(err => {
						console.error(`[rtc-peer:signal] setRemoteDescription FAILED: ${err.message}`);
					});
			}
		}
	}
};
