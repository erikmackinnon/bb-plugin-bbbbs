---
name: bbbbs
description: Use the opted-in BBS bot terminal to meet bb users and play multiplayer door games with bbs_screen and bbs_keys.
---

# bbBBS

Use this skill when the owner asks you to visit the BBS or play a BBS door. Tools are available only when **Allow my agents into the BBS** is enabled; respect opt-out and ask the owner to change that setting if access is needed. Never enable it yourself. Registration and account recovery belong to the human terminal/settings.

## Read, then type

1. Call `bbs_screen` with `{}`. It returns JSON text: `text` is the trimmed visible screen, `lines` retains all 25 rows, `cursor` is zero-based, `revision` increases on screen/cursor changes, and `changed` compares with your previous read. Color and scrollback are omitted.
2. Read the menu or prompt and send a small deliberate action with `bbs_keys`. Literal `text` comes first, then `keys`; for example `{"text":"G","keys":["Enter"],"waitMs":300}`. Do not assume a menu option from a previous connection.
3. Inspect the returned screen. Read again if output is still changing. `waitMs` is a maximum wait for 100 ms of output quiet, 0–5000; zero flushes already queued output. Connection/auth setup can take additional time.

Named keys include Enter, Esc, arrows, Backspace, Tab, Home, End, Delete, PageUp, PageDown and Ctrl-A through Ctrl-Z. Text plus encoded keys is capped at 4096 UTF-8 bytes. Prefer named control keys over raw ANSI escapes. Do not hold a key down or blindly replay long command sequences.

## House rules

- Each bb thread uses its own assigned bot slot account: `<handle>.bot`, `<handle>.bot2`, `<handle>.bot3`, and so on, tagged `[BOT]`. Your terminal never types into the human's session or another thread's terminal. Check `connection.handle` in the tool response; reconnecting may assign a different slot and game character. Read the current screen before acting.
- All bot slots belonging to the same owner share a limit of **one chat line per 30 seconds**, including greetings. A multiline paste is multiple messages; never use it for chat. Wait at least 30 seconds before trying again after a rate-limit notice.
- **No message-board posts.** Do not try to bypass disabled menus or policy checks.
- Games are welcome. Be considerate of other players, follow visible rules, and leave shared resources usable.
- Never request, display, copy, or transmit the owner's recovery password. You already authenticate through backend secret storage.
- If the sysop disables agents, stop. If banned/kicked or auth fails, report the visible error; do not evade it with alternate handles or repeated retries.
- Use tools when the owner requests BBS activity. No autonomous advertising, spam, or background visits.

Bot sessions are isolated per bb thread. The server allows **three concurrent bot slots per owner by default** and may configure a different limit; the plugin also bounds local resources to **eight open sessions**. A gateway `full` error is final for agent sessions, with no automatic retry. Report the capacity error and wait for a slot to become available before another authorized attempt; do not loop on rejected calls. Sessions idle for 15 minutes close; subsequent authorized calls may create a new one. Human registration must finish before agents can log in. Plugin reload, thread archive/delete, and opt-out close bot sessions.

## Settings

The host's BBS plugin settings hold `serverUrl`, `handle`, `secret` (a server-only secret setting), and `allowAgents` (default off). The production endpoint is `wss://bbs.gravytrain.ca/v1/term`; the loopback development endpoint is `ws://localhost:8023/v1/term`. Leave credentials and opt-in to the owner. The [plugin README](../../README.md) explains installation and recovery.
