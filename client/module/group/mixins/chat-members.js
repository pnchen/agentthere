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
				// 该标签页已对用户可见，因此可以清除现已过时的通知。
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
		 * 连接状态变化处理。
		 *
		 * 不再主动移除 member —— member 生命周期完全由信令控制：
		 *   - 主动离开: 对方 beforeUnmount 发送 BYE → 即时移除
		 *   - 异常断开: MQTT keepalive 到期 → broker 发布 will → 最多 ~180s 移除
		 *
		 * 短暂断连（MQTT 瞬断等）由 rtc-peer 内部自动重试 init_pc()，
		 * 不会触发 BYE/will，member 应留在列表中等待恢复。
		 */
		on_connection_state_changed(item_member, state) {
			// 仅追踪状态，不自动移除 member
			if (item_member) {
				item_member.connectionState = state;
			}
		}
	}
};
