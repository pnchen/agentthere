import mqttShared from 'js/mixins/mqtt-shared.js';

/**
 * mDNS-style group discovery via MQTT — no periodic presence broadcast.
 *
 * Joiner sends a query; existing peers answer on the joiner's private
 * answer channel.  Only the joiner initiates WebRTC offers → zero SDP
 * collision.  Goodbye messages (explicit on unmount) replace heartbeat
 * timeouts for sub-second offline detection.
 *
 * Topics:
 *   {ns}/h(group)/query             — listened by all peers
 *   {ns}/h(group)/h(peer)/answer    — private answer channel (carried in query)
 *   {ns}/h(group)/bye               — goodbye (shared, id in payload)
 */

export default {
	template: require('./index.html?raw'),
	mixins: [mqttShared],
	props: ['group', 'peer_id', 'profile'],
	data() {
		return {
			queryTopic: null,
			answerTopic: null,
			byeTopic: null,
			willTopic: null
		};
	},
	async created() {
		const hGroup = await this.hashId(this.group);
		const hPeer = await this.hashId(this.peer_id);

		this.queryTopic = this.ns(`${hGroup}/query`);
		this.answerTopic = this.ns(`${hGroup}/${hPeer}/answer`);
		this.byeTopic = this.ns(`${hGroup}/bye`);
		this.willTopic = this.ns(`${hGroup}/will`);

		console.log(
			'[agentthere:discovery] ====== CREATED ======',
			'\n  group:',
			this.group,
			'→ hGroup:',
			hGroup,
			'\n  peer_id:',
			this.peer_id,
			'→ hPeer:',
			hPeer,
			'\n  queryTopic:',
			this.queryTopic,
			'\n  answerTopic:',
			this.answerTopic,
			'\n  byeTopic:',
			this.byeTopic,
			'\n  willTopic:',
			this.willTopic,
			'\n  mqtt_state.connection:',
			this.mqtt_state.connection,
			'\n  mqtt_state.ready:',
			this.mqtt_state.ready,
			'\n  mqtt_client:',
			!!this.mqtt_client
		);

		const client = this.mqtt_client;
		if (!client) {
			console.warn('[agentthere:discovery] MQTT client not available at created()');
			return;
		}

		console.log(`[agentthere:discovery] subscribing query=${this.queryTopic} answer=${this.answerTopic} bye=${this.byeTopic}`);

		client.subscribe(this.queryTopic, err => {
			if (err) {
				console.warn('[agentthere:discovery] subscribe query FAILED', err);
			} else {
				console.log('[agentthere:discovery] subscribe query OK:', this.queryTopic);
			}
		});
		client.subscribe(this.answerTopic, err => {
			if (err) {
				console.warn('[agentthere:discovery] subscribe answer FAILED', err);
			} else {
				console.log('[agentthere:discovery] subscribe answer OK:', this.answerTopic);
			}
		});
		client.subscribe(this.byeTopic, err => {
			if (err) {
				console.warn('[agentthere:discovery] subscribe bye FAILED', err);
			} else {
				console.log('[agentthere:discovery] subscribe bye OK:', this.byeTopic);
			}
		});
		client.subscribe(this.willTopic, err => {
			if (err) {
				console.warn('[agentthere:discovery] subscribe will FAILED', err);
			} else {
				console.log('[agentthere:discovery] subscribe will OK:', this.willTopic);
			}
		});

		var _querySent = false;
		var send_query = () => {
			const q = JSON.stringify({ answer_to: this.answerTopic, id: this.peer_id });
			console.log(`[agentthere:discovery] >>> QUERY  ${this.queryTopic}  ${q}`);
			this.mqtt_client.publish(this.queryTopic, q, err => {
				if (err) {
					console.warn('[agentthere:discovery] publish query FAILED', err);
				} else {
					console.log('[agentthere:discovery] publish query OK');
				}
			});
		};
		send_query();

		this._onMessage = (topic, msg) => {
			var raw = msg.toString();
			console.log(`[agentthere:discovery] <<< MSG topic=${topic} raw=${raw.substring(0, 120)}`);
			var data;
			try {
				data = JSON.parse(raw);
			} catch (_) {
				console.log('[agentthere:discovery]   ⨯ not JSON, ignored');
				return;
			}

			if (topic === this.queryTopic) {
				console.log(
					`[agentthere:discovery]   → QUERY handler | from_id=${data.id} answer_to=${data.answer_to} my_answerTopic=${this.answerTopic}`
				);
				if (data.answer_to === this.answerTopic) {
					console.log('[agentthere:discovery]   ⨯ own query echo, ignored');
					return;
				}
				if (data.id && data.id !== this.peer_id) {
					console.log(`[agentthere:discovery]   ✓ EMIT member-detected | id=${data.id}`);
				// Delay 1s to give the other peer's per-peer signaling subscription
				// time to settle before we start connecting.  Without this, the
				// offerer's SDP offer may arrive before the subscription is active
				// (QoS 0 → lost) and a retry cycle is needed.
					setTimeout(() => {
						this.$emit('member-detected', { id: data.id, profile: { agent: data.agent || undefined } });
					}, 1000);
				} else {
					console.log(`[agentthere:discovery]   ⨯ self or no id, ignored`);
				}
				const answerPayload = JSON.stringify({ id: this.peer_id });
				console.log(`[agentthere:discovery]   >>> ANSWER  ${data.answer_to}  ${answerPayload}`);
				this.mqtt_client.publish(data.answer_to, answerPayload);
				return;
			}
			if (topic === this.answerTopic) {
				const id = data.id;
				console.log(`[agentthere:discovery]   → ANSWER handler | from_id=${id} my_peer_id=${this.peer_id}`);
				if (!id || id === this.peer_id) {
					console.log('[agentthere:discovery]   ⨯ self or no id, ignored');
					return;
				}
				console.log(`[agentthere:discovery]   ✓ EMIT member-detected | id=${id}`);
				this.$emit('member-detected', { id, profile: { agent: data.agent || undefined } });
				return;
			}
			if (topic === this.byeTopic) {
				const id = data.id;
				console.log(`[agentthere:discovery]   → BYE handler | from_id=${id} my_peer_id=${this.peer_id}`);
				if (!id || id === this.peer_id) {
					console.log('[agentthere:discovery]   ⨯ self or no id, ignored');
					return;
				}
				console.log(`[agentthere:discovery]   ✓ EMIT member-left | id=${id}`);
				this.$emit('member-left', { id });
				return;
			}
			if (topic === this.willTopic) {
				const id = data.id;
				console.log(`[agentthere:discovery]   → WILL handler | from_id=${id} my_peer_id=${this.peer_id}`);
				if (!id || id === this.peer_id) {
					console.log('[agentthere:discovery]   ⨯ self or no id, ignored');
					return;
				}
				console.log(`[agentthere:discovery]   ✓ EMIT member-lost | id=${id}`);
				this.$emit('member-lost', { id });
				return;
			}
			console.log(`[agentthere:discovery]   ⨯ unmatched topic, ignored`);
		};
		client.on('message', this._onMessage);
		console.log('[agentthere:discovery] message listener registered');

		this.$watch(
			() => this.mqtt_state.connection,
			(val, old) => {
				if (val === 'connected' && old !== 'connected') {
					console.log('[agentthere:discovery] MQTT reconnected, re-sending QUERY');
					send_query();
				}
			}
		);
	},
	beforeUnmount() {
		console.log(
			'[agentthere:discovery] ====== BEFORE UNMOUNT ======',
			'\n  mqtt_state.ready:',
			this.mqtt_state.ready,
			'\n  mqtt_state.connection:',
			this.mqtt_state.connection,
			'\n  mqtt_client:',
			!!this.mqtt_client,
			'\n  byeTopic:',
			this.byeTopic
		);
		const byePayload = JSON.stringify({ id: this.peer_id });
		console.log(`[agentthere:discovery] >>> BYE  ${this.byeTopic}  ${byePayload}`);
		const client = this.mqtt_client;
		if (client) {
			client.publish(this.byeTopic, byePayload, err => {
				if (err) {
					console.warn('[agentthere:discovery] publish bye FAILED', err);
				} else {
					console.log('[agentthere:discovery] publish bye OK');
				}
			});
			client.unsubscribe(this.queryTopic, err => {
				if (err) console.warn('[agentthere:discovery] unsubscribe query FAILED', err);
			});
			client.unsubscribe(this.answerTopic, err => {
				if (err) console.warn('[agentthere:discovery] unsubscribe answer FAILED', err);
			});
			client.unsubscribe(this.byeTopic, err => {
				if (err) console.warn('[agentthere:discovery] unsubscribe bye FAILED', err);
			});
			client.unsubscribe(this.willTopic, err => {
				if (err) console.warn('[agentthere:discovery] unsubscribe will FAILED', err);
			});
			client.removeListener('message', this._onMessage);
			console.log('[agentthere:discovery] message listener removed');
		} else {
			console.warn('[agentthere:discovery] no client to cleanup');
		}
		console.log('[agentthere:discovery] ====== UNMOUNT DONE ======');
	}
};
