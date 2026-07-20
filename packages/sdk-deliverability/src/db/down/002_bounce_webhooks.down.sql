-- Rollback for 002_bounce_webhooks.sql (sdk-deliverability, P14·E3 / TK-3625). Not auto-applied.
DROP TABLE IF EXISTS deliverability.bounce_event;
DROP TABLE IF EXISTS deliverability.webhook_secret;
