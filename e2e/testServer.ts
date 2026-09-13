import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TestServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

export async function createTestServer(): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/iframe-host') {
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Iframe Host</title>
</head>
<body>
  <h1>Iframe Host Page</h1>
  <div id="content-bridge" data-ready="false"></div>
  <div id="content-result" data-status="idle"></div>
  <iframe id="test-child-iframe" src="/iframe-child" style="width:300px;height:200px;"></iframe>
</body>
</html>`);
      return;
    }
    if (req.url === '/iframe-child') {
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Iframe Child</title>
</head>
<body>
  <h1>Child Iframe Document</h1>
  <div id="content-bridge" data-ready="false"></div>
  <div id="content-result" data-status="idle"></div>
</body>
</html>`);
      return;
    }
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Test Host: ${req.url}</title>
</head>
<body>
  <h1>Test Host Page</h1>
  <div id="content-bridge" data-ready="false"></div>
  <div id="content-result" data-status="idle"></div>
</body>
</html>`);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
