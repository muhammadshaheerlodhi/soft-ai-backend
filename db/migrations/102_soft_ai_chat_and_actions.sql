-- =====================================================================
-- Soft AI - 102: chat history and action log
--
--   conversations  one row per chat (shown in the chat list on the left)
--   messages       every message in a chat, with model, tokens and credits
--   actions        every action Soft AI proposed or ran, with its result
--                  and the data needed to undo it
--
-- Integrity: a message or action must belong to a conversation of the SAME
-- organization and the SAME user (composite foreign keys), so data from two
-- organizations can never be mixed, even by a bug in our code.
--
-- Deleting a chat is a soft delete (deleted_at). How long deleted and old
-- chats are kept is an open question for Shaheer (retention policy).
--
-- Safe to re-run.
-- =====================================================================

-- ---------- conversations ----------

CREATE TABLE IF NOT EXISTS soft_ai.conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT 'New chat' CHECK (length(title) <= 200),
  is_pinned        BOOLEAN NOT NULL DEFAULT false,
  archived_at      TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  message_count    INTEGER NOT NULL DEFAULT 0,
  credits_used     NUMERIC(18,4) NOT NULL DEFAULT 0,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id, user_id)          -- target for composite FKs
);

-- The chat list query: "my chats in this organization, newest first".
CREATE INDEX IF NOT EXISTS idx_conversations_user_list
  ON soft_ai.conversations (organization_id, user_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_conversations_touch ON soft_ai.conversations;
CREATE TRIGGER trg_conversations_touch BEFORE UPDATE ON soft_ai.conversations
  FOR EACH ROW EXECUTE FUNCTION soft_ai.touch_updated_at();

-- ---------- messages ----------

CREATE TABLE IF NOT EXISTS soft_ai.messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL,
  organization_id  UUID NOT NULL,
  user_id          UUID NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content          TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 100000),
  status           TEXT NOT NULL DEFAULT 'complete'
                   CHECK (status IN ('streaming', 'complete', 'stopped', 'error')),
  error_code       TEXT,
  model            TEXT,                         -- null for rules/cache answers
  answered_by      TEXT CHECK (answered_by IN ('rules', 'cache', 'model')),
  input_tokens     INTEGER CHECK (input_tokens >= 0),
  output_tokens    INTEGER CHECK (output_tokens >= 0),
  credits_charged  NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  latency_ms       INTEGER CHECK (latency_ms >= 0),
  page_context     JSONB NOT NULL DEFAULT '{}',  -- which ERP page the user was on
  tool_calls       JSONB NOT NULL DEFAULT '[]',  -- what the model asked to do
  sources          JSONB NOT NULL DEFAULT '[]',  -- knowledge pages used for the answer
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, organization_id, user_id)
    REFERENCES soft_ai.conversations (id, organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON soft_ai.messages (conversation_id, created_at);
-- For usage reports in the admin panel.
CREATE INDEX IF NOT EXISTS idx_messages_org_created
  ON soft_ai.messages (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_messages_touch ON soft_ai.messages;
CREATE TRIGGER trg_messages_touch BEFORE UPDATE ON soft_ai.messages
  FOR EACH ROW EXECUTE FUNCTION soft_ai.touch_updated_at();

-- Keep the chat list fields (count, credits, last activity) correct.
CREATE OR REPLACE FUNCTION soft_ai.messages_update_conversation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE soft_ai.conversations
       SET message_count   = message_count + 1,
           credits_used    = credits_used + NEW.credits_charged,
           last_message_at = NEW.created_at
     WHERE id = NEW.conversation_id;
  ELSIF NEW.credits_charged <> OLD.credits_charged THEN
    UPDATE soft_ai.conversations
       SET credits_used = credits_used + (NEW.credits_charged - OLD.credits_charged)
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_update_conversation ON soft_ai.messages;
CREATE TRIGGER trg_messages_update_conversation AFTER INSERT OR UPDATE OF credits_charged
  ON soft_ai.messages FOR EACH ROW EXECUTE FUNCTION soft_ai.messages_update_conversation();

-- ---------- actions ----------

CREATE TABLE IF NOT EXISTS soft_ai.actions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        UUID NOT NULL,
  organization_id        UUID NOT NULL,
  user_id                UUID NOT NULL,
  message_id             UUID REFERENCES soft_ai.messages(id) ON DELETE SET NULL,
  action_name            TEXT NOT NULL,            -- registry name, e.g. create_invoice
  registry_version       TEXT,                     -- which registry release defined it
  params                 JSONB NOT NULL DEFAULT '{}',
  risk_level             TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  confirmation_required  BOOLEAN NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                           'proposed', 'confirmed', 'executed', 'failed',
                           'cancelled', 'expired', 'undone')),
  result                 JSONB,                    -- record ids created / changed
  undo_data              JSONB,                    -- what is needed to reverse it
  undo_until             TIMESTAMPTZ,              -- undo button disappears after this
  error_message          TEXT,
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  confirmed_at           TIMESTAMPTZ,
  executed_at            TIMESTAMPTZ,
  undone_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, organization_id, user_id)
    REFERENCES soft_ai.conversations (id, organization_id, user_id) ON DELETE CASCADE,
  -- High risk actions always need confirmation.
  CHECK (risk_level <> 'high' OR confirmation_required)
);

