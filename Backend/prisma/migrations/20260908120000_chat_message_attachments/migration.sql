-- Attachments on a chat message.
--
-- A support conversation is mostly about something the person can photograph:
-- the wrong dish, a damaged bag, a receipt. Text alone made them describe it.
--
-- `text` loses its NOT NULL-with-no-default footing at the same time: a photo
-- with no caption is an ordinary message, and the send path rejected an empty
-- string outright, so an image on its own was impossible to express.
ALTER TABLE "food_chat_messages"
  ALTER COLUMN "text" SET DEFAULT '';

ALTER TABLE "food_chat_messages"
  ADD COLUMN "attachments" JSONB[] NOT NULL DEFAULT ARRAY[]::JSONB[];
