-- Who on the desk owns a support thread.
--
-- Every admin shares the participant token "ADMIN", which is right for
-- addressing -- support is one destination, not five people -- but it leaves a
-- desk with no way to divide the work or to see that someone is already on it.
ALTER TABLE "food_chat_conversations"
  ADD COLUMN "assignedAdminId" VARCHAR(24),
  ADD COLUMN "assignedAt" TIMESTAMP(3);

-- The inbox filters on it, and an unassigned thread is the common query.
CREATE INDEX "food_chat_conversations_assignedAdminId_idx"
  ON "food_chat_conversations" ("assignedAdminId");
