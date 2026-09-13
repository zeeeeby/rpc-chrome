export type UserData = {
  id: string;
  name: string;
  role: string;
  preferences: {
    theme: string;
    notifications: boolean;
  };
};

export type BackgroundMethods = {
  ping: () => { pong: boolean; timestamp: number };
  getUser: (id: string) => UserData;
  echo: (payload: { message: string; count: number }) => { received: { message: string; count: number }; sender: string };
  failingMethod: (shouldFail: boolean) => string;
  callTabFromBg: (tabId: number, text: string) => Promise<{ echo: string; tabUrl: string }>;
  callAllTabsFromBg: (text: string) => Promise<Array<{ tabId: number; response: { echo: string; tabUrl: string } }>>;
  testNamedTarget: () => { source: string; version: number };
  addOverrideHandler: () => { registered: boolean };
  removeOverrideHandler: () => { unregistered: boolean };
  testUniversalTarget: (x: number, y: number) => { sum: number; source: string };
  addUniversalOverride: () => { registered: boolean };
  removeUniversalOverride: () => { unregistered: boolean };

  // Task 3 & 4: Opt-in Large Payload & Seam Methods
  echoLargeJson: (payload: unknown) => Promise<unknown>;
  echoBlob: (payload: { label: string; blob: Blob }) => Promise<{ label: string; blob: Blob; size: number }>;
  nestedBlobRoundtrip: (payload: { title: string; files: Array<{ name: string; content: Blob }> }) => Promise<{
    title: string;
    files: Array<{ name: string; content: Blob }>;
    count: number;
  }>;
  returnUndefined: () => Promise<undefined>;
  callTabLargeFromBg: (tabId: number, text: string) => Promise<{ echo: string; tabUrl: string }>;
  callAllTabsLargeFromBg: (text: string) => Promise<Array<{ tabId: number; response: { echo: string; tabUrl: string } }>>;
  getInvocationCount: (method: string) => Promise<number>;
  setMethodDelay: (method: string, delayMs: number) => Promise<{ ok: boolean }>;

  // Acceptance Scenarios (Task 4)
  verifyLargePayload: (payload: { text: string; expectedLength: number }) => Promise<{
    length: number;
    head: string;
    tail: string;
    verified: boolean;
  }>;
  generateLargePayload: (sizeMb: number) => Promise<{
    length: number;
    text: string;
  }>;
  putMedia: (payload: { id: string; blob: Blob; tags: string[] }) => Promise<{ success: boolean; id: string }>;
  getMedia: (id: string) => Promise<{ id: string; blob: Blob; tags: string[] } | null>;
  delayedEffectMethod: (id: string, delayMs: number) => Promise<{ executed: boolean }>;
  getExpiryStats: () => Promise<{ totalSessions: number; totalAccountedBytes: number }>;
  callTabSlowFromBg: (tabId: number, text: string, delayMs: number) => Promise<{ echo: string }>;
};

export type TabMethods = {
  pingTab: () => { fromTab: boolean; title: string; href: string };
  echoTab: (text: string) => { echo: string; tabUrl: string };
  tabFailingMethod: () => never;

  // Task 3 & 4: Tab Large Payload Methods
  echoLargeJsonTab: (payload: unknown) => Promise<unknown>;
  echoBlobTab: (payload: { label: string; blob: Blob }) => Promise<{ label: string; blob: Blob }>;
  slowTabEcho: (text: string, delayMs: number) => Promise<{ echo: string }>;
};

export type PageMethods = {
  pingPage: () => { fromPage: boolean };
};
