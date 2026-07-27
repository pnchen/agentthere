/**
 * Media mixin — media PC lifecycle, track management, playback.
 */
import _ from 'underscore';
import settings from 'js/lib/settings.js';

export default {
	data() {
		return {
			media_pcs: [],
			remote_video_stream: new MediaStream(),
			remote_audio_entries: [],
			remote_track_entries: [],
			remote_audio_duck_volume: 0.2,
			remote_stream_type: 'none',
			remote_audio_muted: false,
			interact_error_tip: null
		};
	},
	methods: {
		media_pc(tag) {
			return _.findWhere(this.media_pcs, { tag });
		},

		ensure_media(tag, { media_id = null, media_type = null } = {}) {
			let m = this.media_pc(tag);
			if (m) {
				if (media_id) m.media_id = media_id;
				if (media_type) m.media_type = media_type;
				return m.pc;
			}

			const pc = this._create_media_pc({ tag });
			const mediaEntry = { pc, tag, media_id, media_type };
			this.media_pcs.push(mediaEntry);

			if (this.is_remote_media_tag(tag)) {
				pc.onconnectionstatechange = event => {
					var state = event.currentTarget.connectionState;
					console.log('media in connectionstatechange', state, tag);
					if (state == 'disconnected' || state == 'failed' || state == 'closed') {
						this._remove_remote_tracks(tag);
					}
				};
				pc.ontrack = ({ track }) => {
					console.log('ontrack', tag, track.kind, track.id, 'muted=', track.muted);
					const add_track = () => {
						console.log('ontrack unmuted', tag, mediaEntry.media_type, track.kind, track.id);
						this._add_remote_track(tag, track, mediaEntry.media_type);
					};
					track.onunmute = add_track;
					track.onended = () => {
						console.log('ontrack ended', tag, track.kind, track.id);
						this._remove_remote_track(track);
					};
					if (!track.muted) add_track();
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
									media_id: tag.endsWith('/input') ? 'input' : undefined,
									media_type: tag.endsWith('/input') ? 'input' : undefined,
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
			this._remove_remote_tracks(tag);
			this.media_pcs[idx].pc.close();
			this.media_pcs.splice(idx, 1);
		},

		_add_remote_track(tag, track, media_type = null) {
			if (_.find(this.remote_track_entries, entry => entry.track === track)) return;
			const media_connection = this.media_pc(tag);
			const entry = { tag, media_id: media_connection?.media_id ?? null, media_type, track };
			this.remote_track_entries.push(entry);
			if (track.kind === 'video') {
				this.remote_video_stream.addTrack(track);
			} else {
				this.remote_audio_entries.push({
					tag,
					media_id: entry.media_id,
					media_type,
					track,
					stream: new MediaStream([track]),
					element: null
				});
			}
			this.play_stream();
		},

		_remove_remote_track(track) {
			const entry = _.find(this.remote_track_entries, item => item.track === track);
			if (!entry) return;
			this.remote_track_entries = _.without(this.remote_track_entries, entry);
			if (track.kind === 'video') {
				this.remote_video_stream.removeTrack(track);
			} else {
				const audio_entry = _.find(this.remote_audio_entries, item => item.track === track);
				if (audio_entry?.element) {
					audio_entry.element.pause();
					audio_entry.element.srcObject = null;
				}
				if (audio_entry) this.remote_audio_entries = _.without(this.remote_audio_entries, audio_entry);
			}
			this.play_stream();
		},

		_remove_remote_tracks(tag) {
			const entries = _.filter(this.remote_track_entries, entry => entry.tag === tag);
			if (entries.length === 0) return;
			_.each(entries, entry => this._remove_remote_track(entry.track));
		},

		bind_remote_audio_element(entry, element) {
			if (!element) {
				entry.element = null;
				return;
			}
			entry.element = element;
			if (element.srcObject !== entry.stream) element.srcObject = entry.stream;
			element.muted = this.remote_audio_muted;
			element.volume = this._remote_audio_volume(entry);
			element.play().catch(err => {
				console.error('remote audio play failed', err);
				this.interact_error_tip = 'Please click the play button';
			});
		},

		_create_media_pc({ tag }) {
			var pc = new RTCPeerConnection({
				iceServers: settings.ice_servers,
				iceTransportPolicy: 'all',
				sdpSemantics: 'unified-plan'
			});
			pc.onicecandidate = ({ candidate }) => {
				return this.mqtt_client.publish(`${this.channel_remote}/candidate`, JSON.stringify({
					tag,
					media_id: tag.endsWith('/input') ? 'input' : undefined,
					media_type: tag.endsWith('/input') ? 'input' : undefined,
					candidate,
				}));
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
				this.close_media('media:' + this.peerId + '/input');
				return;
			}

			const OUT_TAG = 'media:' + this.peerId + '/input';
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
			const hasVideo = this.remote_video_stream.getVideoTracks().length > 0;
			const hasAudio = this.remote_audio_entries.length > 0;
			this.remote_stream_type = hasVideo ? 'video' : hasAudio ? 'audio' : 'none';
			this.sync_remote_audio_muted();
			if (this.$refs.video) {
				if (this.$refs.video.srcObject !== this.remote_video_stream) {
					this.$refs.video.srcObject = this.remote_video_stream;
				}
				if (hasVideo) {
					this.$refs.video.play().catch(err => {
						console.error('remote video play failed', err);
						this.interact_error_tip = 'Please click the play button';
					});
				}
			}
			this.interact_error_tip = null;
		},

		toggle_remote_audio_muted() {
			this.remote_audio_muted = !this.remote_audio_muted;
			this.sync_remote_audio_muted();
			if (!this.remote_audio_muted) this.play_stream();
		},

		_remote_audio_volume(entry) {
			const hasTts = _.some(this.remote_audio_entries, item => item.media_type === 'tts');
			return hasTts && entry.media_type !== 'tts' ? this.remote_audio_duck_volume : 1;
		},

		sync_remote_audio_muted() {
			// Each remote audio track has its own element. The browser mixes
			// the elements at the output device without a Web Audio mixer.
			_.each(this.remote_audio_entries, entry => {
				if (entry.element) {
					entry.element.muted = this.remote_audio_muted;
					entry.element.volume = this._remote_audio_volume(entry);
				}
			});
			if (this.$refs.video) this.$refs.video.muted = true;
		}
	},

	beforeUnmount() {
		console.log('[rtc-peer:media] ====== beforeUnmount ======');
		this.media_pcs.slice().forEach(m => m.pc.close());
		this.media_pcs = [];
	}
};
