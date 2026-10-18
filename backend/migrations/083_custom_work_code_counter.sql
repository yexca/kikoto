-- Kikoto assigns a custom work code, KT followed by eight digits, to a local
-- folder the library holds as a work without a catalog code. The single row
-- records the highest number ever assigned, so a number is never assigned
-- twice, even after its work is deleted: listening history and personal data
-- exports name works by code.
CREATE TABLE custom_work_code_counter (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_number INTEGER NOT NULL CHECK(last_number >= 0)
);

INSERT INTO custom_work_code_counter (id, last_number) VALUES (1, 0);
