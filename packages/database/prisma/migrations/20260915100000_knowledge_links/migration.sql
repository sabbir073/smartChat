-- Pages the owner adds by pasting a URL.
--
-- A kind of their own rather than reusing `page`, because the two are cleaned up by opposite
-- rules: a crawled page is removed the moment a later crawl of the site no longer finds it, and
-- one of these must survive exactly that - it is often a page on somebody else's website, and
-- always one the owner chose by hand.
ALTER TYPE "KnowledgeDocumentKind" ADD VALUE IF NOT EXISTS 'link';
