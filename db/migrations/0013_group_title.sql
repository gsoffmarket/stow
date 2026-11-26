-- The group's name as it was when it was connected, so the Telegram page can
-- say which group is connected. Older connections have none; Telegram does
-- not send it again until the next command from that group.
alter table telegram_connections add column chat_title text check (length(chat_title) between 1 and 128);
