# SmartChat — Knowledge base

The help centre has two audiences with almost nothing in common, and the whole design follows from
keeping them apart.

An **author** is a member of an account. They work through `TenantContext`, they can see drafts,
and everything they touch is checked against their permissions and their property scope.

A **reader** is a stranger. No session, no cookie, no identity of any kind. They arrive with a
property's public id — the same identifier that appears in every customer's page source, which
authorises nothing — and they can only ever be shown rows whose status is `published`.

Those are two different code paths on purpose: `kbRoutes` and `publicKbRoutes` are registered in
separate Fastify scopes, and the public one has *no* authentication hook at all. Not a hook that
usually passes. None. A route that must be readable by anybody should not be one forgotten
`preHandler` away from being writable by anybody.

---

## The model

```
KbCategory  (account_id, property_id, slug unique per property, position)
KbArticle   (account_id, property_id, category_id?, slug unique per property,
             title, excerpt?, body, status, published_at?, view_count, author_member_id?)
```

Both are tenant-scoped with the usual composite key, both are soft-deleted, and both belong to a
**property** rather than to the account. A help centre is the public face of one website; an
account with three websites has three help centres, and an agent restricted to one of them can
neither read nor write the others.

`title` and `body` carry trigram GIN indexes, so a substring search stays an index scan rather than
a sequential read of every article in the table.

### Statuses

`draft` and `published`. There is no third state, because every third state anybody proposes
("scheduled", "archived", "internal") is a feature with its own rules, and inventing the column
before the rules exist just produces rows nobody can explain later.

---

## Addresses

An article's slug is part of a public URL. Two consequences:

**It is suggested, never imposed.** `slugifyTitle` runs only when the author did not write one.
Retitling a published article does not move it — somebody has already shared the old link, and
silently breaking their link to tidy up ours is not a trade worth making. The editor makes this
visible: the address field follows the title until you touch it, and stops following it for good
once the article has been saved.

**It is unique per property, among rows that are not deleted.** A clash is a `DUPLICATE_SLUG`
error with a sentence an author can act on, not a database constraint violation surfacing as a 500.

---

## Publication dates do not move

`published_at` is when an article *first* became public, and re-publishing after an edit leaves it
alone:

```ts
if (input.status === 'published' && existing.status !== 'published') {
  data['publishedAt'] = existing.publishedAt ?? now;
}
```

A reader looking at "published in March" on an article that was corrected in August is being told
something true. Rewriting the date to August would be a small lie, and a help centre accumulates
those until nobody trusts any date on it. The last edit is already recorded separately in
`updated_at`, and the article page shows both when they differ.

---

## Removing a section keeps the writing

Deleting a category nulls `category_id` on its articles inside the same transaction and soft-deletes
the category. The articles stay published and stay reachable at their own addresses; they simply
stop belonging to a section.

Deleting a folder should not delete the writing in it. That is the kind of mistake nobody expects
to be unrecoverable, and the confirmation dialog says exactly what will happen and how many
published articles will survive it.

---

## What a stranger can see

The public shapes are built by hand rather than serialised from the model:

```
{ slug, title, excerpt, body, category: { slug, name } | null, publishedAt, updatedAt }
```

No id, no author, no view counter, no account or property id. There is nothing internal in there to
leak even by accident, and the e2e suite asserts the exact key set rather than "the fields we
remembered to check", so adding a field to the model cannot quietly add it to the public response.

**A draft answers exactly as a missing article does** — the same 404, the same error code. If a
draft returned a distinguishable response, the address of an unpublished article could be probed
for existence, and the title of an unannounced feature is often the announcement.

**A paused website closes its help centre.** The public lookup goes through the same
`findPublishedByPublicId` the widget uses, which requires an active property on an active account.
Pausing a website should stop everything it serves, not most of it.

**Views are counted for readers only.** The counter is incremented in `publicArticle` and nowhere
else, so an author refreshing their own article does not inflate it. The increment is deliberately
non-fatal: a failed counter update must never take down the article a person came to read.

---

## Search

`GET /public/kb/:publicId/search?q=&category=&limit=`

Substring matching over title, excerpt and body, restricted to published rows of that one property.
A query shorter than two characters is refused rather than answered — that request is a table scan
dressed as a search.

Results are ordered newest-first by the database, then reordered in memory so that title matches
come before body-only matches: a title match is what somebody meant, a body match is what they
might have meant. The reordering applies to the page the database returned, not to the whole
corpus, which only matters for a help centre with more than fifty matches for one word.

---

## Article bodies are text, not markup

Bodies are markdown, stored **exactly as written**. Nothing is stripped or rewritten on the way in
— the same rule a chat message follows, and for the same reason: the record of what somebody wrote
stays intact, and the decision about what a browser is allowed to do with it belongs at render
time, where the escaping is.

That render step is `apps/web/src/lib/markdown.ts`, and the order inside it is the entire security
argument:

1. every character of the author's text is HTML-escaped;
2. only then are our own tags inserted around the escaped text.

By the time any tag exists in the output, the author's angle brackets are already entities. A
script tag in an article body is text. An `onerror=` is text. A stray closing tag is text. There is
no allow-list of tags to get wrong, because no author-supplied tag ever exists in the first place.

Link targets are the one place author input reaches an attribute, so they go through an allow-list
— `http:`, `https:`, `mailto:`, or a relative path — rather than a `javascript:` block-list. A
block-list loses to a leading tab, to mixed case, and to an entity in the middle of the word; an
allow-list does not, because none of those start with `https`. A rejected link renders as the
literal text the author typed, which is visible and fixable rather than silent.

The renderer is unit-tested with the attacks, not just the happy path, and the e2e suite fetches
the real rendered page and asserts that a hostile article arrives as text.

---

## The public pages

`/help/:publicId` and `/help/:publicId/:slug` in the web app, rendered **on the server**.

The dashboard talks to the API from the browser because every request there carries the reader's
session. The help centre has no reader identity at all, so there is nothing to carry, and
server-rendering buys three things worth having: the page arrives complete, it works with
JavaScript switched off, and a search engine can read it — which is most of the point of publishing
help articles.

Search on the public page is a plain `GET` form. The results are a URL somebody can bookmark or
send to a colleague, and no client component is involved.

`INTERNAL_API_URL` exists because of this: the server renders inside the network, where `localhost`
is the web container rather than the API. It falls back to the browser-facing `API_URL` so
`next dev` on a laptop keeps working.

---

## Endpoints

**Authenticated** (`kb:view` to read, `kb:manage` to write; all property-scoped):

```
GET    /api/v1/kb/:propertyId/categories
POST   /api/v1/kb/:propertyId/categories
PATCH  /api/v1/kb/categories/:id
DELETE /api/v1/kb/categories/:id
GET    /api/v1/kb/:propertyId/articles?status=&categoryId=&search=&limit=
POST   /api/v1/kb/:propertyId/articles
GET    /api/v1/kb/articles/:id
PATCH  /api/v1/kb/articles/:id
DELETE /api/v1/kb/articles/:id
```

**Public** (no authentication, rate-limited on the widget bucket, cacheable):

```
GET /api/v1/public/kb/:publicId
GET /api/v1/public/kb/:publicId/search?q=&category=&limit=
GET /api/v1/public/kb/:publicId/articles/:slug
```

Owners, administrators and managers can write. Agents can read — an agent needs to find an article
to send a visitor, and does not need to be the person who edits the manual.

---

## Verifying it

```
node scripts/e2e-kb.mjs
```

Requires the stack up and the web app running, since it fetches the real rendered help-centre page
to check the escaping end to end.
