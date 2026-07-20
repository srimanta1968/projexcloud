-- Rollback for 003_reply_sync.sql (sdk-deliverability, P14·E3 / TK-3626). Not auto-applied.
DROP TABLE IF EXISTS deliverability.reply_event;
DROP TABLE IF EXISTS deliverability.mailbox;
