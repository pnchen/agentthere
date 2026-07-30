---
name: agentthere-guide
description: Use whenever an agent needs to operate AgentThere through its Group-scoped HTTP APIs, including media playback and conversation-session management. Trigger this skill for requests about playing, pausing, resuming, stopping, seeking, or checking media, and for requests to start a new chat, create a new conversation, open a fresh session, restart the conversation, clear or reset context, switch chats, load an earlier conversation, or continue another session—even when the user does not mention the HTTP API or the word “session.” Execute requested operations directly, verify their results, and present a concise user-oriented summary without exposing internal implementation details unless requested.
---

# AgentThere operations

Use `bash` and `curl` for AgentThere HTTP operations. Media control is HTTP-only: never use `play_media`, `stop_media`, or `media_status`.

## Operating mode

This is an execution skill, not a documentation skill:

- Perform the requested operation directly; do not merely explain how to do it.
- Keep commands, URLs, headers, endpoint names, identifiers, raw JSON, and internal state out of the user-facing reply unless the user explicitly asks for technical details.
- After success, summarize the user-visible result briefly and naturally.
- Do not narrate intermediate inspection, verification, or implementation details.
- Do not run unnecessary follow-up requests merely to expose internal state.
- On failure, give a concise user-facing explanation and the next useful action. Include technical response details only when requested or necessary to diagnose the failure.
- Do not claim success until the HTTP request returns a successful response.

Use the current environment values internally:

```bash
AGENTTHERE_URL=http://127.0.0.1:9001
GROUP_ID=<current-group-id>
GROUP_HEADER="X-AgentThere-Group-Id: $GROUP_ID"
```

Never guess `GROUP_ID`. If it is unavailable, ask the user for the Group ID instead of sending an unscoped request.

Every `/group/*` request requires the `X-AgentThere-Group-Id` header.

## Intent recognition

Treat these phrases as conversation-session operations:

- New conversation: “新聊天”, “新对话”, “开启新聊天”, “开始新的对话”, “重新开始”, “从头开始”, “清空上下文”, “忘掉之前的聊天”, “不要沿用当前对话”, “换个话题重新聊”, “new chat”, “new conversation”, “fresh start”, “start over”, “reset context”. Use the new-session operation.
- Existing conversation: “切换聊天”, “切换会话”, “打开之前的聊天”, “回到上次对话”, “继续那个会话”, “加载旧对话”, “switch chat”, “switch conversation”, “resume previous chat”. List sessions first, then use the selected session.
- Session inspection: “有哪些聊天”, “聊天记录”, “会话列表”, “查看历史会话”, “list chats”, “show conversations”, “available sessions”. List sessions and summarize them without exposing internal identifiers by default.

Do not interpret an ordinary request for a new user message, a new reply, or a new topic within the current conversation as a request to create a new session unless the user indicates that the conversation context should be reset or changed.

## Media playback

Base path: `/group/media-task`.

### Play

Send the source and optional loop setting in the JSON body:

```bash
curl -sS -X POST "$AGENTTHERE_URL/group/media-task/play" \
  -H "$GROUP_HEADER" \
  -H 'Content-Type: application/json' \
  -d '{"source":"/path/to/file.mp4","loop":false}'
```

Read and retain the returned `task_id` internally. Do not put the task ID in later request bodies.

### Control a task

Use the task ID as a URL path parameter:

```text
POST /group/media-task/:task_id/stop
POST /group/media-task/:task_id/pause
POST /group/media-task/:task_id/resume
POST /group/media-task/:task_id/seek
```

For seek, send only the position in the body:

```json
{"position":30}
```

These operations are asynchronous. Query status only when needed to determine the result:

```text
GET /group/media-task/status
GET /group/media-task/:task_id/status
```

Possible states include:

```text
created, starting, playing, paused, completed, failed, stopped
```

### Media response

After a successful request, use a brief confirmation such as “已开始播放” or “已暂停播放”. Do not mention ffmpeg, task IDs, HTTP, or the endpoint unless asked.

## Conversation sessions

Base path: `/group/session`.

Session metadata is internal. It may contain:

```json
{
  "schema_version": 1,
  "agent_name": "<agent>",
  "group_id": "<group>"
}
```

### List sessions

```text
GET /group/session
```

Use this when the user asks to inspect available conversations or before switching to a selected existing conversation. Use the returned session `id`; never use the filesystem `path`.

Normally summarize the result in natural language, without exposing identifiers, paths, metadata, or storage details unless asked.

### Start a new session

```text
POST /group/session/new
```

After a successful request, report the user-visible result accurately. If the service indicates that a change will take effect later, preserve that timing in the summary without exposing internal scheduling or implementation details.

### Switch to an existing session

```text
POST /group/session/:session_id/switch
```

List sessions first when the user identifies a conversation by name, time, or position. Use the selected returned `id` internally. Confirm briefly without exposing the ID or filesystem path.

## Safety and response rules

- Always send `X-AgentThere-Group-Id`.
- Do not guess the Group ID.
- Save the media `task_id` from `/play` before issuing controls.
- Put media task IDs in URLs, not request bodies.
- List sessions before switching to a selected existing session.
- Treat `/group/session/new` as successful when the request is accepted; do not promise that the current message was processed by the new session.
- Keep technical execution details private by default.
- `send_channel_file` remains a separate custom Pi tool for file sharing.
