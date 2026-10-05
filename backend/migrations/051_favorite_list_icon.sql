-- A user list may show a chosen icon in Favorites. The value is a short
-- presentation key that the client maps to its own icon set; an empty key, or
-- one the client does not know, keeps the default list icon. The system marked
-- list keeps a fixed icon and never stores one.

ALTER TABLE favorite_list ADD COLUMN icon TEXT NOT NULL DEFAULT '';
