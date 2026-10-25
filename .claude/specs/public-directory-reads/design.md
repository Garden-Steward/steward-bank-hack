# Public directory reads

The public Gardens, Projects, Events and Blog lists and published Blog detail load without role seeds. Each response is built from an explicit nested allowlist. Signed-in calls get the same public shape. Private core CRUD, legacy Blog fullSlug and event by-id routes retain their existing contracts.

## API contract

Five GET routes use `auth:false`: `/api/volunteer-days/public`, `/api/public/gardens`, `/api/public/projects`, `/api/public/blogs`, and `/api/public/blogs/:slug`. Lists accept only `pagination[page]` and `pagination[pageSize]`. Defaults are 1/24, or 1/15 for Events. PageSize is 1–100 and maximum offset 100000. Duplicate, malformed, nested or unknown query input returns 400. The existing event feed ignores old populate hints for backend-first compatibility. Detail takes no query parameters. Hidden/malformed/missing Blog detail is 404. Unexpected failures use the framework's generic 500 response.

Lists return `{data,meta:{pagination:{page,pageSize,pageCount,total}}}`. Valid out-of-range pages return empty data with accurate totals. Blog detail is flat. Tests specify exact nested key sets. Media includes only URL, alt text, dimensions and four individually projected named formats. Author includes only explicit firstName/lastName/profilePhoto. Rich blocks are rebuilt using the installed renderer's grammar, safe URLs and projected embedded media. No user contact details, raw media metadata, draft content, garden templates, boundaries or exact coordinates appear.

Published domains use Document Service with `status:'published'`. Projects have no draft/publish; only APPROVED/COMPLETED projects qualify. Linked unpublished gardens exclude their projects/events. Events remain Public, not canceled/disabled, within the existing 90-day lower bound. Garden cards compute active project count and earliest eligible upcoming workday on the server. Volunteer/interested relations preserve the existing id-only policy. Garden coordinates are centers of fixed 0.01-degree cells and carry `location_approximate:true`.

Blog neighbors use stable chronological identities. Random excludes current and both neighbors and chooses once from a finite candidate count. No retry loop or article-body corpus scan. The public frontend separately collects bounded pages before its global filters and earliest-event display.

## Ownership and validation

Thin domain controllers call their public service. The existing event controller delegates only its public feed action. `src/utils/public-media.js` handles media projection; a small public-input parser validates HTTP query syntax. Domain services own visibility and their output fields. No generic query engine or blanket permission grant is introduced.

Targeted SQLite route tests use synthetic published/draft data, restrictive Public permissions, sentinel private values, pagination edges, related publication and 0–4 Blog sets. Unit checks cover malicious format/block fields and unsafe URL syntax. Then run the full backend test suite. No schema changes, migration, real SMS/email or production access are needed. Backend routes ship before paired frontend callers. Rollback removes only these routes/callers; no data backfill occurs.

Rich-block normalization lives in the Blog-local `utils/public-blocks.js`. It preserves the installed grammar and bounds recursive list nesting to 32 levels. Coordinates whose computed grid center lies outside geographic bounds return the absent-location pair. The legacy raw draft-relation fixture is explicit because ordinary Strapi publication drops an unpublished relation from the published row.
