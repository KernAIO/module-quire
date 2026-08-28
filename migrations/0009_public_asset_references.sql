-- Take the storage keys back out of the HTML that is already published.
--
-- 0.12.0 drew a published version's pictures as presigned storage URLs and stored the result, so
-- every published page carrying an image also carried `ws/<workspaceId>/<module>/<yyyy>/<mm>/
-- <fileId>/<name>` — the tenant's workspace uuid and a file uuid — to anyone on the internet, on the
-- one surface whose whole rule is that no response contains an id. The same URL is a presigned GET
-- with an hour on it, so the picture stopped loading sixty minutes after it was published.
--
-- The renderer writes `/__quire-asset/<fileId>` now and the read path resolves it per request. This
-- rewrites the rows that were drawn before that, in place, because a version's HTML is what the
-- walk requires to serve a page at all: nulling it would take every illustrated page off its
-- published site until somebody happened to publish it again.
--
-- The file id is recovered from the key rather than from a join, because it is in the key — that is
-- exactly the leak. Idempotent by its `where`: after the first run nothing carries a signature, and
-- a row that has already been rewritten cannot match the pattern again.

update mod_quire.page_versions
   set html = regexp_replace(
         html,
         'src="[^"]*/ws/[0-9a-fA-F-]{36}/[a-z0-9_]+/[0-9]{4}/[0-9]{2}/([0-9a-fA-F-]{36})/[^"]*"',
         'src="/__quire-asset/\1"',
         'g'
       )
 where html is not null
   and html like '%X-Amz-Signature%';
--> statement-breakpoint

-- Anything still holding a signature after that rewrite is a shape this pattern does not know, and
-- it must not go out either: drop the picture and leave the rest of the page. `publicHtml` refuses
-- the same thing on the way out, so this is the durable half of a fence that has two.
update mod_quire.page_versions
   set html = regexp_replace(html, '<img[^>]*X-Amz-Signature[^>]*>', '', 'g')
 where html is not null
   and html like '%X-Amz-Signature%';
