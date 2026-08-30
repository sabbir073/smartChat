# SmartChat — Files and contacts

Phase 7. Two features that arrive together because they answer the same question from opposite
ends: *who is this, and what have they sent us?*

---

## 1. The upload, step by step

```
  client                    API                     object store
    |  sign(name, size)      |                            |
    |----------------------->|  create row (pending)      |
    |                        |  build key from ids        |
    |  <-- signed PUT url ---|                            |
    |                                                     |
    |------------------ PUT the bytes -------------------->|
    |                                                     |
    |  confirm(attachmentId) |                            |
    |----------------------->|  GET the object ---------->|
    |                        |  read its first bytes      |
    |                        |  accept -> ready           |
    |                        |  refuse -> DELETE -------->|
    |  <--- message + file --|                            |
```

The third step is the one that matters. Everything the client said in step one — the name, the
size, the type — is a claim. None of it is stored. What is stored is what reading the object
produced.

### What the signed URL grants

One method. One key. A few minutes. No read, no listing, no second write anywhere else. It is safe
to hand to a visitor's browser on a customer's website because it gives that page no reach beyond
the single object we chose for it.

### What it does *not* enforce

Anything. The store will happily accept forty megabytes against a URL signed for a file the client
said was one. That is why the size is measured again from the real object at confirmation, and an
object over the limit is deleted rather than kept. See ADR-046.

---

## 2. What may be uploaded

Decided by reading the first bytes, never by the name or the `Content-Type` (ADR-044).

| Accepted | Recognised by |
| --- | --- |
| PNG, JPEG, GIF, BMP, WEBP | magic bytes (WEBP additionally by its RIFF form) |
| PDF | `%PDF-` |
| DOCX, XLSX, PPTX | ZIP magic, then the member names near the start |
| ZIP, GZIP | magic bytes |
| Legacy Office | OLE compound-file magic |
| CSV, JSON, plain text | no signature: nothing else matched and every byte is text |

Everything else is refused. An ELF or PE binary matches nothing. A PHP script named `photo.png` is
text, and is stored and served as `text/plain` — which nothing will execute on our behalf.

The recorded file name is forced to end in what the bytes really are, so a file can never be handed
back under a description that misrepresents it. Bidi override characters are stripped: they are how
`report<U+202E>gnp.exe` is made to read as `report.exe.png` in a file list.

---

## 3. Keys and names

```
a/{accountId}/{propertyId}/{attachmentId}
```

Three uuids this service generated, asserted as uuids by the builder, and nothing else — no
extension, and not one character from anything a client sent. There is no traversal to defend
against because nothing traversable ever reaches the key (ADR-045).

The original name survives only as a label and a download header, sanitised for display.

---

## 4. Reading a file back

`GET /attachments/:id/url` for an agent, `GET /widget/attachments/:id/url` for a visitor. Both
return a URL that lasts ten minutes and pins the content type and file name into its own signature,
so the store cannot be talked into serving the object as something else.

The URL is minted per request against the caller's own access, and is never stored in a transcript.
A saved link would be either a dead one or a live one that outlives the reader's permission.

An agent may read a file only from a conversation they can already see. A visitor may read one only
from a conversation that is theirs. Another account gets 404, not 403.

---

## 5. Contacts

A `Visitor` is one browser on one website. A `Contact` is the person, at account level, and the two
are joined the moment an email address appears — from the pre-chat form, the offline form, or a
`SmartChat('identify')` call.

The join happens in `VisitorRepository.identify`, the single function in the system that ever
writes an email onto a visitor. Doing it in the callers would mean three places to keep in step
(ADR-047).

`GET /contacts/:id/history` assembles every conversation and every file across all of that person's
browser identities. A restricted agent sees the whole person but only the parts of the history that
happened on websites they work on.

### Custom fields

What an account wants to record is configuration, not code: definitions live in
`contact_field_definitions`, and every value written to a contact is validated against them. A value
for a field that does not exist is dropped rather than stored, so the contact record cannot become a
place to park arbitrary data. A `select` value that is not one of its options is refused and said
so.

Removing a field is soft, and the values stay on the contacts. Deleting a column of somebody's CRM
because a field was renamed is not a recoverable mistake; reviving the key brings the data back.

---

## 6. Verifying it

```
pnpm e2e:files
```

55 checks against the running stack and the real object store: a round trip compared byte for byte,
a disguised executable refused *and removed from the bucket*, an understated size caught by
measuring the real object, cross-account and cross-visitor reads answering 404, and a contact
history assembled from two browsers that gave the same address in different casing.
