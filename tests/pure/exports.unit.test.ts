import { test, expect } from '@playwright/test';
import {
  Responder,
  Requester,
  RuntimeRequester,
  ContentScriptRequester,
} from '../../dist/index.mjs';
import { methodProxy, broadcastMethodProxy } from '../../src/proxy';

test.describe('Pure TypeScript tests (no browser fixtures)', () => {
  test('dist artifact exports expected public classes', () => {
    expect(typeof Responder).toBe('function');
    expect(typeof Requester).toBe('function');
    expect(typeof RuntimeRequester).toBe('function');
    expect(typeof ContentScriptRequester).toBe('function');
  });

  test('methodProxy forwards method calls with arguments to handler', async () => {
    type TestMethods = {
      compute: (a: number, b: number) => number;
      format: (label: string) => string;
    };

    const recorded: Array<{ method: string; args: unknown[] }> = [];

    const implementations: {
      compute: (a: number, b: number) => number;
      format: (label: string) => string;
    } = {
      compute: (a, b) => a * b,
      format: (label) => `[${label}]`,
    };

    const proxy = methodProxy<TestMethods>(async <Name extends keyof TestMethods>(
      method: Name,
      ...args: Parameters<TestMethods[Name]>
    ): Promise<Awaited<ReturnType<TestMethods[Name]>>> => {
      recorded.push({ method, args });
      if (method === 'compute') {
        const [a, b] = args as Parameters<TestMethods['compute']>;
        return implementations.compute(a, b) as Awaited<ReturnType<TestMethods[typeof method]>>;
      }
      if (method === 'format') {
        const [label] = args as Parameters<TestMethods['format']>;
        return implementations.format(label) as Awaited<ReturnType<TestMethods[typeof method]>>;
      }
      throw new Error(`Unhandled method: ${String(method)}`);
    });

    const product = await proxy.compute(6, 7);
    expect(product).toBe(42);

    const formatted = await proxy.format('test-key');
    expect(formatted).toBe('[test-key]');

    expect(recorded).toEqual([
      { method: 'compute', args: [6, 7] },
      { method: 'format', args: ['test-key'] },
    ]);
  });

  test('broadcastMethodProxy forwards calls and collects tab responses', async () => {
    type BroadcastMethods = {
      notify: (event: string) => boolean;
    };

    const recorded: Array<{ method: string; args: unknown[] }> = [];

    const proxy = broadcastMethodProxy<BroadcastMethods>(async (method, ...args) => {
      recorded.push({ method, args });
      const [event] = args as Parameters<BroadcastMethods['notify']>;
      return [
        {
          tabId: 1,
          response: Boolean(event) as Awaited<ReturnType<BroadcastMethods[typeof method]>>,
        },
        {
          tabId: 2,
          response: Boolean(event) as Awaited<ReturnType<BroadcastMethods[typeof method]>>,
        },
      ];
    });

    const responses = await proxy.notify('reload');
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({ tabId: 1, response: true });
    expect(responses[1]).toEqual({ tabId: 2, response: true });
    expect(recorded).toEqual([{ method: 'notify', args: ['reload'] }]);
  });
});
