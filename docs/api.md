# CODBConvert Fetch API

The CODBConvert API is a Fetch-compatible handler. It accepts a standard
`Request` and returns a standard `Response`; it does not open a port, upload a
document, or require an application server.

```ts
import { createCODBApi } from "@codb/core/api";
import { CODBDocs } from "@codb/core";
import { register as registerPdf } from "@codb/pdf";
import { register as registerImage } from "@codb/image";
import { register as registerOffice } from "@codb/office";

registerPdf();
registerImage();
registerOffice();

const api = createCODBApi(new CODBDocs());
```

## Immediate conversion

```ts
const request = new Request("https://codb.local/v1/convert?to=pdf", {
  method: "POST",
  headers: {
    "Content-Type": file.type,
    "X-CODB-Filename": file.name,
    "X-CODB-Size": String(file.size),
  },
  body: file,
});

const response = await api.fetch(request);
if (!response.ok) throw new Error(await response.text());
const output = await response.blob();
```

Supported query options are `to`, `from`, `quality`, `width`, `height`,
`scale`, `searchable`, `accessibility`, `optimize`, `storage`, `checkpoint`,
`verify`, `chunkSize`, `concurrency`, and `memoryBudgetMB`.

## Queued conversion

```ts
const created = await api.fetch(new Request(
  "https://codb.local/v1/jobs?to=pdf",
  { method: "POST", body: file },
));
const job = await created.json();

const result = await api.fetch(new Request(
  `https://codb.local${job.links.result}?wait=true`,
));
```

Without `wait=true`, an unfinished result responds with `202 Accepted` and a
`Retry-After` header. Completed binary responses include `X-CODB-Job-Id`,
`X-CODB-Backend`, and `X-CODB-Verified` headers.

The job-creation response is returned after its request body has been staged.
Checkpoint resume applies to reusable `File`, `Blob`, and buffer inputs; a live
HTTP request body is a one-use stream and must be sent again after interruption.

## Service Worker mount

Register converters inside a module Service Worker, construct the API once,
then forward only the chosen local route prefix:

```ts
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/__codb/v1/")) {
    event.respondWith(api.fetch(event.request));
  }
});
```

Create the API with `{ basePath: "/__codb" }` for this example. Application
code can then use ordinary same-origin `fetch("/__codb/v1/convert?to=pdf")`
while conversion remains inside the browser.

Use immediate `/v1/convert` requests in a Service Worker so `respondWith()`
keeps the worker alive through completion. Queued jobs are best hosted in a
page, dedicated worker, Shared Worker, or persistent HTTP runtime because a
browser may stop an idle Service Worker after the job-creation response.

## Hosted mount

An HTTP framework adapter only needs to translate its incoming request into a
Web `Request` and return the resulting Web `Response`. Set `maxInputBytes` when
the API is reachable over a network, and provide authentication, rate limiting,
CORS, and logging in the host layer. CODBConvert intentionally does not invent
security policy for the surrounding application.
