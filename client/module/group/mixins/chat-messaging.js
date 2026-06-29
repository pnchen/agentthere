/**
 * Chat messaging mixin
 * - Message receiving (real-time + chunks + text chunks)
 * - Message sending (text + file)
 * - Chat message composition (add_chat_message)
 * - Chunk send tracking
 */
import _ from 'underscore';
import moment from 'moment';
import { nanoid_hex, nanoid_tree_safe } from 'js/lib/nanoid';
import { Base64 } from 'js-base64';
import apply_patch from '../lib/apply-patch';

var icon_logo = 'assets/image/logo.png';

import settings from 'js/lib/settings';

export default {
	data() {
		return {
			last_message_date: null,
			messages: null,
			streams_media: null,
			streams_voice_source: null,
			streams_voice: null,
			settings
		};
	},
	created() {
		this.all_chunks = {};
	},
	mounted() {
		this.$el.addEventListener('paste', e => {
			for (var i = 0, len = e.clipboardData.items.length; i < len; i++) {
				var item = e.clipboardData.items[i];
				if (item.kind === 'file') {
					var pasteFile = item.getAsFile();
					this.params.file_to_send = pasteFile;
					e.preventDefault();
					e.stopPropagation();
				}
			}
		});
		this.$el.addEventListener('dragover', e => {
			e.preventDefault();
		});
		this.$el.addEventListener('drop', e => {
			e.preventDefault();
			var file = e.dataTransfer.files[0];
			this.params.file_to_send = file;
		});
	},
	methods: {
		message_received(message) {
			console.log(`message received`, message);
			this.last_message_date = Date.now();

			if (message.type === 'profile') {
				var member = _.findWhere(this.items_member, { profile: message.from });
				if (member) {
					_.extend(member.profile, message.profile);
				}
				if (!document.hasFocus()) {
					Notification.requestPermission().then(status => {
						if (status === 'granted') {
							var n = new Notification(`${this.group}`, {
								icon: icon_logo,
								body: `${message.profile.name} joined`
							});
							n.onclick = e => {
								e.preventDefault();
								window.focus();
							};
						}
					});
				}
				return;
			}

			if (message.chunk) {
				return this.chunk_message_received(message);
			} else if (!_.isUndefined(message.text_chunk)) {
				return this.text_chunk_message_received(message);
			} else if (message.id) {
				// Incremental update — merge fields into the existing message.
				var target = _.findWhere(this.messages, { id: message.id });
				if (!target) {
					// First time seeing this id — bootstrap a stub bubble.
					var bootstrap = { ...message, date: moment() };
					if (Array.isArray(bootstrap._patch)) {
						if (!Array.isArray(bootstrap.segments)) bootstrap.segments = [];
						apply_patch(bootstrap, bootstrap._patch);
						delete bootstrap._patch;
					}
					// Legacy compat (older agents pre-_patch).
					if (bootstrap._pushTool) {
						bootstrap.tools = bootstrap.tools || [];
						bootstrap.tools.push({
							name: bootstrap._pushTool.name,
							phase: bootstrap._pushTool.phase,
							args: bootstrap._pushTool.args,
							argsSummary: bootstrap._pushTool.argsSummary,
							events: [],
							ts: Date.now()
						});
						delete bootstrap._pushTool;
					}
					if (bootstrap._pushToolResult) {
						bootstrap.tool_results = bootstrap.tool_results || [];
						bootstrap.tool_results.push({ text: bootstrap._pushToolResult, ts: Date.now() });
						delete bootstrap._pushToolResult;
					}
					if (bootstrap._pushToolEvent) {
						bootstrap.tools = bootstrap.tools || [];
						var bev = bootstrap._pushToolEvent;
						bootstrap.tools.push({
							name: bev.name || bev.kind || 'tool',
							phase: bev.phase,
							itemId: bev.itemId,
							toolCallId: bev.toolCallId,
							events: [{ ...bev, ts: Date.now() }],
							ts: Date.now()
						});
						delete bootstrap._pushToolEvent;
					}
					if (bootstrap._appendReasoning) {
						bootstrap.reasoning = (bootstrap.reasoning || '') + bootstrap._appendReasoning;
						delete bootstrap._appendReasoning;
					}
					if (!_.isUndefined(bootstrap.text_chunk)) {
						bootstrap.text = (bootstrap.text || '') + bootstrap.text_chunk;
						delete bootstrap.text_chunk;
					}
					this.add_chat_message(bootstrap);
					return;
				}

				// New generic protocol: apply a list of patch ops.
				if (Array.isArray(message._patch)) {
					if (!Array.isArray(target.segments)) target.segments = [];
					apply_patch(target, message._patch);
				}

				// ── legacy compat below ─────────────────────────────────
				if (message._pushTool) {
					if (!target.tools) target.tools = [];
					var t = message._pushTool;
					var last = target.tools.length > 0 ? target.tools[target.tools.length - 1] : null;
					if (!last || last.name !== t.name || t.phase === 'start') {
						target.tools.push({
							name: t.name,
							phase: t.phase,
							args: t.args,
							argsSummary: t.argsSummary,
							events: [],
							ts: Date.now()
						});
					} else if (last) {
						if (t.args) last.args = t.args;
						if (t.argsSummary) last.argsSummary = t.argsSummary;
					}
				}

				if (message._pushToolResult) {
					if (!target.tool_results) target.tool_results = [];
					target.tool_results.push({ text: message._pushToolResult, ts: Date.now() });
				}

				if (message._pushToolEvent) {
					if (!target.tools) target.tools = [];
					var ev = message._pushToolEvent;
					var attachTo = null;
					if (ev.toolCallId || ev.itemId) {
						for (var ii = target.tools.length - 1; ii >= 0; ii--) {
							var cand = target.tools[ii];
							if ((ev.toolCallId && cand.toolCallId === ev.toolCallId) || (ev.itemId && cand.itemId === ev.itemId)) {
								attachTo = cand;
								break;
							}
						}
					}
					if (!attachTo) {
						attachTo = target.tools.length > 0 ? target.tools[target.tools.length - 1] : null;
					}
					if (!attachTo) {
						attachTo = {
							name: ev.name || ev.kind || 'tool',
							phase: ev.phase,
							itemId: ev.itemId,
							toolCallId: ev.toolCallId,
							events: [],
							ts: Date.now()
						};
						target.tools.push(attachTo);
					}
					if (!attachTo.events) attachTo.events = [];
					attachTo.events.push({ ...ev, ts: Date.now() });
					if (ev.itemId && !attachTo.itemId) attachTo.itemId = ev.itemId;
					if (ev.toolCallId && !attachTo.toolCallId) attachTo.toolCallId = ev.toolCallId;
				}

				if (message._appendReasoning) {
					if (!target.reasoning) target.reasoning = '';
					target.reasoning += message._appendReasoning;
				}

				// Merge all other scalar fields
				var skipKeys = {
					id: 1,
					_patch: 1,
					_pushTool: 1,
					_pushToolResult: 1,
					_pushToolEvent: 1,
					_appendReasoning: 1
				};
				for (var key in message) {
					if (skipKeys[key]) continue;
					target[key] = message[key];
				}

				// 终态直接写入，避免 300ms 防抖窗口内刷新丢失最终状态
				if (message.loading === false) {
					this.upsert_message_to_store(target);
				} else {
					this.queue_upsert_message_to_store(target);
				}

				this.scheduleScrollToBottom({ immediate: true });
				return;
			} else {
				this.add_chat_message({
					...message,
					date: moment()
				});
			}
		},
		chunk_message_received(message) {
			var chunk = message.chunk;
			chunk.data = Base64.toUint8Array(chunk.data).buffer;

			var chat_message = _.findWhere(this.messages, { object_id: message.object_id });
			if (!chat_message) {
				throw new Error('主消息不存在');
			}
			if (!this.all_chunks[message.object_id]) {
				this.all_chunks[message.object_id] = [];
				chat_message.chunks_received = 0;
			}
			var chunks = this.all_chunks[message.object_id];

			chunks.push(chunk);
			chat_message.chunks_received += chunk.data.byteLength;

			if (chat_message.chunks_received == chat_message.file.size) {
				console.log('all chunk received');
				var parts = [];
				_.each(chunks, item_chunk => {
					parts.push(item_chunk.data);
				});
				var blob = new Blob(parts, { type: chat_message.file.type });
				this.set_message_object_url(chat_message, blob);
				chat_message.persisted_file_id = message.object_id;
				this.persist_file_blob(message.object_id, blob, chat_message.file)
					.then(() => this.upsert_message_to_store(chat_message))
					.catch(err => {
						console.warn('persist file and save message failed', err);
					});
				delete this.all_chunks[message.object_id];
			}
		},
		text_chunk_message_received(message) {
			var chat_message = _.findWhere(this.messages, { id: message.id });
			if (!chat_message) {
				this.add_chat_message({
					id: message.id,
					text: message.text_chunk || '',
					from: message.from || { name: 'agent', agent: true },
					loading: true,
					date: moment()
				});
				return;
			}
			chat_message.text = chat_message.text + message.text_chunk;
			this.queue_upsert_message_to_store(chat_message);
			this.scheduleScrollToBottom({ immediate: true });
		},
		send_file(file) {
			return Promise.resolve().then(() => {
				if (file.size === 0) {
					throw new Error('空文件');
				}
				var object_id = nanoid_tree_safe();
				this.send_message(
					{
						file: {
							name: file.name,
							size: file.size,
							type: file.type
						},
						object_id
					},
					{ file }
				);
			});
		},
		send_message(message, option) {
			message = {
				id: message.id || nanoid_hex(),
				...message
			};
			var peers_connected = _.filter(this.$refs.peer, com => {
				return com.state.connectionState == 'connected';
			});
			return Promise.resolve()
				.then(() => {
					this.add_chat_message({
						...message,
						from: this.profile,
						to: _.map(peers_connected, com => {
							return com.remoteProfile;
						}),
						...(message.file
							? {
									url: URL.createObjectURL(option.file),
									tracks: _.map(peers_connected, com => {
										return {
											remote_id: com.remoteId,
											profile: com.remoteProfile,
											chunks_send: 0
										};
									})
								}
							: undefined)
					});
				})
				.then(() => {
					if (option && option.file && message.object_id) {
						return this.persist_file_blob(message.object_id, option.file, message.file);
					}
				})
				.then(() => {
					return Promise.all(
						_.map(peers_connected, com => {
							return com.send_message(message).then(() => {
								if (option && option.file) {
									return com.send_file({ file: option.file, object_id: message.object_id });
								}
							});
						})
					);
				});
		},
		add_chat_message(message) {
			var isOwn = message.from && message.from.name === (this.profile && this.profile.name);
			var date = message.date ? moment(message.date) : moment();
			return Promise.resolve()
				.then(() => {
					var entry = { ...message, date };
					this.messages.push(entry);
					return this.upsert_message_to_store(entry);
				})
				.then(() => {
					this.scheduleScrollToBottom({ force: isOwn });
				})
				.then(() => {
					if (document.hasFocus()) {
						return;
					}
					if (message.from.name == this.profile.name) {
						return;
					}
					// 超过2人时，只有 @我 的消息才发通知
					if (this.items_member.length > 1 && message.text) {
						var my_name = this.profile.name;
						if (!message.text.includes(`@${my_name}`)) {
							return;
						}
					}
					return Notification.requestPermission().then(status => {
						if (status == 'granted') {
							var content = message.file ? message.file.name : message.text;
							var notification = new Notification(`${this.group}`, { icon: icon_logo, body: content });
							notification.onclick = event => {
								event.preventDefault();
								window.focus();
							};
						} else {
							alert('无通知权限');
						}
					});
				});
		},
		on_chunk_send({ remote_id, object_id, size }) {
			var chat_message = _.find(this.messages, message => {
				return message.object_id == object_id && _.findWhere(message.tracks, { remote_id });
			});
			if (!chat_message) {
				return;
			}
			var track = _.findWhere(chat_message.tracks, { remote_id });
			if (track) {
				track.chunks_send += size;
			}
		}
	}
};
