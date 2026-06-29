import _ from 'underscore';
import QrcodeVue from 'qrcode.vue';
import store from 'store';

import 'css/skin-black.css';
import settings from 'js/lib/settings';
import mqttShared from 'js/mixins/mqtt-shared.js';

import chatScroll from './mixins/chat-scroll.js';
import chatStore from './mixins/chat-store.js';
import chatMembers from './mixins/chat-members.js';
import chatMessaging from './mixins/chat-messaging.js';
import chatInputHistory from './mixins/chat-input-history.js';

import updateProfile from 'js/coms/update-profile/index.js';
import sendFilesConfirm from './coms/send-files-confirm/index.js';
import storageManager from './coms/storage-manager/index.js';
import chatHistory from './coms/chat-history/index.js';
import chatMessage from './coms/chat-message/index.js';
import inputText from './coms/input-text/index.js';
import inputVoice from 'js/coms/input-voice/index.js';
import vad from './coms/vad/index.js';
import systemSettings from 'js/coms/system-settings/index.js';

// 初始化皮肤
if (settings.theme === 'dark') {
	document.documentElement.classList.add('skin-black');
}
// 监听皮肤切换
import { watch } from 'vue';
watch(
	() => settings.theme,
	val => {
		if (val === 'dark') {
			document.documentElement.classList.add('skin-black');
		} else {
			document.documentElement.classList.remove('skin-black');
		}
	}
);

