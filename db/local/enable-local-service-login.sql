-- LOCAL DEVELOPMENT ONLY. Never run this on a real (cloud) database.
-- Lets the backend and the tests connect as the restricted role, with a
-- well-known local password. On production the database owner sets a strong
-- password by hand and stores it only in the host's settings (Render).
ALTER ROLE soft_ai_service LOGIN PASSWORD 'local-dev-only';
