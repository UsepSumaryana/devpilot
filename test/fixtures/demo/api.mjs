import http from 'node:http';
const port = Number(process.env.PORT || 4510);
let n = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/boom') { console.error(new TypeError('Cannot read properties of undefined (reading \'id\')').stack); res.writeHead(500); return res.end(); }
  res.end(`hello ${++n} greeting=${process.env.GREETING}`);
}).listen(port, 'localhost', () => console.log(`api listening on http://localhost:${port}`));
