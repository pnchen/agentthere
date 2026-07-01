/**
 * Media mixin — media PC lifecycle, track management, playback.
 */
import _ from 'underscore';
import settings from 'js/lib/settings.js';

export default {
	data() {
		return {
			media_pcs: [],
			stream: new MediaStream(),
			remote_stream_type: 'none',
			remote_audio_muted: false,
			interact_error_tip: null
		};
	},
	methods: {
		media_pc(tag) {
			return _.findWhere(this.media_pcs, { tag });
		},

		ensure_media(tag) {
			let m = this.media_pc(tag);
			if (m) return m.pc;

			const pc = this._create_media_pc({ tag });
			this.media_pcs.push({ pc, tag });

			if (tag.endsWith(this.remoteId)) {
				pc.onconnectionstatechange = event => {
					var state = event.currentTarget.connectionState;
					console.log('media in connectionstatechange', state);
					if (state == 'disconnected' || state == 'failed') {
						_.each(this.stream.getTracks(), t => this.stream.removeTrack(t));
						this.play_stream();
					}
				};
				pc.ontrack = ({ track }) => {
					console.log('ontrack', track);
					track.onunmute = () => {
						console.log('ontrack unmuted', track.muted, track);
						if (!_.find(this.stream.getTracks(), t => t == track)) {
							this.stream.addTrack(track);
						}
						this.play_stream();
					};
					track.onended = () => {
						console.log('ontrack ended');
						this.stream.removeTrack(track);
						this.play_stream();
					};
				};
			} else {
				pc.onnegotiationneeded = event => {
					console.log('media onnegotiationneeded');
					var p = event.currentTarget;
					return p
						.createOffer()
						.then(offer => p.setLocalDescription(offer))
						.then(() =>
							this.mqtt_client.publish(
								`${this.channel_remote}/description`,
								JSON.stringify({
									tag,
									description: p.localDescription,
									meta: { vad_applied: !!(this.localStreams && this.localStreams[0] && this.localStreams[0].vad_applied) }
								})
							)
						);
				};
			}
			return pc;
		},

		close_media(tag) {
			const idx = _.findIndex(this.media_pcs, { tag });
			if (idx < 0) return;
			this.media_pcs[idx].pc.close();
			this.media_pcs.splice(idx, 1);
		},

		_create_media_pc({ tag }) {
			var pc = new RTCPeerConnection({
				iceServers: settings.ice_servers,
				iceTransportPolicy: 'all',
				sdpSemantics: 'unified-plan'
			});
			pc.onicecandidate = ({ candidate }) => {
				return this.mqtt_client.publish(`${this.channel_remote}/candidate`, JSON.stringify({ tag, candidate }));
			};
			pc.onicecandidateerror = event => {
				console.log('icecandidateerror', event);
			};
			pc.onicegatheringstatechange = event => {
				console.log('icegatheringstatechange', event.currentTarget.iceGatheringState);
			};
			pc.oniceconnectionstatechange = event => {
				const iceState = event.currentTarget.iceConnectionState;
				console.log(`${tag} ice connection state:`, iceState);
				if (iceState === 'failed') {
					console.log(`${tag} failed, restarting...`);
					this.close_media(tag);
				this.ensure_media(tag);
				}
			};
			pc.onsignalingstatechange = () => {
				console.log('signalingstate', pc.signalingState);
			};
			return pc;
		},

		add_local_tracks() {
			if (!this.localStreams || this.localStreams.length == 0) {
				this.close_media('media:' + this.peerId);
				return;
			}

			const OUT_TAG = 'media:' + this.peerId;
			let m = this.media_pc(OUT_TAG);
			if (!m || m.pc.connectionState === 'closed' || m.pc.connectionState === 'failed' || m.pc.connectionState === 'disconnected') {
				this.close_media(OUT_TAG);
			this.ensure_media(OUT_TAG);
				m = this.media_pc(OUT_TAG);
			}

			var pc = m.pc;
			var exist_senders = pc.getSenders();

			_.each(this.localStreams, stream => {
				stream.getTracks().forEach(track => {
					var precise_sender = _.find(exist_senders, s => s.track && s.track.id === track.id);
					if (precise_sender) {
						console.log('track exists, skip', track.kind);
						exist_senders = _.without(exist_senders, precise_sender);
					} else {
						var kind_sender = _.find(exist_senders, s => s.track && s.track.kind === track.kind);
						if (kind_sender) {
							console.log('replace track', track.kind);
							kind_sender.replaceTrack(track).catch(e => console.error('replaceTrack error', e));
							exist_senders = _.without(exist_senders, kind_sender);
						} else {
							console.log('add local track', track.kind);
							pc.addTrack(track, stream);
						}
					}
				});
			});

			_.each(exist_senders, sender => {
				console.log('remove track', sender.track ? sender.track.kind : 'null');
				pc.removeTrack(sender);
			});
		},

		play_stream() {
			const tracks = this.stream.getTracks();
			const hasVideo = tracks.some(t => t.kind === 'video');
			const hasAudio = tracks.some(t => t.kind === 'audio');
			this.remote_stream_type = hasVideo ? 'video' : hasAudio ? 'audio' : 'none';
			this.sync_remote_audio_muted();

			let play;
			if (hasVideo && this.$refs.video) {
				if (this.$refs.video.srcObject !== this.stream) {
					this.$refs.video.srcObject = this.stream;
				}
				play = this.$refs.video.play();
			} else if (hasAudio && this.$refs.audio) {
				if (this.$refs.audio.srcObject !== this.stream) {
					this.$refs.audio.srcObject = this.stream;
				}
				play = this.$refs.audio.play();
			}
			this.interact_error_tip = null;
			if (play) {
				return play.catch(err => {
					console.error(err);
					this.interact_error_tip = 'Please click the play button';
				});
			}
		},

		toggle_remote_audio_muted() {
			this.remote_audio_muted = !this.remote_audio_muted;
			this.sync_remote_audio_muted();
			if (!this.remote_audio_muted) this.play_stream();
		},

		sync_remote_audio_muted() {
			if (this.$refs.audio) this.$refs.audio.muted = this.remote_audio_muted;
			if (this.$refs.video) this.$refs.video.muted = this.remote_audio_muted;
		}
	},

	beforeUnmount() {
		console.log('[rtc-peer:media] ====== beforeUnmount ======');
		this.media_pcs.slice().forEach(m => m.pc.close());
		this.media_pcs = [];
	}
};
