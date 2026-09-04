# Product images ERPNext → Medusa

**Deferred from:** Phase 3 (entity breadth)
**Belongs to:** a later phase, alongside the versioned default mappings
**Side:** both repos. This file is the Medusa half; `medusync/pending_work/`
holds the ERPNext half.

## What the brief asks for

"Products, variants and images flow ERPNext → Medusa by default." Phase 3
delivered the products and variants half through the mapping engine and the
catalogue guard. Images were not touched.

## Why images are not just another field

Every other mapped field is a value that fits in a JSON payload. An image is a
file in two places at once:

- ERPNext holds it as a `File` document, either public
  (`/files/x.jpg`) or private (`/private/files/x.jpg`), attached to the Item and
  possibly reachable only with a session.
- Medusa wants a URL its storefront can serve, or an upload through the file
  module into whatever provider the store is configured with (local, S3, …).

So the work is a transfer, not a mapping. Three questions decide the shape:

1. **Who fetches?** ERPNext pushing bytes to a Medusa upload endpoint, or Medusa
   pulling a URL ERPNext gives it. Pulling is simpler until the file is private,
   at which point Medusa needs a credential ERPNext would rather not hand out.
2. **What counts as changed?** Re-uploading every image on every Item save would
   be ruinous. A content hash on the ERPNext side, carried in the payload, is
   the cheap answer.
3. **Which image is which?** ERPNext has one `image` field on Item plus
   arbitrary attachments; Medusa has an ordered gallery with a thumbnail. The
   mapping has to say what the primary is and whether attachments follow.

## Where it would attach

- **Medusa side (this repo).** The `product` entity in `registry.ts` already
  handles create and update; images would be a step inside `upsertByKey`, or a
  separate handler for an `product.images.set` event. The file module is
  resolvable from the scope like any other.
- **ERPNext side (`medusync`).** A handler-pack hook on `File` (insert and
  trash, filtered to the catalogue DocType) is the obvious trigger, and it must
  respect `selection.is_allowed` and the per-store rules the way the rest of the
  outbound path does.

## Why it was left

Images are the one entity in the default mapping table whose delivery mechanism
is different in kind from everything else. Bolting a file transfer onto Phase 3
would have meant either a naive re-upload on every save or a half-built content
check, and the catalogue guard and multi-warehouse stock were the parts that
were actively wrong today.