CREATE INDEX IF NOT EXISTS idx_actions_conversation ON soft_ai.actions (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_org_created  ON soft_ai.actions (organization_id, created_at DESC);

-- Only allowed status changes, so an action can never run without the
-- confirmation it needs, and a finished action can never be "re-opened".
CREATE OR REPLACE FUNCTION soft_ai.actions_check_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = soft_ai, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  NEW.updated_at := now();

  -- These never change after creation.
  IF NEW.action_name <> OLD.action_name OR NEW.params <> OLD.params
     OR NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id
     OR NEW.risk_level <> OLD.risk_level
     OR NEW.confirmation_required <> OLD.confirmation_required THEN
    RAISE EXCEPTION 'action details cannot be changed after it is proposed';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  ok := CASE OLD.status
    WHEN 'proposed'  THEN NEW.status IN ('confirmed', 'cancelled', 'expired')
                          OR (NEW.status IN ('executed', 'failed') AND NOT OLD.confirmation_required)
    WHEN 'confirmed' THEN NEW.status IN ('executed', 'failed', 'expired')
    WHEN 'executed'  THEN NEW.status = 'undone'
    ELSE false
  END;

  IF NOT ok THEN
    RAISE EXCEPTION 'invalid action status change: % -> %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'confirmed' AND now() > OLD.expires_at THEN
    RAISE EXCEPTION 'action expired, please ask again';
  END IF;
  IF NEW.status = 'undone' AND (OLD.undo_until IS NULL OR now() > OLD.undo_until) THEN
    RAISE EXCEPTION 'this action can no longer be undone';
  END IF;

  IF NEW.status = 'confirmed' THEN NEW.confirmed_at := now(); END IF;
  IF NEW.status IN ('executed', 'failed') THEN NEW.executed_at := now(); END IF;
  IF NEW.status = 'undone' THEN NEW.undone_at := now(); END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actions_transition ON soft_ai.actions;
CREATE TRIGGER trg_actions_transition BEFORE UPDATE ON soft_ai.actions
  FOR EACH ROW EXECUTE FUNCTION soft_ai.actions_check_transition();

-- ---------- permissions ----------

ALTER TABLE soft_ai.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE soft_ai.actions       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_all ON soft_ai.conversations;
CREATE POLICY service_all ON soft_ai.conversations FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.messages;
CREATE POLICY service_all ON soft_ai.messages      FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_all ON soft_ai.actions;
CREATE POLICY service_all ON soft_ai.actions       FOR ALL TO soft_ai_service USING (true) WITH CHECK (true);

REVOKE ALL ON soft_ai.conversations, soft_ai.messages, soft_ai.actions FROM PUBLIC, anon, authenticated;
-- No DELETE for the backend: chats are soft-deleted; purging is a separate,
-- reviewed job once the retention policy is agreed.
GRANT SELECT, INSERT, UPDATE ON soft_ai.conversations, soft_ai.messages, soft_ai.actions
  TO soft_ai_service;
