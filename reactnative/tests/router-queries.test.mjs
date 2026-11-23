import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  parseModels,
  RouterAuthenticationError,
} from "../src/providers/openrouter/metadata.ts";
import { createOpenRouterConnection } from "../src/connections/openrouter.ts";
import {
  discardUsage,
  modelCatalogQuery,
  routerUsageQuery,
  usagePresentation,
} from "../src/providers/openrouter/queries.ts";

const MOCK_CATALOG_RESPONSE = {
  data: [
    {
      id: "test/model",
      name: "Test",
      endpoints: ["/api/v1/chat/completions"],
      pricing: { prompt: "0", completion: "0" },
    },
  ],
};
const usage = (value) => ({
  data: { usage_daily: value, usage_monthly: value, limit_remaining: 5 },
});
const MOCK_FIRST_CREDENTIAL = {
  apiKey: "sk-or-1111111111111111",
  lifetime: 1,
  revision: 0,
};
const MOCK_SECOND_CREDENTIAL = {
  apiKey: "sk-or-2222222222222222",
  lifetime: 1,
  revision: 1,
};
const reply = (data) => ({ ok: true, json: async () => data });

test("catalog loads from disk, refreshes explicitly, and retains data if refresh fails", async () => {
  const client = new QueryClient();
  let reads = 0,
    requests = 0,
    writes = 0;
  const options = modelCatalogQuery(
    {
      read: async () => {
        reads++;
        return parseModels(MOCK_CATALOG_RESPONSE);
      },
      write: async () => {
        writes++;
      },
    },
    async () => {
      requests++;
      if (requests > 1) throw new Error("offline");
      return reply(MOCK_CATALOG_RESPONSE);
    },
  );
  try {
    const first = await client.fetchQuery(options);
    assert.equal(first[0].id, "test/model");
    await client.fetchQuery(options);
    assert.equal(reads, 1);
    assert.equal(requests, 0);
    await client.invalidateQueries({ queryKey: options.queryKey });
    await client.fetchQuery(options);
    assert.equal(requests, 1);
    assert.equal(writes, 1);
    await client.invalidateQueries({ queryKey: options.queryKey });
    await assert.rejects(client.fetchQuery(options), /offline/);
    assert.deepEqual(client.getQueryData(options.queryKey), first);
  } finally {
    client.clear();
  }
});

test("spending remains cached during refresh and failed refresh; different keys stay isolated", async () => {
  const client = new QueryClient();
  let fail = false;
  const options = routerUsageQuery(MOCK_FIRST_CREDENTIAL, async (url) => {
    if (fail) throw new Error("offline");
    return url.endsWith("/credits")
      ? { ok: false, status: 403 }
      : reply(usage(1));
  });
  const observer = new QueryObserver(client, options);
  const states = [];
  const unsubscribe = observer.subscribe((state) => states.push(state));
  try {
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data.daily, 1);
    fail = true;
    await observer.refetch();
    assert.ok(
      states.some((state) => state.isFetching && state.data?.daily === 1),
    );
    assert.equal(observer.getCurrentResult().data.daily, 1);
    assert.equal(observer.getCurrentResult().isError, true);
    observer.setOptions(
      routerUsageQuery(MOCK_SECOND_CREDENTIAL, async () => reply(usage(2))),
    );
    assert.equal(observer.getCurrentResult().data, undefined);
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data.daily, 2);
    assert.equal(client.getQueryData(options.queryKey).daily, 1);
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});

test("spending stays idle while disconnected and never puts the key in its cache key", async () => {
  const client = new QueryClient();
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return reply(usage(1));
  };
  const observer = new QueryObserver(client, routerUsageQuery(null, fetcher));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observer.getCurrentResult().fetchStatus, "idle");
    assert.equal(requests, 0);
    observer.setOptions(routerUsageQuery(MOCK_FIRST_CREDENTIAL, fetcher));
    await observer.refetch();
    assert.equal(requests, 2);
    assert.equal(observer.getCurrentResult().data.daily, 1);
    for (const query of client.getQueryCache().getAll())
      assert.equal(JSON.stringify(query.queryKey).includes("sk-or-"), false);
    observer.setOptions(routerUsageQuery(null, fetcher));
    assert.equal(observer.getCurrentResult().data, undefined);
    assert.equal(observer.getCurrentResult().fetchStatus, "idle");
    assert.equal(requests, 2);
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});

test("authentication failure overrides cached stats; network failure preserves them", async () => {
  const client = new QueryClient();
  let status = 200;
  const options = routerUsageQuery(MOCK_FIRST_CREDENTIAL, async (url) =>
    url.endsWith("/credits")
      ? { ok: false, status: 403 }
      : status === 200
        ? reply(usage(1))
        : { ok: false, status },
  );
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  const presentation = () => {
    const q = observer.getCurrentResult();
    return usagePresentation(true, q.data, q.error);
  };
  try {
    await observer.refetch();
    assert.equal(presentation().state, "ready");
    status = 503;
    await observer.refetch();
    assert.equal(presentation().state, "ready");
    assert.equal(presentation().usage.daily, 1);
    for (const rejected of [401, 403]) {
      status = rejected;
      await observer.refetch();
      assert.ok(
        observer.getCurrentResult().error instanceof RouterAuthenticationError,
      );
      assert.equal(presentation().state, "invalid");
      assert.equal(presentation().usage, null);
    }
    status = 200;
    await observer.refetch();
    assert.equal(presentation().state, "ready");
    assert.equal(presentation().usage.daily, 1);
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});

test("a recreated connection owner never sees usage cached for an earlier key", async () => {
  const client = new QueryClient();
  let saved = MOCK_FIRST_CREDENTIAL.apiKey;
  const secure = {
    get: async () => saved,
    set: async (_, value) => {
      saved = value;
    },
  };
  const owners = [];
  const requests = [];
  const fetcher = async (url, init) => {
    const key = init.headers.Authorization.slice(-4);
    requests.push(key);
    return reply(usage(key === "1111" ? 1 : 2));
  };
  const observe = async (owner) => {
    const observer = new QueryObserver(
      client,
      routerUsageQuery(owner.capture(), fetcher),
    );
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const daily = observer.getCurrentResult().data?.daily;
    unsubscribe();
    observer.destroy();
    return daily;
  };
  try {
    owners.push(createOpenRouterConnection(secure));
    await owners[0].read();
    assert.equal(await observe(owners[0]), 1);
    await owners[0].save(MOCK_SECOND_CREDENTIAL.apiKey);
    discardUsage(client, owners[0].lifetime, 1);
    assert.equal(client.getQueryCache().getAll().length, 0);
    // A new scope reads the replacement key and starts again at revision 0.
    owners.push(createOpenRouterConnection(secure));
    await owners[1].read();
    assert.equal(owners[1].capture().revision, 0);
    assert.equal(await observe(owners[1]), 2);
    assert.deepEqual(requests, ["1111", "1111", "2222", "2222"]);
    discardUsage(client, owners[1].lifetime, null);
    assert.equal(client.getQueryCache().getAll().length, 0);
  } finally {
    client.clear();
  }
});
