<!-- WHEN_TO_READ: Adding or renaming a step of the chat agent's status line (`CHAT_ACTIVITY_STEPS`), giving a tool its step, or drawing a new status mark in iOS. -->

# 2026-11-19 — chat statuses for a video, the chat history and memory

The founder asked the agent's status line to say more than «Думаю…» and «Смотрю фото…». He wanted «смотрю видео» when a person sends a TikTok, Reels or YouTube link, and «ищу в истории диалогов» and «вспоминаю» next to the web search. The marks were approved on the page https://claude.ai/artifact/CJ39LHqTcgT8D3NjoeUHBC with one change: the video mark has no progress bar, only the screen and the play triangle.

1. **New keys.** `watching_video` and `remembering` join `CHAT_ACTIVITY_STEPS`. `past_chats` keeps its key; its copy changes from «Вспоминаю…» to «Ищу в истории диалогов…», and «Вспоминаю…» moves to `remembering`.
2. **The video step comes from the read, not from a tool.** A shared link is read before the first model call, inside `videoTakeBlocks`. The step is reported right before that read, and only when the link is in this turn's message. A link from one of the two earlier messages is a follow-up: its read is a cache hit, so it gets no status. The status stays on while the first model call takes the video in. A photo in the same message wins with `reading_photo`.
3. **Memory reads are `remembering`.** These are `find_ideas`, `idea_questions`, `planning_ideas`, `idea_deletion_scope`, `list_preferences` and `similar_places`. Memory writes answer at once and stay on `thinking`, as does `skip_idea_question`. The chat-memory session's recall tool takes `remembering` when it lands. The activity test now runs with the memory tools on, so a memory tool without a step fails it.
4. **No general «Ищу…».** Every search already has its own step: the web, screenshots, the chat history and memory. A general step would say less than any of them.
5. **Matching gets its own mark.** In iOS, `matching` was drawn with the profile silhouette. It now has two circles drawing together. The copy is unchanged.
6. **Only real work.** A status lives only inside a turn the person started and names the tool that is actually running. Nothing outside a turn, no push and no reminder comes from a status. This is principle 5 of the agent concept.
7. **Surfaces.** The Mini App has no agent chat, so nothing changes there. Telegram keeps the system «печатает…»: its other chat actions would say the agent is sending something. `/v1/chat/voice` is left as it is, the exception from the 2026-11-01 decision. Older iOS builds show an unknown key as «Думаю…».
8. **Demo mode.** The statuses are the same as in normal mode: they label real steps and gate nothing.
