import { config } from './config.js';
import { bucket } from './storage.js';
import { start } from './app.js';

const { server, shareCount } = await start();
const { port } = server.address();

console.log(`API       http://localhost:${port}/api`);
console.log(`PeerJS    http://localhost:${port}${config.peerPath}`);
console.log(`MinIO     ${config.minio.endPoint}:${config.minio.port} (bucket "${bucket}", ${shareCount} shares)`);
