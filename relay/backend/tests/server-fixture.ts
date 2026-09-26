import { startServer } from '../server/index.js';

const server = await startServer(0);
const printReady = () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`READY:${address.port}`);
};
if (server.listening) printReady();
else server.on('listening', printReady);
