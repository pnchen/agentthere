/**
 * Chat members mixin
 * - Member lifecycle (add, remove)
 * - Connection state tracking
 * - Semi-persistent client uid
 * - Desktop notifications for member join
 */
import { nanoid_hex } from 'js/lib/nanoid';
import store from 'store';
import _ from 'underscore';

var KEY_UID = 'agentthere_uid';

// ── Semi-persistent client uid ──────────────────────────────────────────────
function getOrCreateUid() {
	var uid = store.get(KEY_UID);
	if (!uid) {
		uid = nanoid_hex();
		store.set(KEY_UID, uid);
	}
	return uid;
}

export default {
	data() {
		return {
			items_member: [],
			peer_id: nanoid_hex(),
			uid: getOrCreateUid(),
			group: this.$route.params.group || 'hello'
		};
	},
	created() {
		this.$watch('$route.params.group', val => {
			this.group = this.$route.params.group;
		});

		this.interval_cleanup_departed = setInterval(() => {
			const now = Date.now();
			this.items_member = this.items_member.filter(item => {
				if (!item.lost_at) return true;
				if (now - item.lost_at > 10000) {
					console.log('member lost expired, removed', item.id);
					return false;
				}
				return true;
			});
		}, 2000);

		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				// The tab is now visible, stale notifications can be cleared.
			}
		});
	},
	beforeUnmount() {
		clearInterval(this.interval_cleanup_departed);
	},
	methods: {
		add_member({ id, profile = {} }) {
			var item_member = _.findWhere(this.items_member, { id });
			if (item_member) {
				if (item_member.lost_at) {
					delete item_member.lost_at;
					console.log('member revived', id);
				}
				return;
			}
			this.items_member.push({ id, profile });
		},
		mark_member_lost(item_member) {
			const item = _.findWhere(this.items_member, { id: item_member.id });
			if (!item) return;
			item.lost_at = Date.now();
			console.log('member lost, will remove in 10s', item_member.id);
		},
		remove_member(item_member) {
			const idx = _.findIndex(this.items_member, { id: item_member.id });
			if (idx < 0) return;
			this.items_member.splice(idx, 1);
		},

		/**
		 * Handle connection state changes.
		 *
		 * No longer proactively remove members — lifecycle is fully controlled by signaling:
		 *   - Graceful leave: peer sends BYE on beforeUnmount → immediate removal
		 *   - Unexpected disconnect: MQTT keepalive expires → broker publishes will → up to ~180s removal
		 *
		 * Brief disconnections are handled by rtc-peer auto retry init_pc(),
		 * will not trigger BYE/will, members should stay in the list awaiting recovery.
		 */
		on_connection_state_changed(item_member, state) {
			// Only track state, do not auto-remove members
			if (item_member) {
				item_member.connectionState = state;
			}
		}
	}
};
