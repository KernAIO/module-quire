-- Column and view order are fractional indexes, and they only sort the way the algorithm intended
-- under byte comparison.
--
-- `pages.position` was declared `COLLATE "C"` in 0000 for exactly this reason; `properties.position`
-- and `views.position` were not, so on any database with a language-aware default collation
-- (en_US.UTF-8, which is what this project runs) `ORDER BY position` reorders them by letter and
-- ignores case. The keys the algorithm mints are 'V', 'k', 's' — so a database's second view sorted
-- in front of its first, and moving a column put it somewhere nobody asked for. Nothing failed:
-- the rows came back, in the wrong order.
--
-- Backward compatible: the column keeps its type and its data, and an older image reading it sees
-- the same strings. Only the comparison changes.
ALTER TABLE "mod_quire"."properties" ALTER COLUMN "position" TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "mod_quire"."views" ALTER COLUMN "position" TYPE text COLLATE "C";
