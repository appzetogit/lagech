-- Pushes sent by the system (order updates, payouts...) are kept in the inbox too.
ALTER TYPE "NotificationSource" ADD VALUE IF NOT EXISTS 'SYSTEM';
