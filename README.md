## Usage

```ts
import { Agent, fetch, interceptors, setGlobalDispatcher } from "undici";
import { PgCacheStore } from "undici-pg-cache-store";

const agent = new Agent().compose(interceptors.cache({
    // accepts all the same options as pg.Pool
    store: new PgCacheStore({ connectionString: "postgres://user:password@hostname:5432/databasename" }),
}));

// to use the cache for all requests
setGlobalDispatcher(agent);
// to use the cache for one request
const response = await fetch("https://api.github.com", { dispatcher: agent });
const body = await response.json();
```
