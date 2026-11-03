# The name `telegram-hub`

The hub is called `telegram-hub` everywhere, with no abbreviations. The contract with `rig` uses these names: the service,
the task, the interrupt label and `user=` are hard-coded in `rig` and must match exactly.

| What | Name |
| --- | --- |
| Marketplace and plugin | `telegram-hub` |
| Channel launch | `plugin:telegram-hub@telegram-hub` |
| Linux service, Task Scheduler task | `telegram-hub.service`, `telegram-hub` |
| State directory | `~/.claude/channels/telegram-hub/` |
| Variables | `TELEGRAM_HUB_*` |
| Sender of the channel's own messages | `user="telegram-hub"` |
| Interrupt label | `telegram-hub: the user interrupted your work from Telegram` |

The plugin tools keep the names `tg_send_file`, `tg_enable`, `tg_disable`, `tg_before_question`: the full name is already in the prefix
`mcp__plugin_telegram-hub_telegram-hub__`. The code has no support for the old names.
