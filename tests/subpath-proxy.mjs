// Local-only test proxy for the same prefix stripping and WS upgrade as Caddy.
import http from 'node:http';
const target = new URL(process.env.BARKODD_PROXY_TARGET || 'http://127.0.0.1:8088');
const port = Number(process.env.BARKODD_PROXY_PORT || 8089);
const prefix = '/barkodd';
const options = request => ({ hostname: target.hostname, port: target.port, path: request.url.slice(prefix.length), method: request.method, headers: request.headers });
const proxy = http.createServer((request, response) => {
  if (request.url === prefix) { response.writeHead(308, { Location: prefix + '/' }); response.end(); return; }
  if (!request.url.startsWith(prefix + '/')) { response.writeHead(404); response.end(); return; }
  const upstream = http.request(options(request), result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
});
proxy.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith(prefix + '/')) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const upstream = http.request(options(request));
  upstream.on('upgrade', (response, remote, remoteHead) => {
    let headers = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
    for (let i = 0; i < response.rawHeaders.length; i += 2) headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
    socket.write(headers + '\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
  });
  upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});
proxy.listen(port, '127.0.0.1', () => console.log(`Prefix proxy: http://127.0.0.1:${port}${prefix}/`));
