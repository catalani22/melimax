import { spawn } from 'node:child_process';
import './env.js';
import app from './app.js';

const PORT = process.env.K_SERVICE ? 3000 : Number(process.env.PORT) || 3000;

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend rodando em http://0.0.0.0:${PORT}`);
    if (process.argv.includes('--build-bg')) {
      const child = spawn('npm', ['run', 'build', '--workspace=ml-dropshipping-frontend'], {
        stdio: 'inherit',
        shell: true,
      });
      child.on('error', () => {});
    }
  });
}

export default app;
