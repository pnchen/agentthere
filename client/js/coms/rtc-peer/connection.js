/**
 * Connection mixin — RTCPeerConnection lifecycle and retry loop.
 */
import settings from 'js/lib/settings.js';

const CONNECT_TIMEOUT = 20000;
const RETRY_BACKOFF = [300, 1000, 3000, 10000, 30000, 60000];
const MAX_NEGOTIATION_LIFETIME = 100;

let _connId = 0;

export default {
	data() {
		return {
			_dead: false,
			state: {},
			pc: null,
			lifetime_negotiation: null
		};
	},

	created() {
		this._onVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				console.log('[rtc-peer:conn] visibilitychange → visible, checking PC');
				const pcDead = this.pc && (
					this.pc.signalingState === 'closed' ||
					this.pc.connectionState === 'closed' ||
					this.pc.connectionState === 'failed'
				);
				if (pcDead && this._serveResolve) {
					console.log('[rtc-peer:conn] PC is dead, unblocking serve()');
					const resolve = this._serveResolve;
					this._serveResolve = null;
					resolve();
				}
			}
		};
		document.addEventListener('visibilitychange', this._onVisibilityChange);
	},

	beforeUnmount() {
		console.log(`[rtc-peer:conn] ====== beforeUnmount ====== _dead=${this._dead} pc=${!!this.pc}`);
		this._dead = true;
		clearTimeout(this._retry_timer);
		this._serveResolve = null;
		if (this._onVisibilityChange) {
			document.removeEventListener('visibilitychange', this._onVisibilityChange);
		}
		if (this.pc) {
			this.pc.close();
			this.pc = null;
			console.log(`[rtc-peer:conn] pc closed`);
		}
		console.log(`[rtc-peer:conn] beforeUnmount DONE`);
	},

	methods: {
		sleep(ms) {
			return new Promise(r => setTimeout(r, ms));
		},

		timeout(ms) {
			return new Promise((_, reject) => {
				this._retry_timer = setTimeout(() => {
					console.log(`[rtc-peer:conn] ⏱ TIMEOUT after ${ms}ms`);
					reject('timeout');
				}, ms);
			});
		},

		init_pc() {
			const connId = ++_connId;
			return new Promise((resolve, reject) => {
				if (this._dead) {
					console.log(`[rtc-peer:conn #${connId}] ⨯ _dead, abort`);
					return resolve();
				}
				console.log(`[rtc-peer:conn #${connId}] ====== init_pc START ======`);
				if (this.pc) {
					console.log(`[rtc-peer:conn #${connId}] closing old pc`);
					this.pc.close();
					this.pc = null;
				}
				this.state = {};
				this.lifetime_negotiation = MAX_NEGOTIATION_LIFETIME;
				this.pc = new RTCPeerConnection({
					iceServers: settings.ice_servers,
					iceTransportPolicy: 'all',
					sdpSemantics: 'unified-plan'
				});
				console.log(`[rtc-peer:conn #${connId}] RTCPeerConnection created`);

				this.pc.onicecandidate = ({ candidate }) => {
					var type = candidate ? candidate.type : 'null';
					console.log(`[rtc-peer:conn #${connId}] onicecandidate type=${type} sdpMLineIndex=${candidate ? candidate.sdpMLineIndex : '-'}`);
					if (!candidate) return;
					this.mqtt_client.publish(
						`${this.channel_remote}/candidate`,
						JSON.stringify({ candidate })
					);
				};

				this.pc.onicecandidateerror = event => {
					console.log(`[rtc-peer:conn #${connId}] icecandidateerror`, event);
				};

				this.pc.onconnectionstatechange = event => {
					var state = event.currentTarget.connectionState;
					console.log(`[rtc-peer:conn #${connId}] onconnectionstatechange → ${state}  (signalingState=${this.pc.signalingState})`);
					this.state.connectionState = state;

					if (state === 'connected') {
						console.log(`[rtc-peer:conn #${connId}] ✓ CONNECTED`);
						clearTimeout(this._retry_timer);
						resolve();
					} else if (state === 'disconnected') {
						console.log(`[rtc-peer:conn #${connId}] ⨯ DISCONNECTED`);
						this.datachannel_message = null;
						this.pending_candidates = [];
						this.has_remote_description = false;
						reject(state);
					} else if (state === 'failed') {
						console.log(`[rtc-peer:conn #${connId}] ⨯ FAILED`);
						this.datachannel_message = null;
						this.pending_candidates = [];
						this.has_remote_description = false;
						reject(state);
					} else if (state === 'closed') {
						console.log(`[rtc-peer:conn #${connId}] ⨯ CLOSED`);
						clearTimeout(this._retry_timer);
						reject('closed');
					}
					this.$emit('connection-state-changed', state);
				};

				this.pc.onicegatheringstatechange = event => {
					var state = event.currentTarget.iceGatheringState;
					console.log(`[rtc-peer:conn #${connId}] onicegatheringstatechange → ${state}`);
					this.state.iceGatheringState = state;
				};

				this.pc.oniceconnectionstatechange = event => {
					var state = event.currentTarget.iceConnectionState;
					console.log(`[rtc-peer:conn #${connId}] oniceconnectionstatechange → ${state}`);
					this.state.iceConnectionState = state;
				};

				this.pc.ondatachannel = event => {
					var channel = event.channel;
					console.log(`[rtc-peer:conn #${connId}] ondatachannel label=${channel.label}`);
					channel.onmessage = e => this.on_datachannel_message(e);
					channel.onopen = () => {
						console.log(`[rtc-peer:conn #${connId}] remote datachannel OPEN label=${channel.label}`);
						if (!this.datachannel_message || this.datachannel_message.readyState !== 'open') {
							this.datachannel_message = channel;
						}
						this.send_profile();
					};
					channel.onclose = () => {
						console.log(`[rtc-peer:conn #${connId}] remote datachannel CLOSED label=${channel.label}`);
					};
				};

				this.pc.onsignalingstatechange = () => {
					console.log(`[rtc-peer:conn #${connId}] onsignalingstatechange → ${this.pc.signalingState}`);
				};

				this.pc.onnegotiationneeded = () => {
					this.lifetime_negotiation--;
					console.log(`[rtc-peer:conn #${connId}] onnegotiationneeded (remaining=${this.lifetime_negotiation})`);
					if (this.lifetime_negotiation < 0 || !this.pc) {
						console.log(`[rtc-peer:conn #${connId}] onnegotiationneeded → skipped`);
						return;
					}
					this.making_offer = true;
					return this.pc
						.createOffer()
						.then(offer => {
							console.log(`[rtc-peer:conn #${connId}] createOffer OK, signalingState=${this.pc.signalingState}`);
							return this.pc.setLocalDescription(offer);
						})
						.then(() => {
							console.log(`[rtc-peer:conn #${connId}] setLocalDescription OK, signalingState=${this.pc.signalingState}`);
							return this.mqtt_client.publish(
								`${this.channel_remote}/description`,
								JSON.stringify({ description: this.pc.localDescription })
							);
						})
						.then(() => {
							console.log(`[rtc-peer:conn #${connId}] offer published to ${this.channel_remote}/description`);
						})
						.catch(err => console.error(`[rtc-peer:conn #${connId}] negotiation error:`, err))
						.finally(() => { this.making_offer = false; });
				};

				this.making_offer = false;
				this.has_remote_description = false;
				this.pending_candidates = [];
				// Only the offerer creates a DataChannel (triggers onnegotiationneeded → offer).
				// The non-offerer waits for the remote offer via MQTT signaling.
				if (this.offerer) {
					this.datachannel_message = this.pc.createDataChannel(`message`);
					console.log(`[rtc-peer:conn #${connId}] local datachannel created label=message`);
					this.datachannel_message.onmessage = e => this.on_datachannel_message(e);
					this.datachannel_message.onopen = () => {
						console.log(`[rtc-peer:conn #${connId}] local datachannel OPEN`);
						this.send_profile();
					};
					this.datachannel_message.onclose = () => {
						console.log(`[rtc-peer:conn #${connId}] local datachannel CLOSED`);
					};
				}

				console.log(`[rtc-peer:conn #${connId}] init_pc DONE, offerer=${this.offerer}`);
			});
		},

		serve() {
			return new Promise(resolve => {
				const pc = this.pc;
				console.log(`[rtc-peer:conn] serve START pc=${!!pc} _dead=${this._dead}`);
				if (!pc || this._dead) return resolve();
				this.add_local_tracks();
				console.log(`[rtc-peer:conn] serve add_local_tracks done`);

				// Store resolve so visibilitychange can unblock a stuck serve().
				this._serveResolve = resolve;

				const handler = event => {
					const state = event.currentTarget.connectionState;
					console.log(`[rtc-peer:conn] serve connectionstatechange → ${state}`);
					if (state === 'disconnected' || state === 'failed' || state === 'closed') {
						pc.removeEventListener('connectionstatechange', handler);
						this._serveResolve = null;
						console.log(`[rtc-peer:conn] serve EXIT via ${state}`);
						resolve();
					}
				};
				pc.addEventListener('connectionstatechange', handler);
			});
		},

		async _connect_loop() {
			const BACKOFF = RETRY_BACKOFF;
			console.log(`[rtc-peer:conn] ====== _connect_loop START ======`);

			// Offerer waits 1s before sending the first offer to let the
			// non-offerer's per-peer signaling subscription settle.
			if (this.offerer) {
				await this.sleep(1000);
			}

			while (!this._dead) {
				console.log(`[rtc-peer:conn] _connect_loop iteration start, _dead=${this._dead}`);
				try {
					await Promise.race([this.init_pc(), this.timeout(CONNECT_TIMEOUT)]);
					if (this._dead) return;
					this._retry_count = 0;
					console.log(`[rtc-peer:conn] _connect_loop init_pc SUCCESS, entering serve`);
					await this.serve();
					console.log(`[rtc-peer:conn] _connect_loop serve ended, will retry`);
				} catch (e) {
					if (this._dead) return;
					this._retry_count = (this._retry_count || 0) + 1;
					const delay = BACKOFF[Math.min(this._retry_count - 1, BACKOFF.length - 1)];
					console.log(`[rtc-peer:conn] _connect_loop error "${e}", retry #${this._retry_count}, delay=${delay}ms`);
					await this.sleep(delay);
				}
			}
			console.log(`[rtc-peer:conn] ====== _connect_loop END (_dead=true) ======`);
		}
	}
};