export default {
	template: require('./index.html?raw'),
	mixins: [chatScroll, chatStore, chatMembers, chatMessaging, chatInputHistory, mqttShared],
	components: {
		QrcodeVue,
		'update-profile': updateProfile,
		'send-files-confirm': sendFilesConfirm,
		'storage-manager': storageManager,
		'chat-history': chatHistory,
		'chat-message': chatMessage,
		'input-text': inputText,
		'input-voice': inputVoice,
		vad,
		'system-settings': systemSettings
	},
	data() {
		this.$root.selected = '首页';

		return {
			params: {
				text: null,
				peer_id: null,
				file_to_send: null,
				settings_open: false,
				profile_open: false,
				video: this.$route.query.video || false,
				audio: this.$route.query.audio || false
			},
			profile: settings.profile,
			sidebar_open: false,

			mention_active: false,
			mention_query: '',
			mention_index: 0,
			mention_start_pos: -1,
			mention_dismissed: false,
			mention_dismissed_pos: -1,
			control_active: false,
			control_query: '',
			control_index: 0,
			control_start_pos: -1,
			control_dismissed: false,
			control_dismissed_pos: -1,

			no_peer_hint: false,
			input_shake: false,
			is_desktop: window.innerWidth >= 992
		};
	},
	created() {
		if (this.$route.query.ns) {
			settings.signaling.namespace = this.$route.query.ns;
		}
		// 初始化 MQTT 连接（带 will）
		const connect = async () => {
			const hGroup = await this.hashId(this.group);
			const hPeer = await this.hashId(this.peer_id);
			const byeTopic = this.ns(`${hGroup}/bye`);
			const willTopic = this.ns(`${hGroup}/will`);
			return this.reconnect_mqtt({
				clientId: this.peer_id,
				will: {
					topic: willTopic,
					payload: JSON.stringify({ id: this.peer_id }),
					qos: 0,
					retain: false
				}
			});
		};
		connect();

		// settings 变更重新连接（跳过首次）
		var _settingsReady = false;
		this.$watch(
			() => settings.signaling,
			() => {
				if (!_settingsReady) {
					_settingsReady = true;
					return;
				}
				connect();
			},
			{ deep: true }
		);

		// 切换 group 时清空成员并重建 client
		this.$watch('group', () => {
			this.items_member = [];
			connect();
		});

		// @ mention 检测
		this.$watch('params.text', () => {
			this.$nextTick(() => {
				this.check_mention();
				this.check_control();
			});
		});

		this.$watch('group', val => {
			document.title = `${this.group}#AgentThere`;
		});
		document.title = `${this.group}#AgentThere`;
		window.addEventListener('resize', this.adaptToBreakpoint);
	},
	beforeUnmount() {
		window.removeEventListener('resize', this.adaptToBreakpoint);
	},
	mounted() {},
	computed: {
		mention_peers() {
			var all_peers = _.uniq([...(this.items_member || []), ...(this.items_member_manual || [])], false, function (peer) {
				return peer.id;
			});
			if (!this.mention_query) return all_peers;
			var query = this.mention_query.toLowerCase();
			return _.filter(all_peers, function (peer) {
				return peer.profile && peer.profile.name && peer.profile.name.toLowerCase().indexOf(query) > -1;
			});
		},
		control_commands() {
			return [
				{ name: '/stop', desc: '停止当前任务', icon: 'la-stop-circle', variant: 'danger' },
				{ name: '/new', desc: '开启新会话', icon: 'la-plus-circle', variant: 'primary' },
				{ name: '/help', desc: '查看可用命令', icon: 'la-question-circle', variant: 'muted' },
				{ name: '/status', desc: '查看会话状态', icon: 'la-info-circle', variant: 'muted' }
			];
		},
		control_commands_filtered() {
			if (!this.control_query) return this.control_commands;
			var q = this.control_query.toLowerCase();
			return this.control_commands.filter(cmd => cmd.name.toLowerCase().indexOf(q) > -1 || cmd.desc.indexOf(q) > -1);
		}
	},
	methods: {
		adaptToBreakpoint() {
			this.is_desktop = window.innerWidth >= 992;
			if (!this.is_desktop && this.sidebar_open) {
				this.sidebar_open = false;
			}
		},
		check_control() {
			var el = this.$refs.input_text && this.$refs.input_text.$el;
			if (!el) {
				this.control_active = false;
				return;
			}
			var cursorPos = el.selectionStart;
			var text = this.params.text || '';
			var textBeforeCursor = text.substring(0, cursorPos);
			// Only activate at the very start of the input (position 0 or after whitespace)
			var slashIndex = textBeforeCursor.lastIndexOf('/');
			if (slashIndex === -1) {
				this.control_active = false;
				this.control_dismissed = false;
				return;
			}
			var query = textBeforeCursor.substring(slashIndex + 1);
			if (/\s/.test(query)) {
				this.control_active = false;
				return;
			}
			if (this.control_dismissed && this.control_dismissed_pos === slashIndex) {
				this.control_active = false;
				return;
			}
			this.control_dismissed = false;
			if (query !== this.control_query) {
				this.control_index = 0;
			}
			this.control_query = query;
			this.control_start_pos = slashIndex;
			this.control_active = true;
		},
		select_control(cmd) {
			if (!cmd) return;
			var text = this.params.text || '';
			var el = this.$refs.input_text.$el;
			var cursorPos = el.selectionStart;
			var before = text.substring(0, this.control_start_pos);
			var after = text.substring(cursorPos);
			this.params.text = before + cmd.name + (after ? ' ' + after.trimStart() : ' ');
			this.control_active = false;
			this.$nextTick(() => {
				var newPos = before.length + cmd.name.length + 1;
				el.setSelectionRange(newPos, newPos);
				el.focus();
			});
		},
		control_navigate_up() {
			if (this.control_index > 0) this.control_index--;
			this.$nextTick(() => {
				var el = this.$el.querySelector('.control-dropdown .active');
				if (el) el.scrollIntoView({ block: 'nearest' });
			});
		},
		control_navigate_down() {
			if (this.control_index < this.control_commands_filtered.length - 1) this.control_index++;
			this.$nextTick(() => {
				var el = this.$el.querySelector('.control-dropdown .active');
				if (el) el.scrollIntoView({ block: 'nearest' });
			});
		},
		cancel_control() {
			this.control_active = false;
			this.control_dismissed = true;
			this.control_dismissed_pos = this.control_start_pos;
		},
		check_mention() {
			var el = this.$refs.input_text && this.$refs.input_text.$el;
			if (!el) {
				this.mention_active = false;
				return;
			}
			var cursorPos = el.selectionStart;
			var text = this.params.text || '';
			var textBeforeCursor = text.substring(0, cursorPos);
			var atIndex = textBeforeCursor.lastIndexOf('@');
			if (atIndex === -1) {
				this.mention_active = false;
				this.mention_dismissed = false;
				return;
			}
			var query = textBeforeCursor.substring(atIndex + 1);
			if (/\s/.test(query)) {
				this.mention_active = false;
				return;
			}
			if (this.mention_dismissed && this.mention_dismissed_pos === atIndex) {
				this.mention_active = false;
				return;
			}
			this.mention_dismissed = false;
			if (query !== this.mention_query) {
				this.mention_index = 0;
			}
			this.mention_query = query;
			this.mention_start_pos = atIndex;
			this.mention_active = true;
		},
		select_mention(peer) {
			if (!peer) return;
			var text = this.params.text || '';
			var el = this.$refs.input_text.$el;
			var cursorPos = el.selectionStart;
			var before = text.substring(0, this.mention_start_pos);
			var after = text.substring(cursorPos);
			var mention = '@' + peer.profile.name + ' ';
			this.params.text = before + mention + after;
			this.mention_active = false;
			this.$nextTick(() => {
				var newPos = before.length + mention.length;
				el.setSelectionRange(newPos, newPos);
				el.focus();
			});
		},
		mention_navigate_up() {
			if (this.mention_index > 0) {
				this.mention_index--;
			}
			this.$nextTick(() => {
				var el = this.$el.querySelector('.mention-dropdown .active');
				if (el) el.scrollIntoView({ block: 'nearest' });
			});
		},
		mention_navigate_down() {
			if (this.mention_index < this.mention_peers.length - 1) {
				this.mention_index++;
			}
			this.$nextTick(() => {
				var el = this.$el.querySelector('.mention-dropdown .active');
				if (el) el.scrollIntoView({ block: 'nearest' });
			});
		},
		cancel_mention() {
			this.mention_active = false;
			this.mention_dismissed = true;
			this.mention_dismissed_pos = this.mention_start_pos;
		},
		flash_no_peer_hint() {
			this.no_peer_hint = true;
			this.input_shake = false;
			this.$nextTick(() => {
				this.input_shake = true;
			});
			clearTimeout(this._no_peer_hint_timer);
			this._no_peer_hint_timer = setTimeout(() => {
				this.no_peer_hint = false;
			}, 2600);
			clearTimeout(this._input_shake_timer);
			this._input_shake_timer = setTimeout(() => {
				this.input_shake = false;
			}, 600);
		},
		commit_message() {
			if (this.$refs.input_speech && this.$refs.input_speech.thinking) return;
			var text = this.params.text;
			if (!text || !String(text).trim()) return;
			var peers_connected = _.filter(this.$refs.peer || [], com => {
				return com.state && com.state.connectionState == 'connected';
			});
			if (peers_connected.length == 0) {
				this.flash_no_peer_hint();
				return;
			}
			this.send_message({ text });
			this.add_to_input_history(text);
			this.params.text = null;
		}
	}
};
