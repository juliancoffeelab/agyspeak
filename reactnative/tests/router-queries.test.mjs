import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { parseModels, RouterAuthenticationError } from '../src/chat/routerMetadata.ts';
import { modelCatalogQuery, routerUsageQuery, usagePresentation } from '../src/chat/routerQueries.ts';

const catalog = { data: [{ id: 'test/model', name: 'Test', pricing: { prompt: '0', completion: '0' } }] };
const usage = value => ({ data: { usage_daily: value, usage_monthly: value, limit_remaining: 5 } });
const reply = data => ({ ok: true, json: async () => data });

test('catalog loads from disk, refreshes explicitly, and retains data if refresh fails', async () => {
  const client = new QueryClient();
  let reads = 0, requests = 0, writes = 0;
  const options = modelCatalogQuery({ read: async () => { reads++; return parseModels(catalog); }, write: async () => { writes++; } }, async () => {
    requests++;
    if (requests > 1) throw new Error('offline');
    return reply(catalog);
  });
  try {
    const first = await client.fetchQuery(options);
    assert.equal(first[0].id, 'test/model');
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
  } finally { client.clear(); }
});

test('spending remains cached during refresh and failed refresh; different keys stay isolated', async () => {
  const client = new QueryClient();
  let fail = false;
  const options = routerUsageQuery('sk-or-1111111111111111', async url => {
    if (fail) throw new Error('offline');
    return url.endsWith('/credits') ? { ok: false, status: 403 } : reply(usage(1));
  });
  const observer = new QueryObserver(client, options);
  const states = [];
  const unsubscribe = observer.subscribe(state => states.push(state));
  try {
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data.daily, 1);
    fail = true;
    await observer.refetch();
    assert.ok(states.some(state => state.isFetching && state.data?.daily === 1));
    assert.equal(observer.getCurrentResult().data.daily, 1);
    assert.equal(observer.getCurrentResult().isError, true);
    observer.setOptions(routerUsageQuery('sk-or-2222222222222222', async () => reply(usage(2))));
    assert.equal(observer.getCurrentResult().data, undefined);
    await observer.refetch();
    assert.equal(observer.getCurrentResult().data.daily, 2);
    assert.equal(client.getQueryData(options.queryKey).daily, 1);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});


test('spending ignores empty or malformed saved keys; a valid saved key enables checks', async () => {
  const client = new QueryClient();
  let requests = 0;
  const fetcher = async () => { requests++; return reply(usage(1)); };
  const observer = new QueryObserver(client, routerUsageQuery(null, fetcher));
  const unsubscribe = observer.subscribe(() => {});
  try {
    for (const input of [null, '', ' ', 'not-a-key']) {
      observer.setOptions(routerUsageQuery(input, fetcher));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(observer.getCurrentResult().fetchStatus, 'idle');
    }
    assert.equal(requests, 0);
    observer.setOptions(routerUsageQuery('sk-or-1111111111111111', fetcher));
    await observer.refetch();
    assert.equal(requests, 2);
    assert.equal(observer.getCurrentResult().data.daily, 1);
    observer.setOptions(routerUsageQuery(null, fetcher));
    assert.equal(observer.getCurrentResult().data, undefined);
    assert.equal(observer.getCurrentResult().fetchStatus, 'idle');
    assert.equal(requests, 2);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});


test('authentication failure overrides cached stats; network failure preserves them', async () => {
  const client = new QueryClient();
  let status = 200;
  const input = 'sk-or-1111111111111111';
  const options = routerUsageQuery(input, async url => url.endsWith('/credits') ? { ok: false, status: 403 }
    : status === 200 ? reply(usage(1)) : { ok: false, status });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  const presentation = () => { const q = observer.getCurrentResult(); return usagePresentation(input, true, q.data, q.error); };
  try {
    await observer.refetch();
    assert.equal(presentation().state, 'ready');
    status = 503;
    await observer.refetch();
    assert.equal(presentation().state, 'ready');
    assert.equal(presentation().usage.daily, 1);
    for (const rejected of [401, 403]) {
      status = rejected;
      await observer.refetch();
      assert.ok(observer.getCurrentResult().error instanceof RouterAuthenticationError);
      assert.equal(presentation().state, 'invalid');
      assert.equal(presentation().usage, null);
    }
    status = 200;
    await observer.refetch();
    assert.equal(presentation().state, 'ready');
    assert.equal(presentation().usage.daily, 1);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});
