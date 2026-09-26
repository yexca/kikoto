-- user_session.id now stores the SHA-256 of a session token instead of the
-- token itself, so a copied database or backup cannot be replayed as a
-- sign-in. Existing rows hold plaintext tokens that can no longer match a
-- lookup; delete them rather than keep usable credentials at rest. Every
-- browser and app signs in again once.

DELETE FROM user_session;
