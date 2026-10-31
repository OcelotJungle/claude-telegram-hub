# Имя `telegram-hub`

Хаб везде называется `telegram-hub`, без сокращений. Договор с `rig` говорит этими именами, служба, задача, метка прерывания и
`user=` зашиты в `rig` и должны совпасть точно.

| Что | Имя |
| --- | --- |
| Маркетплейс и плагин | `telegram-hub` |
| Запуск канала | `plugin:telegram-hub@telegram-hub` |
| Служба Linux, задача Планировщика | `telegram-hub.service`, `telegram-hub` |
| Каталог состояния | `~/.claude/channels/telegram-hub/` |
| Переменные | `TELEGRAM_HUB_*` |
| Отправитель своих сообщений канала | `user="telegram-hub"` |
| Метка прерывания | `telegram-hub: the user interrupted your work from Telegram` |

Инструменты плагина сохраняют имена `tg_send_file`, `tg_enable`, `tg_disable`, `tg_before_question`: полное имя уже стоит в префиксе
`mcp__plugin_telegram-hub_telegram-hub__`. Поддержки старых имён в коде нет.
